// What each leg actually DOES once the SOL lands in the executor.
//
// pump.fun pays "wallet" and "creator" legs directly — those need no help.
// Every other leg is an action, and this is where the action happens.
//
// Every handler is dry-run capable: with dryRun the plan is computed and
// returned but nothing is signed or sent. That is how the flow is tested
// without spending SOL.

import crypto from "node:crypto";
import {
  b58encode, b58decode, isOnCurve, makeRpc, buildMessage, signTransaction, sign,
  transferSol, burnTokens, associatedTokenAddress, compactU16,
  setComputeUnitPrice, TOKEN_PROGRAM,
} from "./executor.mjs";

const LAMPORTS = 1_000_000_000;
// Leave enough behind to pay fees and rent for the accounts we touch.
export const FEE_RESERVE = 2_000_000;   // 0.002 SOL
const DUST = 5_000;              // don't emit a transfer smaller than this
const MAX_PER_TX = 18;           // transfers per transaction

export const ACTION_KINDS = new Set([
  "burn", "buyback", "holders", "jackpot", "topholders", "top-holders", "reserve",
]);
export const PASSIVE_KINDS = new Set(["wallet", "creator"]);

/* --------------------------- holder discovery --------------------------- */
// An SPL token account is 165 bytes: mint(32) owner(32) amount(u64 LE) ...
// Accounts that are pools/curves rather than people are excluded, otherwise
// "holder rewards" would pay most of the SOL straight back to the AMM.

export async function fetchHolders(rpc, mint, { exclude = [], allowPartial = true } = {}) {
  const skip = new Set(exclude.filter(Boolean));
  const holders = [];
  let source = null;

  // 1. DAS getTokenAccounts. This is the only method that reliably returns the
  //    FULL holder set: Helius and most paid RPCs disable getProgramAccounts on
  //    the token program and answer with an empty array instead of an error,
  //    which is indistinguishable from "this coin has no holders". Note DAS
  //    takes a bare params object, not the usual array.
  try {
    for (let page = 1; page <= 50; page++) {
      const r = await rpc("getTokenAccounts", {
        mint, limit: 1000, page, options: { showZeroBalance: false },
      });
      const list = (r && r.token_accounts) || [];
      for (const a of list) push(a.owner, BigInt(a.amount));
      source = "das:getTokenAccounts";
      if (list.length < 1000) break;
    }
  } catch { /* endpoint has no DAS - fall through */ }

  // 2. getProgramAccounts. Works on self-hosted / full-archive nodes.
  if (!holders.length) {
    let res = [];
    try {
      res = await rpc("getProgramAccounts", [
        TOKEN_PROGRAM,
        { encoding: "base64", filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }] },
      ]);
    } catch { res = []; }
    if (res.length) {
      source = "getProgramAccounts";
      for (const { account } of res) {
        const data = Buffer.from(account.data[0], "base64");
        push(b58encode(data.subarray(32, 64)), data.readBigUInt64LE(64));
      }
    }
  }

  // Fallback: top 20 accounts. Works on every RPC, but it is NOT the full
  // holder set — the caller is told so via `partial`.
  if (!holders.length) {
    source = "getTokenLargestAccounts";
    const largest = await rpc("getTokenLargestAccounts", [mint]);
    const addrs = (largest.value || []).map((a) => a.address);
    if (addrs.length) {
      const infos = await rpc("getMultipleAccounts", [addrs, { encoding: "base64" }]);
      for (const acc of infos.value || []) {
        if (!acc) continue;
        const data = Buffer.from(acc.data[0], "base64");
        if (data.length < 72) continue;
        push(b58encode(data.subarray(32, 64)), data.readBigUInt64LE(64));
      }
    }
  }

  holders.sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
  holders.partial = source !== "getProgramAccounts";
  holders.source = source;
  if (holders.partial && !allowPartial) {
    throw new Error("only a partial holder set is available from this RPC");
  }
  return holders;

  function push(owner, amount) {
    if (amount === 0n || skip.has(owner)) return;
    // Bonding curves, AMM pools and vaults are program-derived addresses, not
    // people. Paying them would send rewards straight back into the pool.
    if (!isOnCurve(b58decode(owner))) return;
    holders.push({ owner, amount });
  }
}

function require_b58(buf) {
  // Local import avoids a cycle at module scope.
  return b58encodeLocal(buf);
}
let _b58;
function b58encodeLocal(buf) {
  if (!_b58) _b58 = (await_import_sync());
  return _b58(buf);
}
function await_import_sync() {
  // executor.mjs is already loaded by the time this runs.
  return globalThis.__hl_b58;
}

/* ---------------------------- share splitting -------------------------- */
// Integer lamports, largest-remainder so the parts sum EXACTLY to the total.

export function splitProRata(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0n);
  // No weights to divide by, but the money still has to go somewhere: split it
  // evenly rather than silently returning zeros and stranding the balance.
  if (sum === 0n) {
    if (!weights.length) return [];
    const even = weights.map(() => BigInt(total) / BigInt(weights.length));
    let rest = BigInt(total) - even.reduce((a, b) => a + b, 0n);
    for (let i = 0; rest > 0n; i++, rest--) even[i] += 1n;
    return even;
  }
  const base = weights.map((w) => (BigInt(total) * w) / sum);
  let used = base.reduce((a, b) => a + b, 0n);
  let rest = BigInt(total) - used;
  // Hand the remainder to the largest weights first.
  const order = weights.map((w, i) => [w, i]).sort((a, b) => (b[0] > a[0] ? 1 : -1));
  for (const [, i] of order) {
    if (rest <= 0n) break;
    base[i] += 1n; rest -= 1n;
  }
  return base;
}

/* ------------------------------- pump buy ------------------------------ */
// PumpPortal builds the swap; we sign it. Works for the bonding curve and
// for pumpswap after graduation, which is why we don't hand-roll it.

export async function buildPumpBuy({ mint, buyer, solAmount, slippage = 15, pool = "auto" }) {
  const r = await fetch("https://pumpportal.fun/api/trade-local", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      publicKey: buyer, action: "buy", mint,
      amount: solAmount, denominatedInSol: "true",
      slippage, priorityFee: 0.00001, pool,
    }),
  });
  if (!r.ok) throw new Error(`pumpportal ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return Buffer.from(await r.arrayBuffer());
}

/** Replace the signature slots of a builder-returned transaction with ours. */
export function signPrebuilt(txBytes, keypair) {
  // Leading compact-u16 = signature count, then count*64 bytes, then message.
  let n = 0, shift = 0, i = 0;
  for (;;) {
    const b = txBytes[i++];
    n |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  const msgStart = i + n * 64;
  const message = txBytes.subarray(msgStart);
  const sig = sign(keypair, message);
  const out = Buffer.from(txBytes);
  sig.copy(out, i); // builder puts the fee payer's slot first
  return out;
}

/* ------------------------------ send helper ---------------------------- */

export async function sendAndConfirm(rpc, txBase64, { dryRun }) {
  if (dryRun) {
    const sim = await rpc("simulateTransaction", [
      txBase64, { encoding: "base64", commitment: "processed", sigVerify: false },
    ]);
    return { simulated: true, err: sim.value.err, logs: sim.value.logs };
  }
  const sig = await rpc("sendTransaction", [
    txBase64, { encoding: "base64", skipPreflight: false, maxRetries: 3 },
  ]);
  return { signature: sig };
}

/* -------------------------------- actions ------------------------------ */

async function payMany(ctx, recipients, note) {
  const { rpc, keeper, dryRun } = ctx;
  const out = [];
  for (let i = 0; i < recipients.length; i += MAX_PER_TX) {
    const batch = recipients.slice(i, i + MAX_PER_TX);
    const { blockhash } = (await rpc("getLatestBlockhash", [{ commitment: "finalized" }])).value;
    const built = buildMessage({
      feePayer: keeper.address,
      recentBlockhash: blockhash,
      instructions: [
        setComputeUnitPrice(1000),
        ...batch.map((r) => transferSol({
          from: keeper.address, to: r.owner, lamports: r.lamports,
        })),
      ],
    });
    const tx = signTransaction(built, [keeper]);
    const res = await sendAndConfirm(rpc, tx.toString("base64"), { dryRun });
    out.push({ note, count: batch.length, ...res });
  }
  return out;
}

/** Buy the coin with the SOL, then destroy what we bought. */
async function actBurn(ctx, lamports) {
  const { rpc, keeper, mint, dryRun } = ctx;
  const sol = Number(lamports) / LAMPORTS;
  const ata = associatedTokenAddress(keeper.address, mint);
  // Read the bag BEFORE buying: a buyback or reserve leg on the same coin is
  // holding tokens on purpose, and burning the whole account would destroy
  // them. Only what this buy adds may be burned.
  const held = await rpc("getTokenAccountBalance", [ata])
    .then((b) => BigInt(b.value.amount)).catch(() => 0n);

  const buy = await buildPumpBuy({ mint, buyer: keeper.address, solAmount: sol });
  const signed = signPrebuilt(buy, keeper);
  const bought = await sendAndConfirm(rpc, signed.toString("base64"), { dryRun });
  if (dryRun) return [{ note: "buy (simulated)", ...bought }];

  const after = await rpc("getTokenAccountBalance", [ata])
    .then((b) => BigInt(b.value.amount)).catch(() => 0n);
  const amount = after > held ? after - held : 0n;
  if (amount === 0n) return [{ note: "buy", ...bought }, { note: "burn", skipped: "no tokens" }];
  const { blockhash } = (await rpc("getLatestBlockhash", [{ commitment: "finalized" }])).value;
  const built = buildMessage({
    feePayer: keeper.address,
    recentBlockhash: blockhash,
    instructions: [burnTokens({ account: ata, mint, owner: keeper.address, amount })],
  });
  const burned = await sendAndConfirm(rpc, signTransaction(built, [keeper]).toString("base64"), { dryRun });
  return [{ note: "buy", ...bought }, { note: `burn ${amount}`, ...burned }];
}

/** Buy and keep — the executor holds the bag for this mint. */
async function actHold(ctx, lamports, note) {
  const { rpc, keeper, mint, dryRun } = ctx;
  const buy = await buildPumpBuy({ mint, buyer: keeper.address, solAmount: Number(lamports) / LAMPORTS });
  const res = await sendAndConfirm(rpc, signPrebuilt(buy, keeper).toString("base64"), { dryRun });
  return [{ note, ...res }];
}

/** Pay SOL to every holder, in proportion to how much they hold. */
async function actHolders(ctx, lamports, { top = 0 } = {}) {
  const { rpc, mint, keeper, creator } = ctx;
  let holders = await fetchHolders(rpc, mint, { exclude: [keeper.address] });
  if (!holders.length) return [{ note: "holders", skipped: "no holders found" }];
  if (top > 0) holders = holders.slice(0, top);
  const parts = splitProRata(lamports, holders.map((h) => h.amount));
  const recipients = holders
    .map((h, i) => ({ owner: h.owner, lamports: parts[i] }))
    .filter((r) => r.lamports >= BigInt(DUST));
  if (!recipients.length) return [{ note: "holders", skipped: "all shares below dust" }];
  return payMany(ctx, recipients, top ? `top ${top} holders` : "holders");
}

/** One holder takes it all, odds proportional to holdings. */
async function actJackpot(ctx, lamports) {
  const { rpc, mint, keeper } = ctx;
  const holders = await fetchHolders(rpc, mint, { exclude: [keeper.address] });
  if (!holders.length) return [{ note: "jackpot", skipped: "no holders found" }];
  const total = holders.reduce((a, h) => a + h.amount, 0n);
  // Uniform draw over total supply held, so weight == odds.
  const buf = (await import("node:crypto")).randomBytes(16);
  let roll = BigInt("0x" + buf.toString("hex")) % total;
  let winner = holders[0];
  for (const h of holders) {
    if (roll < h.amount) { winner = h; break; }
    roll -= h.amount;
  }
  return payMany(ctx, [{ owner: winner.owner, lamports: BigInt(lamports) }], `jackpot -> ${winner.owner}`);
}

/* ------------------------------ orchestrator --------------------------- */

/**
 * Run one cycle for a mint: take the executor's spendable balance, divide it
 * across that mint's action legs by bps, and perform each one.
 */
export async function runCycle({ rpcUrl, keeper, mint, legs, creator, dryRun = true, balanceOverride, budget }) {
  const rpc = makeRpc(rpcUrl);
  const ctx = { rpc, keeper, mint, creator, dryRun };

  const balance = balanceOverride != null
    ? BigInt(balanceOverride)
    : BigInt((await rpc("getBalance", [keeper.address, { commitment: "confirmed" }])).value);
  // `budget` is what THIS mint's own claim paid the executor. One wallet holds
  // every coin's money, so without it a coin with no fees would happily spend a
  // coin that earned some. Still clamped by the wallet, which must keep enough
  // behind to pay for the transactions the legs are about to send.
  const headroom = balance > BigInt(FEE_RESERVE) ? balance - BigInt(FEE_RESERVE) : 0n;
  const spendable = budget != null
    ? (BigInt(budget) < headroom ? BigInt(budget) : headroom)
    : headroom;

  const actionLegs = legs.filter((l) => ACTION_KINDS.has(l.kind));
  const actionBps = actionLegs.reduce((a, l) => a + l.bps, 0);
  const report = {
    mint, balance: balance.toString(), spendable: spendable.toString(),
    dryRun, actionBps, legs: [],
  };
  if (spendable === 0n || !actionLegs.length) {
    report.skipped = spendable === 0n ? "nothing spendable" : "no action legs";
    return report;
  }

  // Divide the spendable balance across action legs by their share of the
  // action total (passive legs were already paid directly by pump.fun).
  const parts = splitProRata(spendable, actionLegs.map((l) => BigInt(l.bps)));

  for (const [i, leg] of actionLegs.entries()) {
    const lamports = parts[i];
    const entry = { kind: leg.kind, bps: leg.bps, lamports: lamports.toString() };
    if (lamports < BigInt(DUST)) { entry.skipped = "below dust"; report.legs.push(entry); continue; }
    try {
      switch (leg.kind) {
        case "burn": entry.results = await actBurn(ctx, lamports); break;
        case "buyback": entry.results = await actHold(ctx, lamports, "buyback"); break;
        case "reserve": entry.results = await actHold(ctx, lamports, "reserve"); break;
        case "holders": entry.results = await actHolders(ctx, lamports); break;
        case "topholders":
        case "top-holders":
          entry.results = await actHolders(ctx, lamports, { top: leg.count || 50 }); break;
        case "jackpot": entry.results = await actJackpot(ctx, lamports); break;
        default: entry.skipped = "unknown action";
      }
    } catch (e) {
      entry.error = e.message;
    }
    report.legs.push(entry);
  }
  return report;
}

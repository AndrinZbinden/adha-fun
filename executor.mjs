// Executor keeper — the wallet that makes action legs real.
//
// pump.fun fee sharing can only pay a WALLET. It cannot call a program. So a
// leg like "burn" or "holder rewards" has no address of its own: the share is
// paid to this executor, which then performs the action on chain.
//
// Zero npm dependencies, on purpose: node:crypto speaks ed25519, which is all
// Solana signing needs. Everything below is raw wire format.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/* ------------------------------- base58 -------------------------------- */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAP = new Map([...ALPHABET].map((c, i) => [c, BigInt(i)]));

export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = "1" + out; else break; }
  return out || "1";
}

export function b58decode(str) {
  let n = 0n;
  for (const c of str) {
    const v = MAP.get(c);
    if (v === undefined) throw new Error("bad base58 char: " + c);
    n = n * 58n + v;
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of str) { if (c === "1") bytes.unshift(0); else break; }
  return Buffer.from(bytes);
}

/* ------------------------------ keypair -------------------------------- */
// A 32-byte seed is the whole secret. node:crypto wraps it in PKCS8 to import.

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function keypairFromSeed(seed) {
  if (seed.length !== 32) throw new Error("seed must be 32 bytes");
  const priv = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8",
  });
  const pub = crypto.createPublicKey(priv);
  const spki = pub.export({ format: "der", type: "spki" });
  const pubkey = spki.subarray(spki.length - 32);
  return { seed, priv, pubkey, address: b58encode(pubkey) };
}

export function publicKeyFromBytes(bytes) {
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, Buffer.from(bytes)]), format: "der", type: "spki",
  });
}

export const sign = (kp, msg) => crypto.sign(null, msg, kp.priv);
export const verify = (pubkeyBytes, msg, sig) =>
  crypto.verify(null, msg, publicKeyFromBytes(pubkeyBytes), sig);

// Solana CLI / Phantom export format: 64 bytes = seed || pubkey, as a JSON array.
export function keypairFromSecretKey(secret) {
  const buf = Buffer.from(secret);
  if (buf.length === 64) {
    const kp = keypairFromSeed(buf.subarray(0, 32));
    if (!kp.pubkey.equals(buf.subarray(32))) throw new Error("secret key pubkey mismatch");
    return kp;
  }
  if (buf.length === 32) return keypairFromSeed(buf);
  throw new Error("secret key must be 32 or 64 bytes");
}

/** Load the keeper keypair, generating one on first run. */
export function loadKeeper(file) {
  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return keypairFromSecretKey(raw);
  }
  const seed = crypto.randomBytes(32);
  const kp = keypairFromSeed(seed);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([...seed, ...kp.pubkey]), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return kp;
}

/* --------------------------- wire primitives --------------------------- */

export function compactU16(n) {
  const out = [];
  for (;;) {
    if (n < 0x80) { out.push(n); break; }
    out.push((n & 0x7f) | 0x80);
    n >>= 7;
  }
  return Buffer.from(out);
}

export function u64le(v) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
}

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";

/* ---------------------------- message build ---------------------------- */
// Legacy message. Account ordering is consensus-critical: writable signers,
// readonly signers, writable non-signers, readonly non-signers. Fee payer
// must be index 0.

export function buildMessage({ feePayer, instructions, recentBlockhash }) {
  const meta = new Map();
  const touch = (addr, { signer = false, writable = false } = {}) => {
    const cur = meta.get(addr) || { signer: false, writable: false };
    cur.signer ||= signer; cur.writable ||= writable;
    meta.set(addr, cur);
  };

  touch(feePayer, { signer: true, writable: true });
  for (const ix of instructions) {
    for (const k of ix.keys) touch(k.pubkey, { signer: k.isSigner, writable: k.isWritable });
    touch(ix.programId, {});
  }

  const all = [...meta.entries()];
  const rank = ([, m]) => (m.signer && m.writable ? 0 : m.signer ? 1 : m.writable ? 2 : 3);
  const ordered = all
    .filter(([a]) => a !== feePayer)
    .sort((a, b) => rank(a) - rank(b) || a[0].localeCompare(b[0]));
  const keys = [feePayer, ...ordered.map(([a]) => a)];

  const m = (a) => meta.get(a);
  const numSigners = keys.filter((a) => m(a).signer).length;
  const numReadonlySigned = keys.filter((a) => m(a).signer && !m(a).writable).length;
  const numReadonlyUnsigned = keys.filter((a) => !m(a).signer && !m(a).writable).length;
  const index = (a) => keys.indexOf(a);

  const parts = [
    Buffer.from([numSigners, numReadonlySigned, numReadonlyUnsigned]),
    compactU16(keys.length),
    ...keys.map((a) => b58decode(a)),
    b58decode(recentBlockhash),
    compactU16(instructions.length),
  ];
  for (const ix of instructions) {
    const idx = Buffer.from(ix.keys.map((k) => index(k.pubkey)));
    parts.push(
      Buffer.from([index(ix.programId)]),
      compactU16(ix.keys.length), idx,
      compactU16(ix.data.length), Buffer.from(ix.data),
    );
  }
  return { message: Buffer.concat(parts), keys, numSigners };
}

export function signTransaction({ message, numSigners }, signers) {
  // Signature slots are positional: slot i belongs to account i.
  const sigs = [];
  for (let i = 0; i < numSigners; i++) {
    const kp = signers[i];
    sigs.push(kp ? sign(kp, message) : Buffer.alloc(64));
  }
  return Buffer.concat([compactU16(sigs.length), ...sigs, message]);
}

/* ----------------------------- instructions ---------------------------- */

export function transferSol({ from, to, lamports }) {
  const data = Buffer.concat([Buffer.from([2, 0, 0, 0]), u64le(lamports)]);
  return {
    programId: SYSTEM_PROGRAM,
    keys: [
      { pubkey: from, isSigner: true, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
    ],
    data,
  };
}

/** SPL Token Burn (instruction 8): destroys tokens from an account you own. */
export function burnTokens({ account, mint, owner, amount, programId = TOKEN_PROGRAM }) {
  return {
    programId,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([8]), u64le(amount)]),
  };
}

export function setComputeUnitPrice(microLamports) {
  return {
    programId: COMPUTE_BUDGET, keys: [],
    data: Buffer.concat([Buffer.from([3]), u64le(microLamports)]),
  };
}

/* -------------------------------- PDAs --------------------------------- */
// Associated token address = PDA(owner, tokenProgram, mint) under the ATA program.

const MAX_SEED = 255;
export function findProgramAddress(seeds, programId) {
  const pid = b58decode(programId);
  for (let bump = MAX_SEED; bump >= 0; bump--) {
    const h = crypto.createHash("sha256");
    for (const s of seeds) h.update(s);
    h.update(Buffer.from([bump]));
    h.update(pid);
    h.update(Buffer.from("ProgramDerivedAddress"));
    const d = h.digest();
    if (!isOnCurve(d)) return { address: b58encode(d), bump };
  }
  throw new Error("no off-curve address found");
}

// A PDA must NOT be a valid ed25519 point. node:crypto does NOT validate point
// membership on import (it accepts arbitrary 32-byte blobs), so the check has
// to be done by hand: attempt to decompress the point and see if x exists.
//   curve: -x^2 + y^2 = 1 + d*x^2*y^2  =>  x^2 = (y^2 - 1) / (d*y^2 + 1)
// A solution exists iff that value is a quadratic residue mod p.
const P = (1n << 255n) - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;

function modpow(b, e, m) {
  let r = 1n; b %= m;
  while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; }
  return r;
}

export function isOnCurve(bytes) {
  // Little-endian, top bit of the last byte is the sign of x.
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  const x2 = (u * modpow(v, P - 2n, P)) % P;
  if (x2 === 0n) return true;
  // Euler's criterion: x2 is a residue iff x2^((p-1)/2) == 1.
  return modpow(x2, (P - 1n) / 2n, P) === 1n;
}

export function associatedTokenAddress(owner, mint, tokenProgram = TOKEN_PROGRAM) {
  return findProgramAddress(
    [b58decode(owner), b58decode(tokenProgram), b58decode(mint)],
    ATA_PROGRAM,
  ).address;
}

/* --------------------------------- RPC --------------------------------- */

export function makeRpc(url, { retries = 4 } = {}) {
  let id = 0;
  return async function rpc(method, params = []) {
    let wait = 400;
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      });
      // Public endpoints rate-limit hard. Back off rather than dying mid-payout.
      if ((r.status === 429 || r.status >= 500) && attempt < retries) {
        const hinted = Number(r.headers.get("retry-after")) * 1000;
        await new Promise((s) => setTimeout(s, hinted > 0 ? hinted : wait));
        wait = Math.min(wait * 2, 8000);
        continue;
      }
      if (!r.ok) throw new Error(`rpc ${method} http ${r.status}`);
      const j = await r.json();
      if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`);
      return j.result;
    }
  };
}

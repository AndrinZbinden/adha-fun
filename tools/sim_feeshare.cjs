/* Simulate the fee-split transaction against mainnet to find out what the
   sharing program actually rejects, instead of guessing from an error code.
   CommonJS on purpose: the SDK pulls in anchor, which breaks under ESM. */
const { Connection, PublicKey, Transaction } = require("@solana/web3.js");
const { PUMP_SDK } = require("@pump-fun/pump-sdk");
const {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");

const RPC = process.env.SOLANA_RPC_URL;
const MINT = new PublicKey(process.argv[2]);
const CREATOR = new PublicKey(process.argv[3]);
const EXEC = new PublicKey("6xjNfNVyaigQYjLC7vNpUP4cbwHQNNdZhZpreemfvjjT");
const FEES = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
const AMM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const conn = new Connection(RPC, "confirmed");
const shares = [{ address: EXEC, shareBps: 10000 }];

async function sim(label, ixs) {
  const bh = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: CREATOR, recentBlockhash: bh.blockhash });
  ixs.forEach((i) => tx.add(i));
  let r;
  try {
    r = await conn.simulateTransaction(tx, undefined, false);
  } catch (e) {
    console.log("\n=== " + label + "\n  threw: " + e.message.slice(0, 200));
    return false;
  }
  const err = r.value.err;
  console.log("\n=== " + label);
  console.log("  err: " + JSON.stringify(err));
  for (const l of (r.value.logs || []).slice(-6)) console.log("   | " + l.slice(0, 160));
  return !err;
}

(async () => {
  const cfg = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_sharing_config"), MINT.toBuffer()], FEES)[0];
  const info = await conn.getAccountInfo(cfg);
  console.log("sharing config " + cfg.toBase58() + " exists: " + !!info);

  const create = await PUMP_SDK.createFeeSharingConfig({ creator: CREATOR, mint: MINT, pool: null });
  const upd = async (cur) => PUMP_SDK.updateFeeShares({
    authority: CREATOR, mint: MINT, currentShareholders: cur, newShareholders: shares,
  });

  await sim("A: create + update(current=[])  <- what the site does now", [create, await upd([])]);
  await sim("B: create + update(current=[creator])", [create, await upd([CREATOR])]);
  await sim("C: create + update(current=[exec])", [create, await upd([EXEC])]);
  await sim("D: create + update(current=[creator, exec])", [create, await upd([CREATOR, EXEC])]);

  const vaultAuth = PublicKey.findProgramAddressSync(
    [Buffer.from("creator_vault"), cfg.toBuffer()], AMM)[0];
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuth, true, TOKEN_PROGRAM_ID);
  const mkAta = createAssociatedTokenAccountIdempotentInstruction(
    CREATOR, ata, vaultAuth, NATIVE_MINT, TOKEN_PROGRAM_ID);
  await sim("E: create + makeAta + update(current=[creator])", [create, mkAta, await upd([CREATOR])]);
  await sim("F: create alone", [create]);
})();

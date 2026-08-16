/* Simulate the fee-split transaction against mainnet to find out what the
   sharing program actually rejects, instead of guessing from an error number.

   Runs several shapes of the same transaction against a real minted coin with
   sigVerify off, and prints the program logs for each. */
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { PumpSdk, PUMP_SDK } from "@pump-fun/pump-sdk";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const RPC = process.env.SOLANA_RPC_URL;
const MINT = new PublicKey(process.argv[2]);
const CREATOR = new PublicKey(process.argv[3]);
const conn = new Connection(RPC, "confirmed");
const sdk = new PumpSdk(conn);

// the split the burn adha wants: everything to the executor keeper
const EXEC = new PublicKey("6xjNfNVyaigQYjLC7vNpUP4cbwHQNNdZhZpreemfvjjT");
const shares = [{ address: EXEC, shareBps: 10000 }];

async function sim(label, ixs) {
  const bh = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: CREATOR, recentBlockhash: bh.blockhash });
  ixs.forEach((i) => tx.add(i));
  const r = await conn.simulateTransaction(tx, undefined, false);
  const err = r.value.err;
  console.log("\n===== " + label);
  console.log("  err:", JSON.stringify(err));
  if (err) for (const l of (r.value.logs || []).slice(-8)) console.log("   ", l);
  else console.log("    OK, no error");
  return !err;
}

const create = await PUMP_SDK.createFeeSharingConfig({ creator: CREATOR, mint: MINT, pool: null });

// what the site does today
const updEmpty = await PUMP_SDK.updateFeeShares({
  authority: CREATOR, mint: MINT, currentShareholders: [], newShareholders: shares,
});
await sim("A: create + update(current=[])  <- current site", [create, updEmpty]);

// the config starts out owned by the creator, so the creator is the one
// current shareholder whose account the program needs handed to it
const updCreator = await PUMP_SDK.updateFeeShares({
  authority: CREATOR, mint: MINT, currentShareholders: [CREATOR], newShareholders: shares,
});
await sim("B: create + update(current=[creator])", [create, updCreator]);

// same, but make sure the wSOL vault ATA the program writes to exists
const cfgPda = PublicKey.findProgramAddressSync(
  [Buffer.from("fee_sharing_config"), MINT.toBuffer()],
  new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ"),
)[0];
const vaultAuth = PublicKey.findProgramAddressSync(
  [Buffer.from("creator_vault"), cfgPda.toBuffer()],
  new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"),
)[0];
const ata = getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuth, true, TOKEN_PROGRAM_ID);
const mkAta = createAssociatedTokenAccountIdempotentInstruction(CREATOR, ata, vaultAuth, NATIVE_MINT, TOKEN_PROGRAM_ID);
await sim("C: create + makeAta + update(current=[creator])", [create, mkAta, updCreator]);

// and the supported path: config first, then read it back and update
await sim("D: create alone", [create]);

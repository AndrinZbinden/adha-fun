/* Build the exact fee-split transaction the site sends, simulate it against
   mainnet, and print the program's own log lines. A hex error code says
   nothing; the logs name the actual failure. */
const {
  Connection, PublicKey, Transaction, SystemProgram,
} = require("@solana/web3.js");
const sdk = require("@nirholas/pump-sdk");

const RPC = process.env.SOLANA_RPC_URL;
const MINT = new PublicKey(process.argv[2]);
const CREATOR = new PublicKey(process.argv[3]);
const SHARE = new PublicKey(process.argv[4]); // sole shareholder, 10000 bps

(async () => {
  const conn = new Connection(RPC, "confirmed");

  const pda = sdk.feeSharingConfigPda(MINT);
  const pdaKey = Array.isArray(pda) ? pda[0] : pda;
  console.log("feeSharingConfigPda:", pdaKey.toBase58());
  const info = await conn.getAccountInfo(pdaKey);
  console.log("config exists:", !!info, info ? "owner=" + info.owner.toBase58() : "");

  const ixs = [];
  if (!info) {
    ixs.push(await sdk.PUMP_SDK.createFeeSharingConfig({
      creator: CREATOR, mint: MINT, pool: null,
    }));
  }
  ixs.push(await sdk.PUMP_SDK.updateFeeShares({
    authority: CREATOR,
    mint: MINT,
    currentShareholders: info ? [] : [CREATOR],
    newShareholders: [{ address: SHARE, shareBps: 10000 }],
  }));

  console.log("instruction count:", ixs.length);
  ixs.forEach((ix, i) => {
    console.log(`  ix${i} program=${ix.programId.toBase58()} keys=${ix.keys.length}`);
  });

  const bh = await conn.getLatestBlockhash("finalized");
  const tx = new Transaction({ feePayer: CREATOR, recentBlockhash: bh.blockhash });
  ixs.forEach((i) => tx.add(i));

  const sim = await conn.simulateTransaction(tx, undefined, [CREATOR]);
  console.log("\n=== SIMULATION ===");
  console.log("err:", JSON.stringify(sim.value.err));
  console.log("units:", sim.value.unitsConsumed);
  console.log("--- logs ---");
  (sim.value.logs || []).forEach((l) => console.log(l));
})().catch((e) => {
  console.error("FAILED:", e.message);
  if (e.logs) e.logs.forEach((l) => console.error(l));
});

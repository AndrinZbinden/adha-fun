// Claiming accrued creator fees, one coin at a time.
//
// Trading fees do not arrive in the executor by themselves: pump accrues them
// inside the fee program and someone has to send a distribute transaction to
// release them. Until that happens the executor's balance never grows and the
// keeper divides a balance that was never earned.
//
// Distribution is per MINT, which is what makes honest accounting possible.
// One distribute pays every shareholder of that one coin's config, and the
// executor receives only its own share. So the budget for a coin's action legs
// is not a guess: it is the executor's balance AFTER minus BEFORE, measured
// around that coin's own distribute. Nothing else can land in that window
// except that coin's fees, so nothing else can be spent on it.
//
// The delta is also net of the transaction fee the executor just paid, which
// makes it conservative by construction: the keeper can never spend more than
// the coin actually delivered.

import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { OnlinePumpSdk } from "@nirholas/pump-sdk";

/** Lamports currently claimable for one mint, plus whether it is worth doing. */
export async function claimable(rpcUrl, mint) {
  const sdk = new OnlinePumpSdk(new Connection(rpcUrl, "confirmed"));
  const r = await sdk.getMinimumDistributableFee(new PublicKey(mint));
  return {
    available: BigInt(r.distributableFees?.toString() ?? "0"),
    minimum: BigInt(r.minimumRequired?.toString() ?? "0"),
    canDistribute: !!r.canDistribute,
    graduated: !!r.isGraduated,
  };
}

/**
 * Release one coin's accrued fees to its shareholders and report exactly how
 * much of it reached the executor.
 *
 * Returns { credited } in lamports: what THIS coin just paid the executor, and
 * therefore the only money its legs are allowed to spend. Returns credited 0n
 * with a reason when there was nothing to claim.
 */
export async function claimForMint({ rpcUrl, keeper, mint, dryRun = false }) {
  const connection = new Connection(rpcUrl, "confirmed");
  const sdk = new OnlinePumpSdk(connection);
  const mintKey = new PublicKey(mint);
  const payer = Keypair.fromSeed(keeper.seed);

  const status = await claimable(rpcUrl, mint);
  if (!status.canDistribute) {
    return { credited: 0n, skipped: "below pump's minimum distributable fee", ...status };
  }

  const { instructions } = await sdk.buildDistributeCreatorFeesInstructions(mintKey);
  if (!instructions || !instructions.length) {
    return { credited: 0n, skipped: "nothing to distribute", ...status };
  }

  if (dryRun) {
    return { credited: 0n, dryRun: true, wouldClaim: status.available.toString(), ...status };
  }

  // Measure around the transaction. "confirmed" on both reads so the before and
  // after are taken on the same commitment level and the delta is meaningful.
  const before = BigInt(await connection.getBalance(payer.publicKey, "confirmed"));

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash });
  instructions.forEach((ix) => tx.add(ix));
  tx.sign(payer);

  const signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");

  const after = BigInt(await connection.getBalance(payer.publicKey, "confirmed"));
  const credited = after > before ? after - before : 0n;

  return { credited, signature, graduated: status.graduated, available: status.available };
}

// Proves the per-coin budget arithmetic in keeper.mjs.
//
// The regression that matters: one wallet holds every coin's money, so a coin
// that earned nothing must not be able to spend a coin that earned plenty.
// balanceOverride keeps this offline - no RPC, no pumpportal.

import assert from "node:assert/strict";
import { runCycle, splitProRata, FEE_RESERVE } from "./keeper.mjs";

const keeper = { address: "11111111111111111111111111111111" };
const base = { rpcUrl: "http://127.0.0.1:1", keeper, mint: "M", creator: "C", dryRun: true };
// A wallet leg is not an action leg, so runCycle computes spendable and returns
// before touching the network.
const passive = [{ kind: "wallet", bps: 10000 }];
const pass = (n) => console.log("PASS  " + n);

const a = await runCycle({ ...base, balanceOverride: "1000000000", budget: "100000000", legs: passive });
assert.equal(a.spendable, "100000000");
pass("A budget caps spend below wallet balance");

const b = await runCycle({ ...base, balanceOverride: "50000000", budget: "1000000000", legs: passive });
assert.equal(b.spendable, String(50000000 - FEE_RESERVE));
pass("B wallet headroom caps an oversized budget");

const c = await runCycle({ ...base, balanceOverride: "1000000000", budget: "0", legs: passive });
assert.equal(c.spendable, "0");
assert.equal(c.skipped, "nothing spendable");
pass("C zero budget spends nothing");

const d = await runCycle({ ...base, balanceOverride: "1000000000", legs: passive });
assert.equal(d.spendable, "998000000");
pass("D no budget falls back to wallet headroom");

// The whole point: 5 SOL of OTHER coins' fees sitting in the wallet, this coin
// claimed nothing, so this coin spends nothing.
const e = await runCycle({ ...base, balanceOverride: "5000000000", budget: "0", legs: passive });
assert.equal(e.spendable, "0");
pass("E a coin with no claim cannot spend a funded wallet");

for (const [total, weights] of [
  [100000000n, [5000n, 3000n, 2000n]],
  [57500000n, [10000n]],
  [7n, [1n, 1n, 1n]],
  [1000000n, [1n, 99999n]],
]) {
  const parts = splitProRata(total, weights);
  assert.equal(parts.reduce((x, y) => x + y, 0n), total, `sum for ${weights}`);
  assert.ok(parts.every((p) => p >= 0n), `non-negative for ${weights}`);
}
pass("F splitProRata conserves the total exactly");

assert.deepEqual(splitProRata(57500000n, [10000n]), [57500000n]);
pass("G a 100% single action leg receives the whole budget");

// The user's example, end to end: claim 57.5 units, burn leg is 100%, so the
// burn leg must receive all 57.5 and nothing may leak to another coin.
const h = await runCycle({
  ...base, balanceOverride: "1000000000", budget: "57500000",
  legs: [{ kind: "burn", bps: 10000 }],
});
assert.equal(h.spendable, "57500000");
assert.equal(h.legs.length, 1);
assert.equal(h.legs[0].lamports, "57500000");
pass("H a 100% burn leg is handed exactly what the coin claimed");

console.log("\nALL PASS");

// Vanity mint grinder, one instance per CPU core.
//
// pump.fun addresses end in "pump" because their backend grinds them. We do the
// same for "adha", except in the browser, so it has to be parallel: a base58
// suffix of 4 characters is 58^4 = 11,316,496 addresses on average, and a
// single thread manages roughly 10-25k keypairs a second.
//
// Only the seed is sent back to the page. Deriving the keypair from it there
// keeps this worker free of any @solana/web3.js import.

import { ed25519 } from "https://esm.sh/@noble/curves@1.4.0/ed25519?target=es2022";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = "1" + out; else break; }
  return out;
}

let stop = false;

// Browsers clamp setTimeout to about once a second in a backgrounded tab, which
// would cut a 200ms work burst down to 200ms per second: roughly 80% of the
// machine wasted for exactly the case this is built for, a laptop left grinding
// in the background. A MessageChannel post is a macrotask too, so a stop
// message still gets its turn, but it is not a timer and is not throttled.
const yielder = new MessageChannel();
let resume = null;
yielder.port2.onmessage = () => { const f = resume; resume = null; if (f) f(); };
const nextTick = (fn) => { resume = fn; yielder.port1.postMessage(0); };

self.onmessage = (e) => {
  if (e.data.cmd === "stop") { stop = true; return; }
  if (e.data.cmd !== "grind") return;

  const suffix = e.data.suffix;
  const seed = new Uint8Array(32);
  let tried = 0;

  const slice = () => {
    if (stop) return;
    // Work in bursts so the "tried" counter can surface, and so a stop
    // message actually gets a chance to land between chunks.
    const until = performance.now() + 200;
    while (performance.now() < until) {
      crypto.getRandomValues(seed);
      const address = base58(ed25519.getPublicKey(seed));
      tried++;
      if (address.endsWith(suffix)) {
        self.postMessage({ found: true, seed, address, tried });
        stop = true;
        return;
      }
    }
    self.postMessage({ found: false, tried });
    tried = 0;
    nextTick(slice);
  };
  slice();
};

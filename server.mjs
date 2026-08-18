// Adha — real backend. Zero npm dependencies (node:http + node:sqlite).
// Serves the pixel-exact static shell and provides the APIs the original site faked.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { loadKeeper, findProgramAddress, b58decode, b58encode } from "./executor.mjs";
import { runCycle, ACTION_KINDS, FEE_RESERVE } from "./keeper.mjs";
import { claimForMint } from "./claim.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 8791);
// A rejected fetch inside a request handler used to take the whole process
// down, which on Railway shows up as a crash mail per deploy. Log and survive.
process.on("unhandledRejection", (e) => console.error("[unhandled]", e));
process.on("uncaughtException", (e) => console.error("[uncaught]", e));

const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "hooklaunch.db");
const KEEPER_PATH = process.env.KEEPER_PATH || path.join(__dirname, "data", "keeper.json");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;

/* Compare the admin token without leaking its contents through timing. A plain
   !== returns as soon as two bytes differ, which measurably narrows a guess. */
function adminOk(req) {
  if (!ADMIN_TOKEN) return false;
  const got = String((req.headers.authorization || "")).replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got), b = Buffer.from(ADMIN_TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Everything the launch flow legitimately calls through /api/rpc. Anything
// else (getProgramAccounts and friends) would turn this into free RPC for
// whoever finds it.
// Proof-of-launch for the public registry write path: read the mint
// transaction back off chain and require that it succeeded, that it really
// created this mint, and that the wallet claiming it actually signed.
async function mintProvesCreator(mint, creator, sig) {
  if (typeof sig !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{80,100}$/.test(sig)) return false;
  try {
    const r = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "getTransaction",
        params: [sig, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed", commitment: "confirmed" }],
      }),
    });
    const tx = (await r.json()).result;
    if (!tx || tx.meta.err) return false;
    const keys = tx.transaction.message.accountKeys || [];
    const has = keys.some((k) => (typeof k === "string" ? k : k.pubkey) === mint);
    const signed = keys.some((k) => k && k.pubkey === creator && k.signer);
    return has && signed;
  } catch {
    return false;
  }
}

const RPC_METHODS = new Set([
  "getLatestBlockhash", "sendTransaction", "getSignatureStatuses",
  "getAccountInfo", "getBalance", "getHealth", "simulateTransaction",
]);

// The executor. Generated on first boot and reused after that; the file is the
// only copy of the secret, so it lives beside the database on the volume.
// On Railway there is no keeper file, so accept the secret from an env var
// (KEEPER_SECRET = the same JSON byte array the file holds). File wins locally.
const keeper = (() => {
  if (process.env.KEEPER_SECRET && !fs.existsSync(KEEPER_PATH)) {
    fs.mkdirSync(path.dirname(KEEPER_PATH), { recursive: true });
    fs.writeFileSync(KEEPER_PATH, process.env.KEEPER_SECRET.trim());
    console.log("[keeper] loaded secret from KEEPER_SECRET env var");
  }
  return loadKeeper(KEEPER_PATH);
})();
console.log(`[keeper] executor address: ${keeper.address}`);
if (!ADMIN_TOKEN) console.log("[keeper] ADMIN_TOKEN unset - live execution is disabled, dry-run only");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
CREATE TABLE IF NOT EXISTS launches (
  mint          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  creator       TEXT NOT NULL,
  hook_id       TEXT NOT NULL,
  legs_json     TEXT NOT NULL,
  cadence       TEXT NOT NULL DEFAULT 'manual',
  sharing_config TEXT,
  authority_revoked INTEGER NOT NULL DEFAULT 0,
  policy_sig    TEXT,
  mint_sig      TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_launches_creator ON launches(creator);
CREATE INDEX IF NOT EXISTS idx_launches_created ON launches(created_at DESC);
CREATE TABLE IF NOT EXISTS ledger (
  mint       TEXT PRIMARY KEY,
  credited   INTEGER NOT NULL DEFAULT 0,
  spent      INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  mint       TEXT NOT NULL,
  leg_kind   TEXT NOT NULL,
  bps        INTEGER NOT NULL,
  lamports   INTEGER NOT NULL DEFAULT 0,
  signature  TEXT,
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_mint ON runs(mint, created_at DESC);
`);

// Older databases predate the dev-token lock pointer.
try { db.exec("ALTER TABLE launches ADD COLUMN lock_json TEXT"); } catch { /* already there */ }

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp" };

// Route -> captured page. Mirrors the original SPA's URL surface exactly.
const ROUTES = { "/": "index.html", "/hooks": "hooks.html", "/hooks/custom": "hooks-custom.html",
  "/launch": "launch.html", "/launches": "launches.html", "/live": "live.html", "/docs": "docs.html" };

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const LEG_KINDS = new Set(["burn", "holders", "jackpot", "wallet", "creator", "top-holders", "reserve", "buyback"]);

/* ---- per-IP rate limiting -------------------------------------------------
   Four endpoints spend real money or quota on behalf of an anonymous caller:
   the RPC proxy (Helius quota), the IPFS and PumpPortal passthroughs (our
   reputation with those services), and market data. Nothing stopped a script
   from hammering them.

   Token bucket per IP per endpoint. Buckets are sized so that a real launch
   never touches them: a full launch makes roughly 30-40 RPC calls in a burst,
   against a bucket of 240 that refills 4/s. The intent is to stop scripted
   abuse, not to police humans. */
const BUCKETS = {
  "/api/rpc":         { cap: 240, refill: 4.0 },   // whole launch flow ≈ 40
  "/api/market":      { cap: 60,  refill: 0.5 },   // 60s cache absorbs the rest
  "/api/launches/health": { cap: 60, refill: 0.5 },// one RPC read per mint, cached 60s
  "/api/ipfs":        { cap: 12,  refill: 0.05 },  // one per launch, ~1/20s back
  "/api/trade-local": { cap: 30,  refill: 0.25 },
  "/api/execute":     { cap: 20,  refill: 0.1 },
  // The registry endpoints were unlisted, and an unlisted path is unlimited.
  // That let a script guess the admin token as fast as it could open sockets,
  // and let anyone make the proof-checking path spend RPC calls for free.
  "/api/launches":        { cap: 40, refill: 0.5 },
  "/api/launches/seed":   { cap: 10, refill: 0.05 },
  "/api/launches/split":  { cap: 20, refill: 0.2 },
  "/api/config":          { cap: 60, refill: 1.0 },
  "/api/health":          { cap: 60, refill: 1.0 },
};
const buckets = new Map();

function clientIp(req) {
  // Cloudflare sits in front of Railway, so the socket address is always a
  // proxy. cf-connecting-ip is set by Cloudflare and cannot be spoofed by the
  // client; x-forwarded-for is the fallback and its FIRST entry is the origin.
  const cf = req.headers["cf-connecting-ip"];
  if (cf) return String(cf).trim();
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function rateLimit(req, p) {
  const cfg = BUCKETS[p];
  if (!cfg) return null;                       // unlisted endpoint: no limit
  const key = p + "|" + clientIp(req);
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) { b = { tokens: cfg.cap, seen: now }; buckets.set(key, b); }
  b.tokens = Math.min(cfg.cap, b.tokens + ((now - b.seen) / 1000) * cfg.refill);
  b.seen = now;
  if (b.tokens < 1) return Math.ceil((1 - b.tokens) / cfg.refill);  // seconds
  b.tokens -= 1;
  return null;
}

// An unbounded Map keyed by IP is itself a memory exhaustion vector. Drop
// buckets that have been idle long enough to have refilled to full anyway.
setInterval(() => {
  const cutoff = Date.now() - 15 * 60_000;
  for (const [k, b] of buckets) if (b.seen < cutoff) buckets.delete(k);
}, 5 * 60_000).unref?.();

function send(res, code, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(code, { "content-length": buf.length, "x-content-type-options": "nosniff", ...headers });
  res.end(buf);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), { "content-type": MIME[".json"] });

function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > limit) { reject(new Error("payload too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function validateLegs(legs) {
  if (!Array.isArray(legs) || legs.length === 0 || legs.length > 10) return "legs must be 1-10 entries";
  let total = 0;
  for (const l of legs) {
    if (!l || typeof l !== "object") return "malformed leg";
    if (!LEG_KINDS.has(l.kind)) return `unknown leg kind: ${l.kind}`;
    if (!Number.isInteger(l.bps) || l.bps <= 0 || l.bps > 10000) return "leg bps must be 1-10000";
    if (l.address != null && !B58.test(String(l.address))) return "leg address is not a valid pubkey";
    total += l.bps;
  }
  // pump.fun fee-sharing requires shares to sum to exactly 10000 bps.
  if (total !== 10000) return `legs must sum to 10000 bps (got ${total})`;
  return null;
}

/* ---- on-chain split health ------------------------------------------------
   pump.fun keeps the fee split in a "sharing-config" account derived from the
   mint. If that account is missing, 100% of creator fees go to the creator and
   the hooks can never fire, however correct the registered legs look. So read
   the account rather than trusting anything in our own database. */
const FEES_PROGRAM = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
const healthCache = new Map();                  // mint -> { at, value }

function decodeSharingConfig(b64) {
  const raw = Buffer.from(b64, "base64");
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  // 8 discriminator, bump u8, version u8, status u8, mint 32, admin 32,
  // admin_revoked bool, then a vec of (pubkey 32, bps u16).
  const REVOKED_AT = 8 + 1 + 1 + 1 + 32 + 32;
  let o = REVOKED_AT + 1;
  const n = dv.getUint32(o, true); o += 4;
  const holders = [];
  for (let i = 0; i < n; i++) {
    holders.push({ address: b58encode(raw.subarray(o, o + 32)), bps: dv.getUint16(o + 32, true) });
    o += 34;
  }
  return { holders, revoked: raw[REVOKED_AT] === 1 };
}

async function splitHealth(mint) {
  const hit = healthCache.get(mint);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;

  const row = db.prepare("SELECT * FROM launches WHERE mint=?").get(mint);
  if (!row) return { status: "unknown", error: "not registered" };
  const legs = JSON.parse(row.legs_json);

  // What the config SHOULD say: action legs pay the executor, passive legs
  // (creator/wallet) are paid straight to their own address by pump.fun.
  const want = new Map();
  for (const leg of legs) {
    const addr = ACTION_KINDS.has(leg.kind)
      ? keeper.address
      : (leg.address || leg.target || row.creator);
    want.set(addr, (want.get(addr) || 0) + leg.bps);
  }

  const { address: pda } = findProgramAddress(
    [Buffer.from("sharing-config"), Buffer.from(b58decode(mint))], FEES_PROGRAM);

  const r = await fetch(RPC_URL, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo",
      params: [pda, { encoding: "base64" }] }),
  });
  const info = (await r.json()).result;

  let value;
  if (!info || !info.value) {
    // A coin whose entire policy is "the dev keeps the fees" needs no sharing
    // config: pump.fun already pays 100% to the creator when none exists. That
    // is the policy working, not a broken split, so it is not reported as one.
    const creatorOnly = want.size === 1 && want.has(row.creator);
    value = creatorOnly
      ? { status: "ok", viaDefault: true, executorBps: 0 }
      : { status: "missing", executorBps: want.get(keeper.address) || 0 };
  } else {
    const { holders, revoked } = decodeSharingConfig(info.value.data[0]);
    const got = new Map(holders.map((h) => [h.address, h.bps]));
    const diffs = [];
    for (const [a, b] of want) if ((got.get(a) || 0) !== b) diffs.push(a);
    for (const a of got.keys()) if (!want.has(a)) diffs.push(a);
    value = diffs.length
      ? { status: "wrong", revoked, holders }
      : { status: "ok", revoked, executorBps: want.get(keeper.address) || 0 };
  }
  healthCache.set(mint, { at: Date.now(), value });
  return value;
}

async function handleApi(req, res, url) {
  const p = url.pathname;

  const wait = rateLimit(req, p);
  if (wait !== null) {
    return json(res, 429, { error: "too many requests, slow down" },
      { "retry-after": String(wait) });
  }

  // --- public config -------------------------------------------------------
  // EXECUTOR is the address that receives the SOL for action legs (burn,
  // holder rewards, jackpot, reserve) and actually performs them. Unset means
  // no executor exists yet, and those legs fall back to the creator's wallet.
  if (p === "/api/config" && req.method === "GET") {
    // RPC_URL is deliberately NOT returned: it carries the Helius API key, and
    // this endpoint is read by every browser that opens the site. The frontend
    // reaches the chain through /api/rpc instead, which keeps the key here.
    return json(res, 200, {
      executor: keeper.address,
      liveExecution: !!ADMIN_TOKEN,
    });
  }

  // --- run the hooks for one mint -----------------------------------------
  // Dry-run is open (it only simulates). Live execution moves real SOL, so it
  // needs the admin token.
  if (p === "/api/execute" && req.method === "POST") {
    const body = await readBody(req, 64 * 1024);
    let b; try { b = JSON.parse(body.toString("utf8")); } catch { return json(res, 400, { error: "invalid JSON" }); }
    if (!B58.test(String(b.mint || ""))) return json(res, 400, { error: "invalid mint" });
    const row = db.prepare("SELECT * FROM launches WHERE mint=?").get(String(b.mint));
    if (!row) return json(res, 404, { error: "mint not registered" });

    const dryRun = b.dryRun !== false;
    if (!dryRun) {
      if (!adminOk(req)) return json(res, 401, { error: "live execution requires the admin token" });
    }

    const legs = JSON.parse(row.legs_json);
    let report;
    try {
      report = await runCycle({
        rpcUrl: RPC_URL, keeper, mint: row.mint, legs,
        creator: row.creator, dryRun,
        // Straight off the request body before; a string or a negative here
        // reached the budget planner and skewed the whole simulation.
        balanceOverride: Number.isFinite(Number(b.balanceOverride)) && Number(b.balanceOverride) >= 0
          ? Math.floor(Number(b.balanceOverride)) : undefined,
      });
    } catch (e) {
      return json(res, 502, { error: e.message });
    }

    if (!dryRun) {
      const ins = db.prepare("INSERT INTO runs (mint,leg_kind,bps,lamports,signature,status,created_at) VALUES (?,?,?,?,?,?,?)");
      for (const leg of report.legs) {
        const sig = (leg.results || []).map((r) => r.signature).filter(Boolean).join(",") || null;
        ins.run(row.mint, leg.kind, leg.bps, Number(leg.lamports || 0), sig,
          leg.error ? "error" : leg.skipped ? "skipped" : "sent", Date.now());
      }
    }
    return json(res, 200, report);
  }

  // --- RPC proxy -----------------------------------------------------------
  if (p === "/api/rpc" && req.method === "POST") {
    // This proxy spends the Helius quota, so it is not a free public endpoint:
    // requests must come from our own pages, and may only call the handful of
    // methods the launch flow actually needs.
    // Two holes closed here. (1) The check was skipped entirely when Origin
    // was absent, so curl with no headers got unlimited free RPC. A browser on
    // our own pages always sends Origin or Referer, so absence means "not a
    // browser" and is now refused. (2) `origin.includes(host)` matched
    // https://adha.fun.attacker.io because that string contains "adha.fun".
    // Compare the parsed hostname for equality instead of substring.
    const raw = req.headers.origin || req.headers.referer || "";
    const host = req.headers.host || "";
    let ok = false;
    try { ok = !!raw && !!host && new URL(raw).host === host; } catch { ok = false; }
    if (!ok) return json(res, 403, { error: "cross-origin RPC is not allowed" });
    const body = await readBody(req, 1024 * 1024);
    let call; try { call = JSON.parse(body.toString("utf8")); } catch { return json(res, 400, { error: "invalid JSON" }); }
    const calls = Array.isArray(call) ? call : [call];
    const bad = calls.find((c) => !c || !RPC_METHODS.has(c.method));
    if (bad) return json(res, 403, { error: `method not allowed: ${bad && bad.method}` });
    const r = await fetch(RPC_URL, {
      method: "POST", headers: { "content-type": "application/json" }, body,
    });
    return send(res, r.status, Buffer.from(await r.arrayBuffer()), { "content-type": MIME[".json"] });
  }

  // --- pump.fun IPFS metadata upload (multipart passthrough) ---------------
  if (p === "/api/ipfs" && req.method === "POST") {
    const body = await readBody(req, 3 * 1024 * 1024);
    const ct = req.headers["content-type"];
    if (!ct || !ct.includes("multipart/form-data")) return json(res, 400, { error: "expected multipart/form-data" });
    const r = await fetch("https://pump.fun/api/ipfs", { method: "POST", headers: { "content-type": ct }, body });
    const txt = await r.text();
    return send(res, r.status, txt, { "content-type": r.headers.get("content-type") || MIME[".json"] });
  }

  // --- PumpPortal local trade builder (returns unsigned tx bytes) ----------
  if (p === "/api/trade-local" && req.method === "POST") {
    const body = await readBody(req, 1024 * 1024);
    let parsed; try { parsed = JSON.parse(body.toString("utf8")); } catch { return json(res, 400, { error: "invalid JSON" }); }
    if (!parsed || typeof parsed !== "object" || !parsed.action) return json(res, 400, { error: "missing action" });
    const r = await fetch("https://pumpportal.fun/api/trade-local", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(parsed),
    });
    const buf = Buffer.from(await r.arrayBuffer());
    const type = r.headers.get("content-type") || "application/octet-stream";
    return send(res, r.status, buf, { "content-type": type });
  }

  // --- Launch registry (the thing that was localStorage) -------------------
  if (p === "/api/launches" && req.method === "GET") {
    const creator = url.searchParams.get("creator");
    // A negative LIMIT means "no limit" in sqlite, so clamp the low end too.
    const n = Number(url.searchParams.get("limit"));
    const limit = Math.min(Math.max(Number.isFinite(n) && n > 0 ? Math.floor(n) : 100, 1), 500);
    let rows;
    if (creator) {
      if (!B58.test(creator)) return json(res, 400, { error: "invalid creator pubkey" });
      rows = db.prepare("SELECT * FROM launches WHERE creator=? ORDER BY created_at DESC LIMIT ?").all(creator, limit);
    } else {
      rows = db.prepare("SELECT * FROM launches ORDER BY created_at DESC LIMIT ?").all(limit);
    }
    return json(res, 200, { launches: rows.map(shape) });
  }

  if (p === "/api/launches" && req.method === "POST") {
    // This used to demand the admin token, which no browser can hold, so every
    // real launch was rejected with a 401 and the registry stayed empty. The
    // write path proves itself on chain instead: the mint signature has to
    // exist, have succeeded, and carry both this mint and this creator. That
    // blocks spam and impersonation without putting a secret in the page.
    const body = await readBody(req, 256 * 1024);
    let b; try { b = JSON.parse(body.toString("utf8")); } catch { return json(res, 400, { error: "invalid JSON" }); }
    for (const f of ["mint", "name", "symbol", "creator", "hookId", "legs"]) {
      if (b[f] == null) return json(res, 400, { error: `missing field: ${f}` });
    }
    if (!B58.test(String(b.mint))) return json(res, 400, { error: "invalid mint" });
    if (!B58.test(String(b.creator))) return json(res, 400, { error: "invalid creator" });
    const legErr = validateLegs(b.legs);
    if (legErr) return json(res, 400, { error: legErr });
    if (b.sharingConfig != null && !B58.test(String(b.sharingConfig))) return json(res, 400, { error: "invalid sharingConfig" });
    if (!(await mintProvesCreator(String(b.mint), String(b.creator), b.mintSig))) {
      return json(res, 403, { error: "mint signature does not prove this coin and creator" });
    }
    const now = Date.now();
    // Upsert, not insert-once. The client registers the coin as soon as the
    // MINT confirms, then calls again with policy_sig once the split lands —
    // otherwise a rejected/blocked second signature loses the launch entirely.
    // Later calls may only fill in signatures, never blank them out.
    db.prepare(`INSERT INTO launches
      (mint,name,symbol,creator,hook_id,legs_json,cadence,sharing_config,authority_revoked,policy_sig,mint_sig,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(mint) DO UPDATE SET
        hook_id        = excluded.hook_id,
        legs_json      = excluded.legs_json,
        sharing_config = COALESCE(excluded.sharing_config, launches.sharing_config),
        policy_sig     = COALESCE(excluded.policy_sig,     launches.policy_sig),
        mint_sig       = COALESCE(excluded.mint_sig,       launches.mint_sig)`).run(
      String(b.mint), String(b.name).slice(0, 64), String(b.symbol).slice(0, 16), String(b.creator),
      String(b.hookId).slice(0, 40), JSON.stringify(b.legs), String(b.cadence || "manual").slice(0, 20),
      b.sharingConfig ? String(b.sharingConfig) : null, b.authorityRevoked ? 1 : 0,
      b.policySig ? String(b.policySig) : null, b.mintSig ? String(b.mintSig) : null, now);
    const row = db.prepare("SELECT * FROM launches WHERE mint=?").get(String(b.mint));
    return json(res, 201, { ok: true, mint: b.mint, launch: shape(row) });
  }

  // Remove a coin from the registry, or clear it out entirely. The chain is
  // untouched by this: a deleted coin keeps its split and its fees, it simply
  // stops being listed here and stops being worked by the keeper, which reads
  // its queue from this table. Admin only, for obvious reasons.
  if (p === "/api/launches" && req.method === "DELETE") {
    if (!adminOk(req)) return json(res, 401, { error: "admin token required" });
    const mint = url.searchParams.get("mint");
    const all = url.searchParams.get("all") === "1";
    if (!mint && !all) return json(res, 400, { error: "pass mint=<pubkey> or all=1" });
    if (mint && !B58.test(mint)) return json(res, 400, { error: "invalid mint" });
    // The per-coin books go with it, otherwise a mint reused later would
    // inherit a stale balance and be handed money it never earned.
    // node:sqlite has no transaction() helper, so the statements are wrapped by
    // hand and rolled back together if any of the three fails.
    const where = mint ? " WHERE mint=?" : "";
    const args = mint ? [mint] : [];
    let removed = 0;
    db.exec("BEGIN");
    try {
      removed = Number(db.prepare("DELETE FROM launches" + where).run(...args).changes || 0);
      db.prepare("DELETE FROM ledger" + where).run(...args);
      db.prepare("DELETE FROM runs" + where).run(...args);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      return json(res, 500, { error: String(e.message || e).slice(0, 120) });
    }
    console.log(`[registry] removed ${removed} launch${removed === 1 ? "" : "es"}${mint ? " (" + mint + ")" : " (all)"}`);
    return json(res, 200, { ok: true, removed });
  }

  // Register a coin by hand, for the case the registry cannot prove yet: a
  // launch that has not minted. No on-chain proof exists to check, so this is
  // admin only, and the blank fields fill themselves in once the coin is live.
  if (p === "/api/launches/seed" && req.method === "POST") {
    if (!adminOk(req)) return json(res, 401, { error: "admin token required" });
    const body = await readBody(req, 16 * 1024);
    let b; try { b = JSON.parse(body.toString("utf8")); } catch { return json(res, 400, { error: "invalid JSON" }); }
    if (!B58.test(String(b.mint || ""))) return json(res, 400, { error: "invalid mint" });
    const legErr = validateLegs(b.legs);
    if (legErr) return json(res, 400, { error: legErr });
    if (b.creator && !B58.test(String(b.creator))) return json(res, 400, { error: "invalid creator" });
    db.prepare(`INSERT INTO launches
      (mint,name,symbol,creator,hook_id,legs_json,cadence,sharing_config,authority_revoked,policy_sig,mint_sig,created_at)
      VALUES (?,?,?,?,?,?,?,NULL,0,NULL,NULL,?)
      ON CONFLICT(mint) DO UPDATE SET
        hook_id   = excluded.hook_id,
        legs_json = excluded.legs_json`).run(
      String(b.mint), String(b.name || "").slice(0, 64), String(b.symbol || "").slice(0, 16),
      String(b.creator || ""), String(b.hookId || "creator").slice(0, 40),
      JSON.stringify(b.legs), String(b.cadence || "manual").slice(0, 20), Date.now());
    if (b.lock === null) db.prepare("UPDATE launches SET lock_json=NULL WHERE mint=?").run(String(b.mint));
    else if (b.lock && B58.test(String(b.lock.escrow || ""))) {
      db.prepare("UPDATE launches SET lock_json=? WHERE mint=?").run(JSON.stringify({
        escrow: String(b.lock.escrow),
        sig: b.lock.sig ? String(b.lock.sig).slice(0, 100) : null,
        program: String(b.lock.program || "Streamflow").slice(0, 40),
      }), String(b.mint));
    }
    healthCache.delete(String(b.mint));
    marketCache.delete(String(b.mint));
    lockCache.delete(String(b.mint));
    return json(res, 201, { ok: true, launch: shape(db.prepare("SELECT * FROM launches WHERE mint=?").get(String(b.mint))) });
  }

  // Live market data for the launches page: logo, market cap, holders.
  // Proxied through the server because pump.fun's API sends no CORS header,
  // and cached briefly so a page full of coins is not a burst of upstream hits.
  if (p === "/api/market" && req.method === "GET") {
    const mints = String(url.searchParams.get("mints") || "").split(",")
      .filter((m) => B58.test(m)).slice(0, 8);
    const out = {};
    await Promise.all(mints.map(async (m) => {
      try { out[m] = await marketFor(m); } catch { out[m] = {}; }
    }));
    return json(res, 200, { market: out });
  }

  // --- is the fee split actually live on chain? ----------------------------
  // The policy_sig column only records that the browser reported signature 2
  // back to us. It is null for coins whose split is perfectly fine, so the
  // page cannot use it to decide anything. Derive the sharing-config account
  // instead and read the real shareholder table: that is the only thing that
  // determines where pump.fun sends the fees.
  if (p === "/api/launches/health" && req.method === "GET") {
    const mints = String(url.searchParams.get("mints") || "").split(",")
      .filter((m) => B58.test(m)).slice(0, 24);
    const out = {};
    await Promise.all(mints.map(async (m) => {
      try {
        const [h, lock] = await Promise.all([splitHealth(m), lockStatus(m).catch(() => null)]);
        out[m] = lock ? { ...h, lock } : h;
      } catch (e) { out[m] = { status: "unknown", error: String(e.message || e).slice(0, 80) }; }
    }));
    return json(res, 200, { health: out });
  }

  // Record a split that was attached after the launch itself. Same proof rule
  // as the registry write: the signature has to exist on chain, have
  // succeeded, and carry both this mint and the creator on record for it.
  if (p === "/api/launches/split" && req.method === "POST") {
    const body = await readBody(req, 8 * 1024);
    let b; try { b = JSON.parse(body.toString("utf8")); } catch { return json(res, 400, { error: "invalid JSON" }); }
    if (!B58.test(String(b.mint || ""))) return json(res, 400, { error: "invalid mint" });
    const row = db.prepare("SELECT * FROM launches WHERE mint=?").get(String(b.mint));
    if (!row) return json(res, 404, { error: "not found" });
    if (!(await mintProvesCreator(String(b.mint), row.creator, b.policySig))) {
      return json(res, 403, { error: "signature does not prove this coin and creator" });
    }
    db.prepare("UPDATE launches SET policy_sig=? WHERE mint=?").run(String(b.policySig), String(b.mint));
    return json(res, 200, { ok: true, launch: shape(db.prepare("SELECT * FROM launches WHERE mint=?").get(String(b.mint))) });
  }

  const one = p.match(/^\/api\/launches\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
  if (one && req.method === "GET") {
    const row = db.prepare("SELECT * FROM launches WHERE mint=?").get(one[1]);
    if (!row) return json(res, 404, { error: "not found" });
    const runs = db.prepare("SELECT leg_kind,bps,lamports,signature,status,created_at FROM runs WHERE mint=? ORDER BY created_at DESC LIMIT 200").all(one[1]);
    return json(res, 200, { launch: shape(row), runs });
  }

  if (p === "/api/health") {
    // NEVER return RPC_URL here. It carries the Helius api-key in its query
    // string, and this endpoint is unauthenticated, so echoing it published the
    // key to anyone who asked. /api/config already documents this rule; health
    // quietly broke it. Report the upstream host only.
    const n = db.prepare("SELECT COUNT(*) c FROM launches").get().c;
    let rpcHost = "unknown";
    try { rpcHost = new URL(RPC_URL).host; } catch {}
    return json(res, 200, { ok: true, launches: n, rpcHost, ts: Date.now() });
  }

  return json(res, 404, { error: "no such endpoint" });
}

/* ---------------- live market data ---------------- */
const MARKET_TTL = 60_000;
const marketCache = new Map();

async function holderCount(mint, exclude) {
  // Helius returns token accounts a page at a time. Small launches fit in one
  // page; cap the walk so a big coin cannot stall the request.
  let cursor = null, owners = new Set();
  for (let page = 0; page < 2; page++) {
    const params = { mint, limit: 1000, options: { showZeroBalance: false } };
    if (cursor) params.cursor = cursor;
    const r = await fetch(RPC_URL, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenAccounts", params }),
      signal: AbortSignal.timeout(8000),
    }).then((x) => x.json()).catch(() => null);
    const accs = r && r.result && r.result.token_accounts;
    if (!accs || !accs.length) break;
    for (const a of accs) {
      if (Number(a.amount) > 0 && a.owner && a.owner !== exclude) owners.add(a.owner);
    }
    cursor = r.result.cursor;
    if (!cursor) break;
  }
  return owners.size;
}

async function marketFor(mint) {
  const hit = marketCache.get(mint);
  if (hit && Date.now() - hit.at < MARKET_TTL) return hit.data;
  let data = { image: null, mcapUsd: null, holders: null, complete: false,
               name: null, symbol: null, creator: null, live: false };
  try {
    const c = await fetch("https://frontend-api-v3.pump.fun/coins/" + mint, {
      headers: { accept: "application/json", "user-agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    }).then((r) => (r.ok ? r.json() : null));
    if (c) {
      data.image = c.image_uri || null;
      data.name = c.name || null;
      data.symbol = c.symbol || null;
      data.creator = c.creator || null;
      data.live = true;
      backfill(mint, c);
      data.mcapUsd = typeof c.usd_market_cap === "number" ? c.usd_market_cap : null;
      data.complete = !!c.complete;
      // The bonding curve holds the unsold supply and is not a holder.
      data.holders = await holderCount(mint, c.bonding_curve).catch(() => null);
    }
  } catch {}
  marketCache.set(mint, { at: Date.now(), data });
  return data;
}

/* A coin can be registered before it exists on chain, so its name, symbol and
   creator are blank until pump.fun has it. The first market read after the mint
   lands fills them in, and never overwrites anything already recorded. */
function backfill(mint, c) {
  try {
    const row = db.prepare("SELECT name, symbol, creator FROM launches WHERE mint=?").get(mint);
    if (!row) return;
    const name = row.name || String(c.name || "").slice(0, 64);
    const symbol = row.symbol || String(c.symbol || "").slice(0, 16);
    const creator = row.creator || (B58.test(String(c.creator || "")) ? String(c.creator) : "");
    if (name === row.name && symbol === row.symbol && creator === row.creator) return;
    db.prepare("UPDATE launches SET name=?, symbol=?, creator=? WHERE mint=?")
      .run(name, symbol, creator, mint);
    healthCache.delete(mint);
    console.log(`[registry] filled in ${symbol || mint} from pump.fun`);
  } catch {}
}

/* ---- dev-token lock -------------------------------------------------------
   A coin can say "the dev tokens are locked", and that claim is worth exactly
   as much as the account it points at. So the registry stores only the escrow
   address and the transaction that created it; how much is actually still in
   there is read from the chain on every check. Withdraw the tokens and the
   badge disappears by itself, without anyone editing anything here. */
const lockCache = new Map();

async function lockStatus(mint) {
  const hit = lockCache.get(mint);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;

  const row = db.prepare("SELECT lock_json FROM launches WHERE mint=?").get(mint);
  if (!row || !row.lock_json) return null;
  let meta; try { meta = JSON.parse(row.lock_json); } catch { return null; }
  if (!meta || !B58.test(String(meta.escrow || ""))) return null;

  let value = { status: "unknown", escrow: meta.escrow, sig: meta.sig || null,
                program: meta.program || "Streamflow" };
  try {
    const call = (method, params) => fetch(RPC_URL, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(8000),
    }).then((r) => r.json());

    const [bal, sup] = await Promise.all([
      call("getTokenAccountBalance", [meta.escrow]),
      call("getTokenSupply", [mint]),
    ]);
    const amt = Number(bal?.result?.value?.amount || 0);
    const total = Number(sup?.result?.value?.amount || 0);
    value = amt > 0 && total > 0
      ? { ...value, status: "locked", uiAmount: amt / 10 ** (bal.result.value.decimals || 0),
          pct: (amt / total) * 100 }
      : { ...value, status: "released" };
  } catch { /* leave it unknown rather than guess */ }

  lockCache.set(mint, { at: Date.now(), value });
  return value;
}

function shape(r) {
  return { mint: r.mint, name: r.name, symbol: r.symbol, creator: r.creator, hookId: r.hook_id,
    legs: JSON.parse(r.legs_json), cadence: r.cadence, sharingConfig: r.sharing_config,
    authorityRevoked: !!r.authority_revoked, policySig: r.policy_sig, mintSig: r.mint_sig,
    createdAt: r.created_at };
}

const SEC_HEADERS = {
  "content-security-policy": "frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};

function serveStatic(res, rel) {
  const full = path.resolve(PUBLIC, rel);
  // startsWith(PUBLIC) alone also accepts a sibling like <PUBLIC>-old, because
  // that string does start with the prefix. Require the separator.
  if (full !== PUBLIC && !full.startsWith(PUBLIC + path.sep)) return send(res, 403, "forbidden");
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, "not found");
    const ext = path.extname(full).toLowerCase();
    // .js was cached for an hour, so browsers kept running stale code after a
    // fix and reported errors from line numbers that no longer exist.
    const cache = (ext === ".html" || ext === ".js" || ext === ".css" || ext === ".json")
      ? "no-cache" : "public, max-age=3600";
    send(res, 200, data, { ...SEC_HEADERS,
      "content-type": MIME[ext] || "application/octet-stream", "cache-control": cache });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    // Trailing-slash redirect: /hooks/ -> ../hooks, /hooks/custom/ -> ../custom
    if (url.pathname.length > 1 && url.pathname.endsWith("/") && !url.pathname.endsWith("//")) {
      const stripped = url.pathname.slice(0, -1);
      if (ROUTES[stripped]) {
        const segment = stripped.split("/").pop();
        return send(res, 301, "Redirecting to " + segment, { location: "../" + segment });
      }
    }
    const routed = ROUTES[url.pathname.replace(/\/+$/, "") || "/"];
    if (routed) return serveStatic(res, routed);
    if (req.method === "GET") return serveStatic(res, url.pathname.slice(1));
    return send(res, 405, "method not allowed");
  } catch (e) {
    console.error("[err]", url.pathname, e.message);
    if (!res.headersSent) json(res, 500, { error: e.message });
  }
});

/* ---- keeper scheduler -----------------------------------------------------
   Every cycle, for each coin: claim that coin's accrued fees, then spend
   exactly what the claim delivered on that coin's own legs.

   This used to divide the executor's whole balance evenly across coins, which
   meant a coin that earned nothing could spend a coin that earned plenty. The
   claim is per mint, so the money is now attributable: the executor's balance
   delta measured around one coin's distribute IS that coin's budget, and the
   ledger carries any unspent remainder forward instead of pooling it. */
const CYCLE_MIN = Number(process.env.KEEPER_INTERVAL_MIN || 15);
let cycling = false;

async function keeperTick() {
  if (cycling) return;                      // a slow tick must not overlap
  if (!ADMIN_TOKEN) return;                 // same gate as live HTTP execution
  cycling = true;
  try {
    const rows = db.prepare("SELECT * FROM launches").all();
    const live = rows.filter((r) => {
      try { return JSON.parse(r.legs_json).some((l) => ACTION_KINDS.has(l.kind)); }
      catch { return false; }
    });
    if (!live.length) return;

    const ins = db.prepare("INSERT INTO runs (mint,leg_kind,bps,lamports,signature,status,created_at) VALUES (?,?,?,?,?,?,?)");
    const readLedger = db.prepare("SELECT credited, spent FROM ledger WHERE mint = ?");
    const credit = db.prepare(`INSERT INTO ledger (mint, credited, spent, updated_at)
      VALUES (?, ?, 0, ?) ON CONFLICT(mint) DO UPDATE SET
      credited = credited + excluded.credited, updated_at = excluded.updated_at`);
    const debit = db.prepare("UPDATE ledger SET spent = spent + ?, updated_at = ? WHERE mint = ?");

    for (const row of live) {
      try {
        // 1. Release this coin's fees. The executor receives only its own
        //    share; direct legs are paid by pump in the same transaction.
        const claim = await claimForMint({ rpcUrl: RPC_URL, keeper, mint: row.mint });
        if (claim.credited > 0n) {
          credit.run(row.mint, Number(claim.credited), Date.now());
          console.log(`[keeper] ${row.mint} claimed ${claim.credited} lamports`);
        }

        // 2. Spend only what this coin has credited and not yet spent.
        const led = readLedger.get(row.mint) || { credited: 0, spent: 0 };
        const budget = BigInt(led.credited) - BigInt(led.spent);
        if (budget <= 0n) continue;

        const report = await runCycle({
          rpcUrl: RPC_URL, keeper, mint: row.mint,
          legs: JSON.parse(row.legs_json), creator: row.creator, dryRun: false,
          budget: budget.toString(),
        });

        // 3. Debit only what actually went out. A leg that was skipped or threw
        //    keeps its share on this coin's books for the next cycle.
        let used = 0n;
        for (const leg of report.legs) {
          const sig = (leg.results || []).map((r) => r.signature).filter(Boolean).join(",") || null;
          const ok = !leg.error && !leg.skipped;
          if (ok) used += BigInt(leg.lamports || 0);
          ins.run(row.mint, leg.kind, leg.bps, Number(leg.lamports || 0), sig,
            leg.error ? "error" : leg.skipped ? "skipped" : "sent", Date.now());
        }
        if (used > 0n) debit.run(Number(used), Date.now(), row.mint);
        if (used > 0n) console.log(`[keeper] ${row.mint} spent ${used} of ${budget}`);
      } catch (e) {
        // A coin whose split signature never landed has no sharing config, so
        // pump pays 100% to the creator and there is nothing for us to claim.
        // That is a known state with a fix in the UI, not a fault: logging it
        // as a failure every 15 minutes buried the real errors under noise.
        if (/sharing config not found/i.test(e.message || "")) {
          console.log("[keeper] skip", row.mint, "no split attached, fees go to the creator");
          continue;
        }
        console.error("[keeper] cycle failed", row.mint, e.message);
      }
    }
  } catch (e) {
    console.error("[keeper] tick failed", e.message);
  } finally {
    cycling = false;
  }
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`adha server on :${PORT} (db ${DB_PATH})`);
  if (!ADMIN_TOKEN) {
    console.log("[keeper] scheduler off: ADMIN_TOKEN unset");
  } else if (CYCLE_MIN > 0) {
    console.log(`[keeper] scheduler on: every ${CYCLE_MIN} min`);
    setTimeout(keeperTick, 60_000).unref?.();          // let boot settle first
    setInterval(keeperTick, CYCLE_MIN * 60_000).unref?.();
  }
});

# Static Security Audit — hooklaunch

**Scope:** `/data/workspace/hooklaunch/server.mjs`, `keeper.mjs`, `executor.mjs`, `claim.mjs`, `public/*.js`, `public/*.html`
**Method:** Read-only grep/sed inspection. No files executed, no network requests.
**Date:** 2025-07-17

---

## A. XSS / HTML injection in browser code

- `public/app.js:234` — `wallet.name` and `wallet.publicKey` (from the injected wallet provider, i.e. remote/untrusted input) are interpolated into `m.innerHTML` **without escaping** at the assignment site. An `esc()` is defined locally on line 232 but the comment on lines 230–231 explicitly acknowledges this spot was missed. A malicious or spoofed extension could name itself with markup and inject script.
  ```js
  // app.js:230-234
  // innerHTML; this one spot did not. A malicious or spoofed extension could
  // name itself with markup and get script into the page.
  m.innerHTML =
    '<div style="padding:9px 10px 10px">' +
      '<div style="font-size:11.5px;color:#8d8ba3;letter-spacing:.02em">' +
        esc(wallet.name || "Wallet") + ...
  ```
  **Severity: MED** — requires a compromised or spoofed wallet extension; mitigated by the fact that `esc()` is called on both values (lines 237–238). The comment suggests the author believed escaping was absent, but the actual code does call `esc()`. The real risk is that the comment is stale and future edits may remove the escaping. Flagged for review.

- `public/hooks-list.js:71` — `panel.innerHTML = body(hook, labels, cadences)`. The `body()` function (line 122) escapes `hook.description`, `hook.caveat`, `cadence`, and `hook.id` via `esc()`. `hook.legs[].kind` is used as a CSS colour value inside an inline `style="background:..."` on line 115 — the colour comes from a hardcoded `COLORS` map (line 113) or falls back to a literal `"rgb(141, 139, 163)"`, so it is **not** user-controlled. No injection.
  ```js
  // hooks-list.js:114-115
  return '<div class="flex items-center gap-3 py-2 border-b border-surface3 last:border-0">' +
    '<span class="shrink-0 rounded-full" style="width:8px;height:8px;background:' + c + '"></span>' +
  ```
  **Severity: LOW** — no unescaped user value reaches HTML or style here; `c` is from a fixed map. Noted for completeness.

- `public/launches-view.js:124,129,136,139` — `el.outerHTML` assignments in `renderSplit()`. The function reads `data-sig` and `data-hook` attributes from the DOM (lines 120–121), then re-escapes them with `esc()` before writing back (lines 125–126). The `h.revoked` and `h.status` values are server-derived enums, not user-controlled. All interpolated values pass through `esc()`.
  ```js
  // launches-view.js:128-130
  el.outerHTML = '<span class="text-neutral2" title="' +
    (h.revoked ? "revoked, so the split can no longer be changed" : "the split can still be changed") +
    '">✓ split live on chain · ' + pct + "% routed" + ...
  ```
  **Severity: LOW** — no unescaped interpolated value. The `title` attribute concatenates a server enum directly, but the enum is a fixed string. Noted for completeness.

- `public/launches-view.js:85` — `logo.innerHTML` builds an `<img>` tag with `esc(m.image)` for the `src`. `m.image` comes from the market API (pump.fun). Escaped.
  **Severity: LOW** — escaped.

- `public/live-view.js:151` — `grid.innerHTML = list.length ? list.map(card).join("") ...`. The `card()` function (line 46) escapes every interpolated field (`x.hookId`, `x.mint`, `x.symbol`, `x.name`, `x.createdAt`). The `FEATURED` constant is hardcoded. No unescaped interpolation.
  **Severity: LOW** — all escaped.

- `public/live-view.js:163–164` — `logo.style.backgroundImage = url` where `url = "url('" + String(m.image).replace(/['\\]/g, "") + ")"`. `m.image` is API-derived. The `.replace()` strips single quotes and backslashes, which neutralises the CSS string-delimiter injection vector. However, it does **not** strip `)` or `;` or `url(`, so a value like `red');alert(1)//` would break out if the surrounding context allowed it. In this case the value is wrapped as `url('...')` so a raw `)` in the image URL would close the `url()` early and allow CSS injection (e.g. `');background:red;//`).
  ```js
  // live-view.js:160-164
  if (m.image) {
    const url = "url('" + String(m.image).replace(/['\\]/g, "") + "')";
    const logo = q("logo"), art = q("art");
    if (logo) logo.style.backgroundImage = url;
  ```
  **Severity: MED** — `m.image` is API-derived and the CSS-injection filter is incomplete: `)` is not escaped, allowing `url()` termination and arbitrary CSS property injection. The impact is visual defacement or data exfiltration via `background-image: url(//attacker/...)`.

- `public/launch-flow.js:488,500,1155` — `el.innerHTML` and `wrap.innerHTML` assignments. All interpolated values (`r.symbol`, `r.mint`, `r.splitError`) pass through the locally-defined `esc()` (line 1115). The `executor` address is truncated to 6+6 chars (line 505) and is server-derived.
  **Severity: LOW** — escaped.

- `public/hooks-custom.js:203` — `out.innerHTML = ...`. The `warn` array contains `result.unparsed` values and warning strings; `warn.map((w) => ... esc(w) ...)` escapes each entry on line 216. `badge` is derived locally from `result.ok`. All escaped.
  **Severity: LOW** — escaped.

- `public/app.js:91,93,223,248–249,284,290–293,295` — `.style.*` assignments. All use hardcoded strings or locally-computed values (`open` boolean, `r.bottom`, `innerWidth`, `kind` enum). No remote/API-derived value reaches a style property.
  **Severity: LOW** — no remote value in style.

- `public/launch-flow.js:133–134,148,167,211,240–241,338,363,368,1152` — `.style.*` assignments. All use hardcoded colour maps (`LEG_COLOR`), local booleans, or fixed strings. No remote value.
  **Severity: LOW**.

---

## B. SQL injection

- `server.mjs:472` — `db.prepare("DELETE FROM launches" + where).run(...args)`. The `where` variable is built on line 467 as `mint ? " WHERE mint=?" : ""` and `args` is `mint ? [mint] : []`. This uses a `?` placeholder with a parameterised argument. **SAFE** — not reported.

- `server.mjs:473` — `db.prepare("DELETE FROM ledger" + where).run(...args)`. Same `where`/`args` pattern. Parameterised. **SAFE**.

- `server.mjs:474` — `db.prepare("DELETE FROM runs" + where).run(...args)`. Same pattern. **SAFE**.

- `server.mjs:75,435,496,719` — `db.exec(...)` and `db.prepare(...)` calls using template literals for the static SQL schema/UPSERT statements. No variables are interpolated into these strings; all values are passed as positional `?` arguments to `.run()`. **SAFE**.

- No SQL string was found that uses template-literal interpolation or `+` concatenation to embed a variable. All dynamic values use parameterised placeholders.
  **Findings: NONE FOUND**

---

## C. Authentication and authorization

| Route | Method | Checks ADMIN_TOKEN? | Notes |
|---|---|---|---|
| `/api/config` | GET | No | Returns `executor` address and `liveExecution` flag. Read-only. |
| `/api/execute` | POST | Conditional | Checks token only when `dryRun` is false (line 320–321). Dry-run is open. |
| `/api/rpc` | POST | No | Checks Origin/Referer header instead (line 359–361). No ADMIN_TOKEN. |
| `/api/ipfs` | POST | No | Proxies multipart to pump.fun. No token check. |
| `/api/trade-local` | POST | No | Proxies to pumpportal.fun. No token check. |
| `/api/launches` | GET | No | Read registry. Optional `creator` param validated with B58 regex. |
| `/api/launches` | POST | No | **MUTATES** (INSERT/UPDATE into `launches`). Uses `mintProvesCreator()` on-chain proof instead of ADMIN_TOKEN (lines 414–420). |
| `/api/launches` | DELETE | **Yes** | Lines 457–458. |
| `/api/launches/seed` | POST | **Yes** | Lines 488–489. |
| `/api/market` | GET | No | Proxies to pump.fun. Read-only. |
| `/api/launches/health` | GET | No | Read-only. |
| `/api/launches/split` | POST | No | **MUTATES** (UPDATE `launches` SET `policy_sig`). Uses `mintProvesCreator()` on-chain proof (line 559). |
| `/api/launches/:mint` | GET | No | Read-only. |
| `/api/health` | GET | No | Returns server health. Read-only. |

**Flagged routes that mutate state without ADMIN_TOKEN and without on-chain proof:**

- `POST /api/ipfs` — proxies a multipart upload to `https://pump.fun/api/ipfs` using the request body verbatim (lines 376–381). This does not mutate the local database, but it does cause an outbound signed action (IPFS pin) on behalf of the user. There is no ADMIN_TOKEN check and no proof mechanism. An unauthenticated caller can cause the server to upload arbitrary multipart data to pump.fun's IPFS endpoint.
  **Severity: MED** — the server acts as an unauthenticated proxy for a state-changing external action. Mitigated by the fact that pump.fun applies its own rate limits and the data is public anyway, but the endpoint has no auth gate.

- `POST /api/trade-local` — proxies to `https://pumpportal.fun/api/trade-local` returning unsigned tx bytes (lines 386–394). Does not mutate local state; returns data. No token check.
  **Severity: LOW** — read-only proxy (returns unsigned bytes, does not sign or broadcast).

- `POST /api/execute` (dry-run) — when `dryRun !== false` is not enforced, the default is `dryRun = true` (line 316), so dry-run is open to any caller. Dry-run calls `runCycle()` which performs RPC reads but no signing. No state mutation.
  **Severity: LOW** — read-only simulation.

---

## D. Secret leakage

- `server.mjs:66` — `console.log("[keeper] loaded secret from KEEPER_SECRET env var")`. Logs the fact that the secret was loaded from the env var, but does **not** log the secret value itself.
  **Severity: LOW** — no secret value leaked, only the event.

- `server.mjs:70` — `console.log(\`[keeper] executor address: ${keeper.address}\`)`. Logs the executor's **public address** (not the secret key). Public addresses are, by definition, public.
  **Severity: LOW** — not a secret.

- `server.mjs:71,778–779` — `console.log("[keeper] ADMIN_TOKEN unset ...")`. Logs whether the token is set, not its value.
  **Severity: LOW** — no value leaked.

- `server.mjs:304` — `/api/config` returns `{ executor: keeper.address, liveExecution: !!ADMIN_TOKEN }`. Returns the public executor address and a boolean indicating whether ADMIN_TOKEN is set. Does not return the token value or the RPC URL.
  **Severity: LOW** — no secret value.

- `server.mjs:368` — `fetch(RPC_URL, ...)` sends the RPC URL (which contains the Helius API key in its query string) as the destination of an outbound request. The URL itself is not written into any HTTP response body. The `RPC_URL` is never returned in any response.
  **Severity: LOW** — the key is used as intended (outbound auth), not leaked.

- Grep for `RPC_URL`, `ADMIN_TOKEN`, `KEEPER_SECRET`, `api-key`, `apikey`, `helius`, `PRIVATE_KEY`, `secret`, `Bearer` across all listed files found **no** instance where a secret value is (a) written into an HTTP response body, (b) `console.log`'d in full, or (c) hardcoded as a literal string. All secrets are read from `process.env`.
  **Findings: NONE FOUND**

---

## E. Path traversal / static file serving

The static-file server is `serveStatic()` at `server.mjs:657–668`:

```js
// server.mjs:657-668
function serveStatic(res, rel) {
  const full = path.join(PUBLIC, rel);
  if (!full.startsWith(PUBLIC)) return send(res, 403, "forbidden");
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, "not found");
    ...
  });
}
```

**Guard mechanism:** `path.join(PUBLIC, rel)` is computed, then `full.startsWith(PUBLIC)` is checked.

**Assessment:**
- `path.join()` **does** normalise `..` segments on all platforms, so a request like `/api/../../etc/passwd` becomes `PUBLIC/../etc/passwd` → normalised to `/etc/passwd` (or the equivalent), which fails `startsWith(PUBLIC)`.
- However, `path.join()` on its own does **not** reject null bytes (`\0`), and `startsWith(PUBLIC)` is a string-prefix check, not a resolved-path comparison. On Linux, `path.join("/data/workspace/hooklaunch/public", "..%2f..%2fetc/passwd")` treats the `%2f` as literal characters (not decoded), so the resulting path is `/data/workspace/hooklaunch/public/..%2f..%2fetc/passwd` which stays inside PUBLIC. URL decoding happens **before** the URL object is constructed (line 672: `new URL(req.url, ...)`), so `%2e%2e` would be decoded to `..` by the URL parser, then `path.join` would normalise it. This is safe.
- **Null byte:** `path.join("public", "foo\0.js")` → on Node.js, the null byte is preserved in the string. `full.startsWith(PUBLIC)` would still be true (the string starts with PUBLIC), and `fs.readFile` on some platforms may truncate at the null byte, potentially serving `public/foo`. This is a minor edge case.
- **No `path.resolve()` or `realpath` is used**, so the check relies entirely on `path.join` normalisation + string prefix. This is the standard and generally sufficient pattern, but a more robust guard would use `path.resolve()` and compare against `PUBLIC + path.sep`.

**Verdict:** The guard is **adequate for common cases** (`..`, URL-encoded `..`) but does not explicitly neutralise null bytes or use resolved-path comparison. No active vulnerability demonstrated, but the mechanism is weaker than `path.resolve()` + prefix check.
**Severity: LOW** — no confirmed exploit; noted as a hardening opportunity.

---

## F. SSRF and unbounded proxying

**Outbound `fetch()` calls in `server.mjs`:**

| Line | Destination | Built from user input? | Notes |
|---|---|---|---|
| 34, 255, 368, 589 | `RPC_URL` | No | Hardcoded constant (from env). |
| 379 | `"https://pump.fun/api/ipfs"` | No | Hardcoded. Body is proxied from the request. |
| 389 | `"https://pumpportal.fun/api/trade-local"` | No | Hardcoded. Body proxied. |
| 611 | `"https://frontend-api-v3.pump.fun/coins/" + mint` | No | `mint` is B58-validated before use (line 608). |

**No outbound fetch URL is built from raw user/request input.** All destinations are hardcoded constants. The `mint` variable in the pump.fun coins URL is validated with `B58.test(mint)` (line 608) before concatenation.

**`readBody()` default limit:** `12 * 1024 * 1024` (12 MiB) — line 182.

**`readBody()` calls WITHOUT an explicit limit:**

- `server.mjs:376` — `POST /api/ipfs`: `const body = await readBody(req);` — uses the 12 MiB default. This endpoint proxies a multipart form upload to pump.fun. A 12 MiB unauthenticated upload buffer is large for an IPFS metadata endpoint (IPFS pins for coin metadata are typically <1 MB).
  **Severity: LOW** — not a direct vulnerability, but the default limit is generous for the use case and the endpoint has no auth gate (see section C).

All other `readBody()` calls pass explicit limits (64 KB, 1 MB, 256 KB, 16 KB, 8 KB).

---

## G. Denial of service / rate limiting

**`BUCKETS` rate-limit table** (`server.mjs:133–140`):

```js
const BUCKETS = {
  "/api/execute":  { cap: 6,  refill: 60 },
  "/api/launches": { cap: 30, refill: 60 },
  "/api/rpc":      { cap: 20, refill: 60 },
  "/api/market":   { cap: 40, refill: 60 },
};
```

**Routes from section C that are NOT keys in BUCKETS:**

| Route | Not rate-limited? | Expensive work? |
|---|---|---|
| `/api/config` | Yes | No — returns two static values. |
| `/api/ipfs` | **Yes** | **Yes** — proxies a multipart upload to pump.fun (outbound fetch + request body buffering up to 12 MiB). Unauthenticated. |
| `/api/trade-local` | **Yes** | **Yes** — proxies to pumpportal.fun (outbound fetch, body buffered up to 1 MiB). Unauthenticated. |
| `/api/launches/seed` | **Yes** | **Yes** — INSERT/UPDATE into sqlite, clears two caches. Admin-token-gated, so low risk. |
| `/api/launches/health` | **Yes** | **Yes** — for each mint (up to 24), performs an outbound derivation + RPC-style check (`splitHealth()`). Unauthenticated. |
| `/api/launches/split` | **Yes** | **Yes** — SELECT + `mintProvesCreator()` (RPC call) + UPDATE. Unauthenticated (uses on-chain proof). |
| `/api/launches/:mint` | **Yes** | **Yes** — SELECT from `launches` + SELECT up to 200 rows from `runs`. Read-only but database work. |
| `/api/health` | Yes | No — lightweight. |

**Flagged unlisted routes doing expensive work without rate limits:**

- `POST /api/ipfs` — unauthenticated, unbounded proxy for an outbound upload. An attacker can flood pump.fun's IPFS endpoint through this server, consuming both the server's upload bandwidth and pump.fun's quota.
  **Severity: MED**

- `GET /api/launches/health` — allows up to 24 mints per request, each triggering `splitHealth()` (which performs on-chain derivation and account reads). No rate limit and no auth. A caller can issue repeated requests with 24 mints each, causing sustained RPC/account work.
  **Severity: MED**

- `POST /api/launches/split` — each call triggers `mintProvesCreator()` which makes an RPC call to verify the signature on chain. No rate limit. An attacker can cause sustained RPC work.
  **Severity: MED**

- `GET /api/launches/:mint` — returns up to 200 run records per mint. No rate limit. Lower risk (database read only), but a per-mint enumeration attack is possible.
  **Severity: LOW**

- `POST /api/trade-local` — proxies to pumpportal.fun. No rate limit. Returns unsigned tx bytes; the work is one outbound fetch per request.
  **Severity: LOW**

---

## H. Input validation

| Route | Input source | Validated? | Reaches |
|---|---|---|---|
| `POST /api/execute` | `body.mint` | `B58.test(String(b.mint))` (line 314) | DB SELECT (parameterised) |
| `POST /api/execute` | `body.dryRun` | Boolean coercion (line 316) | Control flow |
| `POST /api/execute` | `body.balanceOverride` | **Not validated** — passed directly to `runCycle()` (line 330) | RPC / signing logic |
| `POST /api/rpc` | `body` (JSON-RPC calls) | `RPC_METHODS.has(c.method)` allowlist (line 366) | Outbound fetch to RPC_URL |
| `POST /api/ipfs` | `body` (multipart) | Content-Type checked (line 377); body passed verbatim to pump.fun | Outbound fetch |
| `POST /api/trade-local` | `body.action` | `parsed.action` presence checked (line 388) | Outbound fetch |
| `GET /api/launches` | `url.searchParams.get("creator")` | `B58.test(creator)` (line 403) | DB SELECT (parameterised) |
| `GET /api/launches` | `url.searchParams.get("limit")` | `Math.min(Number(...), 500)` (line 400) | DB SELECT LIMIT (parameterised) |
| `POST /api/launches` | `body.mint`, `body.creator`, `body.sharingConfig` | `B58.test()` on each (lines 422–426) | DB INSERT (parameterised) |
| `POST /api/launches` | `body.name` | `String(b.name).slice(0, 64)` (line 438) | DB INSERT |
| `POST /api/launches` | `body.symbol` | `String(b.symbol).slice(0, 16)` (line 438) | DB INSERT |
| `POST /api/launches` | `body.hookId` | `String(b.hookId).slice(0, 40)` (line 439) | DB INSERT |
| `POST /api/launches` | `body.cadence` | `String(b.cadence || "manual").slice(0, 20)` (line 439) | DB INSERT |
| `POST /api/launches` | `body.legs` | `validateLegs()` (line 425) — checks array, length 1–10, `LEG_KINDS` allowlist, `bps` sum | DB INSERT (JSON.stringify) |
| `POST /api/launches` | `body.mintSig`, `body.policySig` | Passed to `mintProvesCreator()` (line 427) | RPC verification |
| `DELETE /api/launches` | `url.searchParams.get("mint")` | `B58.test(mint)` (line 462) | DB DELETE (parameterised) |
| `DELETE /api/launches` | `url.searchParams.get("all")` | `=== "1"` comparison (line 460) | Control flow |
| `POST /api/launches/seed` | `body.mint`, `body.creator` | `B58.test()` (lines 492, 494) | DB INSERT |
| `POST /api/launches/seed` | `body.legs` | `validateLegs()` (line 493) | DB INSERT |
| `GET /api/market` | `url.searchParams.get("mints")` | Split on `,`, `B58.test(m)`, `.slice(0, 8)` (lines 514–515) | Outbound fetch to pump.fun |
| `GET /api/launches/health` | `url.searchParams.get("mints")` | Split on `,`, `B58.test(m)`, `.slice(0, 24)` (lines 530–531) | `splitHealth()` per mint |
| `POST /api/launches/split` | `body.mint` | `B58.test()` (line 546) | DB SELECT + UPDATE |
| `POST /api/launches/split` | `body.policySig` | Passed to `mintProvesCreator()` (line 559) | RPC verification |
| `GET /api/launches/:mint` | `one[1]` (regex capture) | Regex `[1-9A-HJ-NP-Za-km-z]{32,44}` (line 557) | DB SELECT + SELECT runs |

**Flagged unvalidated values that reach expensive operations:**

- `POST /api/execute` — `body.balanceOverride` is read on line 330 and passed directly into `runCycle()` without any validation (no type check, no range check, no sanitisation). It reaches the RPC/execution path. A caller could pass an arbitrarily large number or malformed value.
  ```js
  // server.mjs:316-330
  const dryRun = b.dryRun !== false;
  ...
  report = await runCycle({
    rpcUrl: RPC_URL, keeper, mint: row.mint, legs,
    creator: row.creator, dryRun,
    balanceOverride: b.balanceOverride,
  });
  ```
  **Severity: MED** — `balanceOverride` reaches the execution/RPC layer without validation. In dry-run mode (the default, open to any caller) this could cause `runCycle` to operate on a fabricated balance, potentially producing misleading reports or triggering edge-case errors in the simulation path.

- `POST /api/ipfs` — the multipart body is buffered up to 12 MiB and forwarded verbatim to pump.fun with no schema validation, size check beyond the readBody limit, or content-type enforcement beyond `includes("multipart/form-data")`. A caller could send a malformed multipart body that pump.fun rejects, causing the server to proxy the error back.
  **Severity: LOW** — the external API (pump.fun) is the ultimate validator; the server is a dumb pipe.

- `POST /api/trade-local` — `parsed.action` is checked for presence but not against an allowlist. The rest of the parsed body is forwarded to pumpportal.fun. If pumpportal supports additional actions beyond what the frontend intends, they are accessible.
  **Severity: LOW** — no allowlist on `parsed.action`.

---

## Summary

| Section | Findings | Highest severity |
|---|---|---|
| A. XSS / HTML injection | 2 (wallet menu comment/code mismatch; CSS injection via `m.image` in live-view) | MED |
| B. SQL injection | 0 | — |
| C. AuthN/AuthZ | 1 (unauthenticated `/api/ipfs` proxy) | MED |
| D. Secret leakage | 0 | — |
| E. Path traversal | 1 (null-byte edge case, no resolved-path comparison) | LOW |
| F. SSRF / unbounded proxy | 1 (12 MiB default on `/api/ipfs`) | LOW |
| G. DoS / rate limiting | 4 unlisted routes doing expensive work (`/api/ipfs`, `/api/launches/health`, `/api/launches/split`, `/api/launches/:mint`) | MED |
| H. Input validation | 1 (`balanceOverride` unvalidated in `/api/execute`) | MED |

**Overall:** No critical-severity findings. The most actionable items are (1) the unauthenticated `/api/ipfs` proxy with a generous body limit, (2) missing rate limits on `/api/launches/health` and `/api/launches/split` which trigger per-request RPC work, (3) the unvalidated `balanceOverride` parameter in the open dry-run endpoint, and (4) the incomplete CSS-injection filter in `live-view.js` that does not strip `)` from API-derived image URLs.

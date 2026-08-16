// Launch page: hook picker + the two-signature launch flow.
//   signature 1 - mint on pump.fun (PumpPortal local trade builder)
//   signature 2 - createFeeSharingConfig + updateFeeShares (pump.fun's own program)
// Order matters: fee sharing is configured against an existing mint, so the token
// must exist first. The original site signed a memo first, which nothing ever read.

import { wallet, toast } from "./app.js";

const api = (p) => new URL(p, document.baseURI).toString();
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const WEB3 = "https://esm.sh/@solana/web3.js@1.95.3?target=es2022";
const PUMP = "https://esm.sh/@nirholas/pump-sdk?target=es2022";

let HOOKS = [], LABELS = {}, selected = null, imageFile = null, executor = null, busy = false;
let tLaunch = 0;
const F = {};
let cta, gate, hookBtns = [];
let skipping = null;

export async function initLaunch() {
  // The fields are found by placeholder, so renaming a placeholder in the HTML
  // while a browser still runs a cached copy of this file leaves F.symbol null
  // and the Launch button permanently disabled. Accept the old spellings too.
  // Last resort: the first two single-line text inputs in the form are the
  // name and the ticker. A null here used to throw inside paintCta, which
  // aborted the whole module and left the button dead on the page.
  const texts = $$("input").filter((i) => !i.type || i.type === "text");
  F.name = $('input[placeholder="Adha Coin"]') || $('input[placeholder="Hook Coin"]') || texts[0] || null;
  F.symbol = $('input[placeholder="ADHA"]') || $('input[placeholder="HOOK"]') || texts[1] || null;
  F.desc = $('textarea[placeholder="What is it?"]');
  F.opt = $$('input[placeholder="optional"]');
  F.file = $('input[type="file"]');
  F.devbuy = $('input[type="number"]');
  cta = $$("button").find((b) => b.className.includes("w-full mt-5"));
  gate = cta ? cta.nextElementSibling : null;

  const cfg = await fetch(api("hooks.json")).then((r) => r.json());
  HOOKS = cfg.hooks; LABELS = cfg.legLabels || {};
  try { executor = (await fetch(api("api/config")).then((r) => r.json())).executor; } catch {}

  const want = new URLSearchParams(location.search).get("hook");
  selected = (want === "custom" && customHook()) || HOOKS.find((h) => h.id === want) || HOOKS[0];

  wireHooks();
  wireImage();
  wireDevBuy();
  [F.name, F.symbol].forEach((el) => el && el.addEventListener("input", paintCta));
  cta && cta.addEventListener("click", onCta);
  wallet.onChange(paintCta);
  paintHooks(); paintSummary(); paintCta();
  // Bank addresses while the user fills the form, and between visits.
  ensurePool();
  // The count only changes every few minutes, so a slow repaint is plenty.
  setInterval(paintCta, 5000);
  // Same idea for the code: these are large modules, and fetching them
  // between signatures added seconds to every launch.
  import(WEB3).catch(() => {});
  import(PUMP).catch(() => {});
}

/* ---------------- "Before you sign" summary ----------------
   This panel was static markup lifted from the original site: it always
   described Buy & burn no matter which hook was picked. Repaint it from the
   selected hook. */

const LEG_COLOR = {
  burn: "rgb(18, 15, 25)", buyback: "rgb(18, 15, 25)",
  holders: "rgb(111, 91, 214)", topholders: "rgb(111, 91, 214)",
  jackpot: "rgb(224, 160, 60)", reserve: "rgb(224, 160, 60)",
  wallet: "rgb(150, 146, 168)", creator: "rgb(150, 146, 168)",
};

const LEG_PHRASE = {
  burn: "buys the coin and burns it",
  buyback: "buys the coin and keeps it",
  holders: "is paid out to holders, by balance",
  topholders: "is split across the biggest holders",
  jackpot: "goes to one holder, drawn by weight",
  reserve: "buys the coin into a reserve",
  wallet: "goes to your wallet",
  creator: "goes to the creator wallet",
};

const fmtBps = (b) => (b / 100).toFixed(b % 100 ? 1 : 0) + "%";

/* The hook is the whole point of launching here, but it lived only on our own
   launches page. pump.fun, Dexscreener, the terminals and every aggregator
   read the IPFS description, so state the split there too — that is the only
   place a buyer who has never seen adha.fun will look. */
export function hookLine(hook) {
  if (!hook || !Array.isArray(hook.legs) || !hook.legs.length) return "";
  const split = hook.legs
    .map((l) => fmtBps(l.bps) + " " + String(LABELS[l.kind] || l.kind).toLowerCase())
    .join(", ");
  const name = hook.name || hook.id || "Custom";
  return "Creator-fee hook \u2014 " + name + ": " + split + ". Policy published via adha.fun.";
}

function summaryPanel() {
  const head = $$("div").find((d) => d.textContent.trim() === "Before you sign");
  return head ? head.parentElement : null;
}

function paintSummary() {
  const panel = summaryPanel();
  if (!panel || !selected) return;

  const name = panel.querySelector(".medium.text-neutral1");
  if (name) name.textContent = selected.name;

  // What the hook DOES. Without this the caveat box was the only prose on the
  // panel, so it read as the explanation instead of the warning.
  const bar0 = panel.querySelector('div[style*="height: 9px"]');
  let desc = panel.querySelector("#hl-hook-desc");
  if (!desc && bar0) {
    desc = document.createElement("p");
    desc.id = "hl-hook-desc";
    desc.className = "text-[12.5px] text-neutral2 leading-relaxed mb-3.5 -mt-1";
    bar0.parentElement.insertBefore(desc, bar0);
  }
  if (desc) desc.textContent = selected.description || selected.tagline || "";

  // Proportional bar.
  const bar = panel.querySelector('div[style*="height: 9px"]');
  if (bar) {
    bar.innerHTML = "";
    for (const leg of selected.legs) {
      const seg = document.createElement("div");
      seg.className = "rounded-full transition-[width] duration-500";
      seg.title = fmtBps(leg.bps) + " " + (LABELS[leg.kind] || leg.kind);
      seg.style.width = (leg.bps / 100) + "%";
      seg.style.background = LEG_COLOR[leg.kind] || "rgb(150, 146, 168)";
      bar.appendChild(seg);
    }
  }

  // One row per leg.
  const ul = panel.querySelector("ul");
  if (ul) {
    ul.innerHTML = "";
    for (const leg of selected.legs) {
      const li = document.createElement("li");
      li.className = "flex items-baseline gap-3 py-3 border-b border-surface3";
      const dot = document.createElement("span");
      dot.className = "w-2 h-2 rounded-full shrink-0 translate-y-[-1px]";
      dot.style.background = LEG_COLOR[leg.kind] || "rgb(150, 146, 168)";
      const pct = document.createElement("span");
      pct.className = "medium text-neutral1 font-mono text-[13px] w-14 shrink-0";
      pct.textContent = fmtBps(leg.bps);
      const txt = document.createElement("span");
      txt.className = "text-[14px] text-neutral2 leading-snug";
      txt.textContent = LEG_PHRASE[leg.kind] || (LABELS[leg.kind] || leg.kind);
      li.append(dot, pct, txt);
      ul.appendChild(li);
    }
  }

  // The honest caveat travels with the hook.
  const caveatBox = $$("div", panel).length ? panel.querySelector(".text-warn") : null;
  const warnHead = Array.from(panel.querySelectorAll("div"))
    .find((d) => d.textContent.trim().toLowerCase() === "what it does not do");
  if (warnHead) {
    const p = warnHead.parentElement.querySelector("p");
    if (p) p.textContent = selected.caveat || selected.description || "";
    warnHead.parentElement.style.display = selected.caveat ? "" : "none";
  }
  void caveatBox;
}

/* ---------------- dev buy: SOL <-> % of supply ----------------
   pump.fun denominates the dev buy in SOL, but what a creator actually cares
   about is how much of the supply they end up holding. Convert with the real
   bonding curve rather than guessing:  cost = vSol * t / (vTok - t). */

const V_SOL = 30, V_TOK = 1_073_000_191, SUPPLY = 1_000_000_000;
const PUMP_FEE = 0.01;
const MAX_PCT = 79; // the curve graduates before the full supply is reachable
let devMode = "sol";

const pctToSol = (pct) => {
  const t = Math.min(pct, MAX_PCT) / 100 * SUPPLY;
  return (V_SOL * t) / (V_TOK - t) * (1 + PUMP_FEE);
};
const solToPct = (sol) => {
  const net = sol / (1 + PUMP_FEE);
  return (V_TOK * net) / (V_SOL + net) / SUPPLY * 100;
};

/** SOL the mint transaction should actually spend, whichever mode is showing. */
export function devBuySol() {
  // PumpPortal's create builder currently 400s on ANY non-zero amount, so a
  // dev buy cannot be bundled into the mint. Verified 2026-08-14 against
  // 0.01 / 0.1 / 1 SOL, string and numeric, both denominations, pool pump+auto.
  if (!F.devbuy || F.devbuy.disabled) return 0;
  const v = Number((F.devbuy && F.devbuy.value) || 0);
  if (!v || v < 0) return 0;
  return devMode === "sol" ? v : pctToSol(v);
}

function wireDevBuy() {
  if (!F.devbuy) return;
  const unit = Array.from(F.devbuy.closest("div").parentElement.querySelectorAll("span"))
    .find((s) => s.textContent.trim() === "SOL");
  if (!unit) return;

  // Turn the static "SOL" label into a two-way switch.
  const wrap = document.createElement("span");
  wrap.className = "inline-flex items-center rounded-full border border-surface3 overflow-hidden";
  wrap.style.cssText += "height:22px";
  const mk = (id, label) => {
    const b = document.createElement("button");
    b.type = "button"; b.dataset.mode = id; b.textContent = label;
    b.className = "px-2.5 h-[22px] text-[11.5px] medium cursor-pointer border-0 transition-colors";
    b.addEventListener("click", () => setDevMode(id));
    return b;
  };
  wrap.append(mk("sol", "SOL"), mk("pct", "% supply"));
  unit.replaceWith(wrap);

  const hint = document.createElement("div");
  hint.id = "hl-devbuy-hint";
  hint.className = "text-[12px] text-neutral3 mt-1.5";
  F.devbuy.parentElement.appendChild(hint);

  F.devbuy.addEventListener("input", paintDevHint);
  setDevMode("sol");

  function setDevMode(next) {
    const cur = Number(F.devbuy.value || 0);
    if (cur > 0 && next !== devMode) {
      // Keep the intent, not the number.
      const converted = next === "pct" ? solToPct(cur) : pctToSol(cur);
      F.devbuy.value = converted < 0.001 ? converted.toFixed(6) : converted.toFixed(3);
    }
    devMode = next;
    for (const b of wrap.querySelectorAll("button")) {
      const on = b.dataset.mode === devMode;
      b.style.background = on ? "var(--color-neutral1, #120f19)" : "transparent";
      b.style.color = on ? "#fff" : "var(--color-neutral2, #6b6880)";
    }
    F.devbuy.placeholder = devMode === "sol" ? "0" : "0";
    F.devbuy.step = devMode === "sol" ? "0.01" : "0.1";
    F.devbuy.max = devMode === "sol" ? "" : String(MAX_PCT);
    paintDevHint();
  }

  function paintDevHint() {
    const v = Number(F.devbuy.value || 0);
    if (!v || v <= 0) {
      hint.textContent = devMode === "sol"
        ? "How much SOL you buy at mint."
        : "How much of the 1B supply you want at mint.";
      return;
    }
    if (devMode === "sol") {
      hint.textContent = "\u2248 " + solToPct(v).toFixed(2) + "% of supply at mint.";
    } else {
      const capped = v > MAX_PCT;
      hint.textContent = "\u2248 " + pctToSol(v).toFixed(3) + " SOL" +
        (capped ? ", capped at " + MAX_PCT + "%, the curve graduates first." : "") +
        " (includes pump.fun's 1% fee)";
    }
  }
}

/* ---------------- hook picker ---------------- */
function wireHooks() {
  hookBtns = [];
  for (const btn of $$("button")) {
    if (btn === cta) continue;
    const label = btn.querySelector("span") ? btn.querySelector("span").textContent.trim() : "";
    const hook = HOOKS.find((h) => h.name === label);
    if (!hook) continue;
    hookBtns.push({ btn, hook });
    btn.addEventListener("click", () => {
      selected = hook; paintHooks(); paintSummary(); paintCta();
    });
  }
}

function paintHooks() {
  const base = "text-left p-3.5 rounded-[14px] border transition-colors cursor-pointer";
  for (const { btn, hook } of hookBtns) {
    const on = hook.id === selected.id;
    btn.className = base + (on
      ? " border-brand/50 bg-brand-tint"
      : " border-surface3 hover:border-surface3-hover hover:bg-surface1");
    const row = btn.querySelector("div");
    // The original markup hard-codes a "selected" label on the first hook. It
    // carries no .hl-sel class, so it was never cleared and two hooks could
    // read as selected at the same time.
    for (const s of btn.querySelectorAll("span")) {
      if (!s.classList.contains("hl-sel") && s.textContent.trim() === "selected") s.remove();
    }
    let badge = btn.querySelector(".hl-sel");
    if (on && !badge && row) {
      badge = document.createElement("span");
      badge.className = "hl-sel text-brand text-[12px]";
      badge.textContent = "selected";
      row.appendChild(badge);
    } else if (!on && badge) badge.remove();
  }
}

/* ---------------- image ---------------- */
// The slot used to show the file NAME as text, which is not a preview, so you
// could not tell whether you picked the right picture. Render the file.
let previewUrl = null;

function wireImage() {
  const add = $$("button").find((b) => b.textContent.trim() === "Add image");
  add && add.addEventListener("click", () => F.file && F.file.click());
  F.file && F.file.addEventListener("change", () => {
    const picked = (F.file.files && F.file.files[0]) || null;
    if (picked && !/^image\//.test(picked.type)) {
      toast("That file is not an image");
      F.file.value = ""; return;
    }
    if (picked && picked.size > 5 * 1024 * 1024) {
      toast("Image is over 5 MB. pump.fun will reject it");
      F.file.value = ""; return;
    }
    imageFile = picked;
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    if (!add) { paintCta(); return; }

    if (!imageFile) {
      add.innerHTML = '<span class="text-[12px] text-center leading-tight px-2">Add image</span>';
    } else {
      previewUrl = URL.createObjectURL(imageFile);
      add.innerHTML = "";
      const img = document.createElement("img");
      img.src = previewUrl;
      img.alt = imageFile.name;
      img.className = "w-full h-full object-cover";
      img.style.display = "block";
      add.appendChild(img);
      add.title = imageFile.name + " (click to replace)";
      add.classList.remove("border-dashed");
    }
    paintCta();
  });
}

/* ---------------- CTA ---------------- */
function ready() {
  return !!(F.name && F.name.value.trim() && F.symbol && F.symbol.value.trim() && imageFile);
}

function setGate(t) { if (gate) gate.textContent = t; }

/* The grinder pegs half the CPU for a long time, so it needs a visible switch
   rather than only an invisible background loop. */
function paintGrindToggle() {
  if (!gate || !gate.parentElement) return;
  let b = document.getElementById("hl-grind-toggle");
  if (!b) {
    b = document.createElement("button");
    b.id = "hl-grind-toggle";
    b.type = "button";
    b.style.cssText = "margin-top:6px;background:none;border:0;padding:0;" +
      "cursor:pointer;font-size:12.5px;text-decoration:underline;color:#8d8ba3";
    b.addEventListener("click", () => setGrind(!grindOn()));
    gate.parentElement.insertBefore(b, gate.nextSibling);
  }
  b.style.display = poolFull() ? "none" : "";
  b.textContent = grindOn() ? "Pause address search" : "Resume address search";
}

// Painting must never throw: paintCta runs during boot, so one bad read used
// to abort the whole module before the click handlers were live, which is
// exactly what left a dead grey button on a filled-in form.
function paintCta() { try { paintCtaInner(); } catch (e) { console.error("paintCta", e); } }

/* The grey button is Tailwind's disabled:opacity-40, so something sets the
   disabled attribute even though nothing in this file does. Instead of hunting
   the writer forever, refuse the attribute: strip it the instant it appears,
   and keep the stack of whoever set it in window.__hlDisabledBy. */
let guardArmed = false;

function armDisabledGuard() {
  if (guardArmed || !cta || typeof MutationObserver !== "function") return;
  guardArmed = true;
  new MutationObserver(() => {
    if (!cta.disabled && !cta.hasAttribute("disabled")) return;
    window.__hlDisabledBy = new Error("launch button disabled here").stack;
    console.warn(window.__hlDisabledBy);
    cta.disabled = false;
    cta.removeAttribute("disabled");
  }).observe(cta, { attributes: true, attributeFilter: ["disabled"] });
}

function paintCtaInner() {
  if (!cta) return;
  armDisabledGuard();
  cta.disabled = false;
  cta.removeAttribute("disabled");
  if (busy) return;
  if (!wallet.publicKey) {
    cta.textContent = "Connect wallet";
    setGate("Connect a wallet to launch.");
    paintExecutorNotice();
    return;
  }
  cta.textContent = "Launch";
  // Deliberately NOT disabled while fields are missing: a dead grey button
  // after picking an adha looks like the preset broke the page. Clicking with
  // something missing points at the field instead.
  cta.disabled = false;
  const miss = [];
  if (!F.name || !F.name.value.trim()) miss.push("a name");
  if (!F.symbol || !F.symbol.value.trim()) miss.push("a ticker");
  if (!imageFile) miss.push("an image");
  // Show the bank, so leaving this page open in the background is visibly
  // doing something rather than looking idle.
  const banked = poolSize();
  const bank = poolFull()
    ? " Bank full: " + POOL_MAX + " " + MINT_SUFFIX + " addresses ready, search stopped."
    : !grindOn()
      ? " Address search paused. " + banked + " of " + POOL_MAX + " banked."
      : banked
        ? " " + banked + " of " + POOL_MAX + " " + MINT_SUFFIX + " addresses banked."
        : " Searching for " + MINT_SUFFIX + " addresses in the background.";
  paintGrindToggle();
  setGate((miss.length
    ? "Still needs " + miss.join(", ") + "."
    : "Two signatures: the mint, then the fee split.") + bank);
  paintExecutorNotice();
}

/* pump.fun fee sharing pays wallet addresses only; it cannot call a program.
   Action legs (burn/holders/jackpot/topholders/reserve) therefore need an
   executor wallet that receives the SOL and performs the action. With none
   configured they pay the creator instead, which is NOT the hook's promise.
   Say so on the page rather than letting the split look automatic. */
const ACTION_KINDS = ["burn", "buyback", "holders", "jackpot", "topholders", "reserve"];

/* The sentence compiler on /hooks/custom hands its result over in localStorage
   and navigates here with ?hook=custom. Rebuild it into the same shape as a
   preset so every downstream path (summary, shareholders, registration) treats
   it identically. */
function customHook() {
  let legs;
  try { legs = JSON.parse(localStorage.getItem("adha.customHook.legs") || "null"); }
  catch { return null; }
  if (!Array.isArray(legs) || !legs.length || legs.length > 10) return null;

  // The compiler emits "topholders"; the server's leg vocabulary spells it
  // "top-holders". Unnormalised, registration failed with "unknown leg kind".
  legs = legs.map((l) => ({
    ...l,
    kind: l.kind === "topholders" ? "top-holders" : l.kind,
    bps: Number(l.bps),
  }));

  const ok = legs.every((l) => Number.isInteger(l.bps) && l.bps > 0 && l.bps <= 10000);
  if (!ok || legs.reduce((t, l) => t + l.bps, 0) !== 10000) return null;

  const sentence = (localStorage.getItem("adha.customHook.v1") || "").trim();
  return {
    id: "custom",
    name: "Your own adha",
    description: sentence || "Compiled from your sentence.",
    legs,
  };
}

function paintExecutorNotice() {
  let el = document.getElementById("hl-exec-notice");
  const actionBps = selected
    ? selected.legs.filter((l) => ACTION_KINDS.includes(l.kind))
        .reduce((s, l) => s + l.bps, 0)
    : 0;
  if (actionBps <= 0) { if (el) el.remove(); return; }
  const pct = (actionBps / 100).toFixed(actionBps % 100 ? 1 : 0);
  if (!el) {
    if (!cta || !cta.parentElement) return;
    el = document.createElement("div");
    el.id = "hl-exec-notice";
    cta.parentElement.insertBefore(el, cta);
  }

  if (!executor) {
    // No keeper reachable: the action share silently lands in the creator's wallet.
    el.className = "mt-4 rounded-[12px] border border-warn/30 bg-warn/10 p-3.5";
    el.innerHTML =
      '<p class="text-[13px] text-warn leading-relaxed"><strong>No executor is configured.</strong> ' +
      pct + "% of fees is set to legs that need something done with the SOL: buying, burning, " +
      "paying holders. pump.fun can only pay a wallet, so that share is sent to <em>your own " +
      "wallet</em> and nothing is bought or burned unless you do it yourself. The on-chain split " +
      "will not match what this adha says.</p>";
    return;
  }

  // Keeper exists. It is a hot wallet operated by Adha, so say so plainly rather
  // than letting the split look trustless.
  el.className = "mt-4 rounded-[12px] border border-surface3 bg-surface1 p-3.5";
  el.innerHTML =
    '<p class="text-[13px] text-neutral2 leading-relaxed">' + pct + "% of fees goes to legs that " +
    "need something done with the SOL. pump.fun can only pay a wallet, so that share is paid to " +
    "the <strong>Adha executor</strong>, which then performs the action on chain.<br>" +
    '<span class="text-neutral3">Executor <code class="text-[11.5px]">' +
    executor.slice(0, 6) + "\u2026" + executor.slice(-6) + "</code> is a hot wallet operated by " +
    "Adha. That share passes through it before it is spent. The remaining " +
    ((10000 - actionBps) / 100).toFixed((10000 - actionBps) % 100 ? 1 : 0) +
    "% is paid directly by pump.fun and never touches it.</span></p>";
}

async function onCta() {
  // Set while the vanity grinder is running: the button becomes a skip button
  // for that stretch, so a click must abort the search, not launch again.
  if (skipping) { skipping(); return; }
  if (busy) return;
  tLaunch = Date.now();
  if (!wallet.publicKey) {
    try { await wallet.connect(); } catch (e) { toast(e.message); }
    return;
  }
  if (!ready()) {
    // The button used to just sit there disabled, which reads as "the site is
    // broken" rather than "you skipped a field". Say what is missing and put
    // the cursor in it.
    const missing = !F.name || !F.name.value.trim() ? F.name
      : !F.symbol || !F.symbol.value.trim() ? F.symbol : null;
    if (missing) { missing.focus(); toast("Give the coin " + (missing === F.name ? "a name" : "a ticker") + " first"); }
    else { toast("Add an image for the coin first"); F.file && F.file.click(); }
    return;
  }
  busy = true;
  try { await runLaunch(); }
  catch (e) { console.error(e); toast(e.message || String(e)); }
  finally { busy = false; paintCta(); }
}

/* ---------------- RPC helpers ---------------- */
async function rpc(method, params) {
  const r = await fetch(api("api/rpc"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((x) => x.json());
  if (r.error) throw new Error(method + ": " + r.error.message);
  return r.result;
}

function b64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/* PumpPortal builds its transactions against its own RPC node. We broadcast
   through ours, and the two are not always on the same slot, so the node that
   simulates the send can reject a blockhash it has not caught up to yet, which
   surfaces as "Blockhash not found". Stamping the transaction with a blockhash
   from the same node that will simulate it removes the race. Must be called
   before any signature, since it changes the message being signed. */
async function withFreshBlockhash(tx) {
  // "confirmed", not "finalized": a finalized hash is roughly 13 seconds old
  // the moment it is issued, and the approval popup can easily eat the rest of
  // the ~60 second window, which surfaces as a blockhash error after the user
  // has already signed. The fetch and the send share one endpoint, so the
  // staleness that finalized was guarding against does not apply.
  const bh = await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
  tx.message.recentBlockhash = bh.value.blockhash;
  return tx;
}

/* Block until the RPC can see an account, so the wallet simulates against a
   state that already includes it. */
async function waitForAccount(addr) {
  for (let i = 0; i < 40; i++) {
    const r = await rpc("getAccountInfo", [addr, { encoding: "base64" }]);
    if (r && r.value) return true;
    await new Promise((x) => setTimeout(x, 250));
  }
  return false;
}

async function sendSigned(bytes) {
  // The transaction is already signed, so the blockhash cannot be restamped
  // here. If the node is simply behind, a short wait and a resend is enough.
  let sig = null, lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      sig = await rpc("sendTransaction", [
        b64(bytes), { encoding: "base64", maxRetries: 3, preflightCommitment: "confirmed" },
      ]);
      break;
    } catch (e) {
      lastErr = e;
      if (!/Blockhash not found/i.test((e && e.message) || "")) throw e;
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
  if (!sig) throw lastErr;
  for (let i = 0; i < 100; i++) {
    const st = (await rpc("getSignatureStatuses", [[sig]])).value[0];
    if (st && st.err) throw new Error("Transaction failed on chain: " + JSON.stringify(st.err));
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return sig;
    // Ask fast while it is likely to land, then back off.
    await new Promise((r) => setTimeout(r, i < 12 ? 300 : 1000));
  }
  throw new Error("Timed out waiting for confirmation: " + sig);
}

/* Grind a mint address ending in "adha", the way pump.fun's own addresses end
   in "pump". A 4-character base58 suffix is 58^4 = 11,316,496 addresses on
   average, so this runs one worker per core and still takes a minute or two.
   The old version tried this on the main thread with a 4 second budget, which
   is about a 0.4% chance, so in practice every mint came out non-vanity. */
export const MINT_SUFFIX = "adha";

/* A pool of ready "adha" addresses, kept in this browser.

   Grinding one takes a minute or two, so instead of doing it per launch we
   keep going in the background and bank the spares in localStorage. The next
   launch then costs nothing: take one off the stack and mint immediately.

   These seeds never leave the browser. Each one is a throwaway keypair whose
   only job is to co-sign its own create transaction, so the server never has
   to hold a private key for this to work. */
const POOL_KEY = "adha.mintpool.v1";
const GRIND_KEY = "adha.grind.on";
const POOL_MAX = 10;
let poolLoop = null, poolAbort = null, grindProgress = null, poolFailed = null;

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));

function poolRead() {
  try { const a = JSON.parse(localStorage.getItem(POOL_KEY) || "[]"); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function poolWrite(a) { try { localStorage.setItem(POOL_KEY, JSON.stringify(a.slice(0, POOL_MAX))); } catch {} }
function poolAdd(seedHex) { const a = poolRead(); a.push(seedHex); poolWrite(a); }
function poolTake() { const a = poolRead(); const s = a.shift(); if (s) poolWrite(a); return s || null; }
export function poolSize() { return poolRead().length; }
export function poolFull() { return poolRead().length >= POOL_MAX; }
export function grindOn() { return localStorage.getItem(GRIND_KEY) !== "0"; }
export function setGrind(on) {
  try { localStorage.setItem(GRIND_KEY, on ? "1" : "0"); } catch {}
  if (on) ensurePool();
  else if (poolAbort) poolAbort.abort();
  paintCta();
}

/* Top the pool up in the background. Runs on page open and again after a
   launch spends one, so the stack refills while nobody is waiting on it. */
export function prewarm() {
  ensurePool();
  import(WEB3).catch(() => {});
  import(PUMP).catch(() => {});
}

export function ensurePool() {
  if (poolLoop) return poolLoop;
  // Off by user choice, or the bank is already full: burning CPU either way
  // would just make the machine hot for nothing.
  if (!grindOn()) return null;
  if (poolRead().length >= POOL_MAX) return null;
  poolAbort = new AbortController();
  const sig = poolAbort.signal;
  poolLoop = (async () => {
    const { Keypair } = await import(WEB3);
    while (poolRead().length < POOL_MAX && !sig.aborted) {
      // One core is left alone so typing in the form stays smooth.
      const g = await grindMint(Keypair, {
        // Half the cores, not all-but-one: banking addresses must not make the
        // machine unusable. Halves the CPU cost, roughly doubles the time.
        cores: Math.max(1, Math.floor((navigator.hardwareConcurrency || 4) / 2)),
        signal: sig,
        onProgress: (n) => { if (grindProgress) grindProgress(n); },
      });
      if (sig.aborted) break;
      if (!g.vanity || !g.seed) { poolFailed = g.failed ? "The address grinder could not start in this browser." : null; break; }
      poolAdd(hex(g.seed));
    }
  })().catch(() => {}).finally(() => { poolLoop = null; });
  return poolLoop;
}

/* Wait for the pool to produce one, or for the user to press skip. */
function waitForPool(signal) {
  return new Promise((resolve) => {
    const tick = () => {
      const s = poolTake();
      if (s) return resolve(s);
      if (poolFailed) return resolve(null);
      if (signal && signal.aborted) return resolve(null);
      setTimeout(tick, 250);
    };
    tick();
  });
}

function grindMint(Keypair, { onProgress, signal, cores: want }) {
  const cores = Math.max(1, Math.min(want || navigator.hardwareConcurrency || 4, 12));
  const workers = [];
  let tried = 0;

  return new Promise((resolve) => {
    const done = (result) => {
      workers.forEach((w) => { try { w.postMessage({ cmd: "stop" }); w.terminate(); } catch {} });
      resolve(result);
    };
    // The user can always skip the wait and mint a plain address instead.
    if (signal) signal.addEventListener("abort", () => done({ kp: Keypair.generate(), vanity: false }));

    for (let i = 0; i < cores; i++) {
      let w;
      try {
        w = new Worker(api("mint-grinder.js?v=eee2e65c"), { type: "module" });
      } catch {
        return done({ kp: Keypair.generate(), vanity: false });
      }
      // Mark dead FIRST, and only give up once every worker is actually dead.
      // The old order asked an empty array, and [].every() is true.
      workers.push(w);
      w.onerror = () => {
        w.dead = true;
        if (workers.length && workers.every((x) => x.dead)) {
          done({ kp: Keypair.generate(), vanity: false, failed: true });
        }
      };
      w.onmessage = (e) => {
        if (e.data.found) {
          const sd = new Uint8Array(e.data.seed);
          done({ kp: Keypair.fromSeed(sd), vanity: true, seed: sd });
        } else {
          tried += e.data.tried;
          if (onProgress) onProgress(tried);
        }
      };
      w.postMessage({ cmd: "grind", suffix: MINT_SUFFIX });
    }
  });
}

/* Legs -> pump.fun shareholders. Native fee sharing pays wallet addresses only,
   so action legs (burn/holders/jackpot/reserve/...) are routed to the executor
   that performs them. With no executor configured they fall back to the
   creator's own wallet, and the UI says so rather than pretending otherwise.
   Duplicate addresses are merged: the program rejects duplicate shareholders. */
export function shareholdersFor(hook, creatorStr, exec) {
  const acc = new Map();
  for (const leg of hook.legs) {
    const direct = leg.kind === "creator" || leg.kind === "wallet";
    const addr = direct ? (leg.address || creatorStr) : (exec || creatorStr);
    acc.set(addr, (acc.get(addr) || 0) + leg.bps);
  }
  const out = [];
  acc.forEach((shareBps, address) => out.push({ address, shareBps }));
  const total = out.reduce((s, x) => s + x.shareBps, 0);
  if (total !== 10000) throw new Error("Shares must total 10000 bps, got " + total);
  if (out.length > 10) throw new Error("pump.fun allows at most 10 shareholders");
  if (out.some((x) => x.shareBps <= 0)) throw new Error("Zero-share recipient in split");
  return out;
}

/* ---------------- fee split ----------------
   The sharing program keeps a list of shareholders on chain and, on every
   update, wants each existing shareholder's account handed to it as a
   remaining account, in the same order. Guessing that list breaks the moment
   a config already exists (a retried launch, or a coin being fixed after the
   fact), so read it off chain instead. */
const FEES_PROGRAM = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";

function sharingConfigPda(PublicKey, mint) {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("sharing-config"), mint.toBytes()],
    new PublicKey(FEES_PROGRAM),
  )[0];
}

// SharingConfig layout: 8 discriminator, bump u8, version u8, status u8,
// mint 32, admin 32, admin_revoked bool, then a vec of (pubkey 32, bps u16).
export async function readSharingConfig(PublicKey, mint) {
  const pda = sharingConfigPda(PublicKey, mint);
  const res = await rpc("getAccountInfo", [pda.toBase58(), { encoding: "base64" }]);
  if (!res || !res.value) return null;
  const bin = atob(res.value.data[0]);
  const raw = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
  const dv = new DataView(raw.buffer);
  let o = 8 + 1 + 1 + 1 + 32 + 32 + 1;
  const n = dv.getUint32(o, true);
  o += 4;
  const holders = [];
  for (let i = 0; i < n; i++) {
    holders.push({
      address: new PublicKey(raw.slice(o, o + 32)),
      shareBps: dv.getUint16(o + 32, true),
    });
    o += 34;
  }
  return { pda, holders, adminRevoked: raw[8 + 1 + 1 + 1 + 32 + 32] === 1 };
}

// Build the instructions that attach a split, whether or not the config
// already exists. Returns [] when the split on chain already matches.
export async function splitInstructions(sdk, PublicKey, creator, mint, shares) {
  const cfg = await readSharingConfig(PublicKey, mint);
  const same = cfg && cfg.holders.length === shares.length &&
    cfg.holders.every((h, i) =>
      h.address.toBase58() === shares[i].address.toBase58() &&
      h.shareBps === shares[i].shareBps);
  // Order matters. A correct split is revoked ON PURPOSE — that is the coin
  // being made immutable, the good end state. Checking "revoked" first meant
  // every properly finished coin reported an error when its split was
  // re-examined, which reads as breakage. Nothing to do is not a failure.
  if (same) return [];
  if (cfg && cfg.adminRevoked) {
    throw new Error("The sharing config for this coin was revoked and cannot be changed");
  }

  const ixs = [];
  // The creator is the sole shareholder of a fresh config. Verified against
  // the one split that landed on chain, which used exactly this.
  let current = [creator];
  if (!cfg) {
    ixs.push(await sdk.PUMP_SDK.createFeeSharingConfig({ creator, mint, pool: null }));
  } else if (cfg.holders.length) {
    current = cfg.holders.map((h) => h.address);
  }
  ixs.push(await sdk.PUMP_SDK.updateFeeShares({
    authority: creator, mint, currentShareholders: current, newShareholders: shares,
  }));
  return ixs;
}

/* Attach (or repair) the split on a coin that is already minted. Used by the
   launches page when signature 2 was rejected during the original launch. */
export async function attachSplit(mintStr, hook) {
  const web3 = await import(WEB3);
  const sdk = await import(PUMP);
  const { Transaction, PublicKey } = web3;
  const creatorStr = wallet.publicKey;
  if (!creatorStr) throw new Error("Connect the creator wallet first");
  const creator = new PublicKey(creatorStr);
  const mint = new PublicKey(mintStr);
  const shares = shareholdersFor(hook, creatorStr, executor).map((s) => ({
    address: new PublicKey(s.address), shareBps: s.shareBps,
  }));
  const ixs = await splitInstructions(sdk, PublicKey, creator, mint, shares);
  if (!ixs.length) return { already: true };
  const bh = await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
  const tx = new Transaction({ feePayer: creator, recentBlockhash: bh.value.blockhash });
  ixs.forEach((i) => tx.add(i));
  const signed = await wallet.provider.signTransaction(tx);
  const sig = await sendSigned(signed.serialize());
  await fetch(api("api/launches/split"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mint: mintStr, policySig: sig }),
  }).catch(() => {});
  return { sig };
}

/* ---------------- the two-signature flow ---------------- */
async function runLaunch() {
  const step = (t) => { cta.textContent = t; };
  const creatorStr = wallet.publicKey;
  const name = F.name.value.trim();
  const symbol = F.symbol.value.trim().toUpperCase();

  // metadata -> pump.fun IPFS
  step("Uploading metadata...");
  const fd = new FormData();
  fd.append("file", imageFile);
  fd.append("name", name);
  fd.append("symbol", symbol);
  // The creator's own words first, then the hook, so the split travels with
  // the coin everywhere its metadata is read. Skip if they already wrote it.
  const own = F.desc ? F.desc.value.trim() : "";
  const line = hookLine(selected);
  const full = !line || own.includes("Creator-fee hook")
    ? own
    : (own ? own.replace(/\s*$/, "") + "\n\n" : "") + line;
  fd.append("description", full);
  fd.append("twitter", F.opt[0] ? F.opt[0].value.trim() : "");
  fd.append("telegram", F.opt[1] ? F.opt[1].value.trim() : "");
  fd.append("website", F.opt[2] ? F.opt[2].value.trim() : "");
  fd.append("showName", "true");
  const meta = await fetch(api("api/ipfs"), { method: "POST", body: fd }).then((r) => r.json());
  const uri = meta.metadataUri || meta.metadata_uri;
  if (!uri) throw new Error("Metadata upload failed: no URI returned");

  const web3 = await import(WEB3);
  const { Keypair, VersionedTransaction, Transaction, PublicKey } = web3;

  // Grinding an "adha" address takes a minute or two, so show real progress
  // and let the user bail out with a plain mint if they do not want to wait.
  // onCta disables the button for the duration of the launch, and a disabled
  // button never fires a click, so the skip has to re-enable it. skipping
  // tells onCta this click means "stop grinding", not "start another launch".
  // The button is a fixed width, so the counter goes in the line underneath
  // and the button keeps a label short enough to actually read.
  let ground;
  try {
    let seed = poolTake();
    if (!seed) {
      // Nothing banked yet: show the search and let the user bail out.
      ensurePool();
      skipping = () => { if (poolAbort) poolAbort.abort(); };
      grindProgress = (n) => {
        // Say on the button itself what skipping costs. "Skip the search"
        // read like skipping a wait; the coin actually comes out without the
        // suffix, which is the one thing people care about here.
        step("Skip (no " + MINT_SUFFIX + " suffix)");
        setGate("Looking for an address ending in " + MINT_SUFFIX + ": " +
                (n / 1e6).toFixed(2) + "M tried, " +
                Math.round((Date.now() - t0) / 1000) + "s. " +
                "Press the button to mint a plain address instead.");
      };
      seed = await waitForPool(poolAbort ? poolAbort.signal : null);
    }
    ground = seed
      ? { kp: Keypair.fromSeed(unhex(seed)), vanity: true }
      : { kp: Keypair.generate(), vanity: false };
  } finally {
    // A leftover skip handler swallows every later click, so clear it even
    // when the grinder throws.
    skipping = null;
    grindProgress = null;
    // Refill for the next launch now that this one is spent.
    setTimeout(ensurePool, 0);
  }
  if (!ground.vanity) {
    // A plain address is a visible downgrade, so it is never silent: the user
    // either skipped on purpose or the grinder failed, and both need saying.
    const why = poolFailed ? poolFailed + " " : "";
    if (!confirm(why + "This will mint a plain address, not one ending in " +
                 MINT_SUFFIX + ". Continue?")) {
      setGate("Launch cancelled. Leave this page open to bank " + MINT_SUFFIX + " addresses.");
      throw new Error("cancelled: no " + MINT_SUFFIX + " address available");
    }
    setGate("Minting with a plain address.");
  }
  const mintKp = ground.kp;
  console.log("[adha] address ready in", Date.now() - tLaunch, "ms",
    ground.vanity ? "(from bank)" : "(plain)");
  const mintStr = mintKp.publicKey.toBase58();

  // The fee-split config account is rent-paying, and it is funded by the
  // creator at signature 2. Running out there leaves a coin with no split and
  // costs a real mint, so the balance is checked before anything is spent.
  const SPLIT_RENT = 0.0082, MINT_COST = 0.0155;
  // devSol is declared further down, so read the field directly here rather
  // than referencing a binding that does not exist yet.
  const plannedDev = devBuySol();
  const need = MINT_COST + plannedDev + SPLIT_RENT;
  const lamports = await rpc("getBalance", [creatorStr]);
  const haveSol = (lamports && lamports.value != null ? lamports.value : 0) / 1e9;
  if (haveSol < need) {
    throw new Error(
      "Not enough SOL. This launch needs about " + need.toFixed(4) + " SOL (" +
      MINT_COST.toFixed(4) + " to mint" + (plannedDev ? ", " + plannedDev + " dev buy" : "") +
      ", " + SPLIT_RENT.toFixed(4) + " rent for the fee-split account) and the " +
      "wallet holds " + haveSol.toFixed(4) + " SOL. Top up and try again.");
  }

  // ---- signature 1: the mint ----
  step("Minting on pump.fun...");
  const res = await fetch(api("api/trade-local"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      publicKey: creatorStr,
      action: "create",
      tokenMetadata: { name, symbol, uri },
      mint: mintStr,
      denominatedInSol: "true",
      // Always 0 here: PumpPortal's create builder 400s on any non-zero dev
      // buy (verified 0.01/0.1/1 SOL with valid mint pubkeys). The dev buy
      // goes out as its own transaction below, which their buy builder accepts.
      amount: 0,
      slippage: 10,
      priorityFee: 0.0005,
      pool: "pump",
    }),
  });
  if (!res.ok) {
    // Surface what upstream actually said instead of a bare status code.
    let detail = "";
    try { detail = (await res.text()).trim().slice(0, 160); } catch {}
    throw new Error("Mint builder rejected the request (" + res.status +
      (detail ? "): " + detail : ")"));
  }
  const tx1 = VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
  await withFreshBlockhash(tx1);
  tx1.sign([mintKp]);
  const signed1 = await wallet.provider.signTransaction(tx1);
  const mintSig = await sendSigned(signed1.serialize());

  // Register the coin the moment the MINT confirms, not after the split.
  // Signature 2 can be rejected or blocked by the wallet, and when that
  // happened the launch disappeared from the site entirely even though the
  // coin existed on chain. The row is upserted again below with policySig.
  const record = {
    mint: mintStr, name, symbol, creator: creatorStr,
    hookId: selected.id, legs: selected.legs, cadence: "every-claim",
    mintSig, policySig: null,
  };
  const publish = () => fetch(api("api/launches"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(record),
  }).catch(() => {});
  const firstPublish = publish();

  // ---- optional signature: the dev buy, as its own transaction ----
  // It cannot ride along with the mint, so it goes out immediately after,
  // before the coin is discoverable. A failure here is NOT fatal: the coin
  // exists, and the buy can be repeated on pump.fun.
  const devSol = devBuySol();
  let devBuySig = null;
  if (devSol > 0) {
    step("Buying " + devSol.toFixed(4) + " SOL of your coin...");
    try {
      // The buy is built against the bonding curve, and an RPC node can lag a
      // second or two behind the mint it just confirmed. Firing immediately
      // makes the builder simulate against a node that cannot see the coin
      // yet, which surfaces as "Transaction simulation failed". Wait until the
      // mint account is actually visible before asking for the buy.
      for (let i = 0; i < 20; i++) {
        const acc = await rpc("getAccountInfo", [mintStr, { encoding: "base64" }]).catch(() => null);
        if (acc && acc.value) break;
        await new Promise((r) => setTimeout(r, 750));
      }
      const bres = await fetch(api("api/trade-local"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          publicKey: creatorStr,
          action: "buy",
          mint: mintStr,
          denominatedInSol: "true",
          amount: devSol,
          slippage: 15,
          priorityFee: 0.0005,
          pool: "pump",
        }),
      });
      if (!bres.ok) {
        let d = ""; try { d = (await bres.text()).trim().slice(0, 160); } catch {}
        throw new Error("buy builder said " + bres.status + (d ? ": " + d : ""));
      }
      const txB = VersionedTransaction.deserialize(new Uint8Array(await bres.arrayBuffer()));
      await withFreshBlockhash(txB);
      const signedB = await wallet.provider.signTransaction(txB);
      devBuySig = await sendSigned(signedB.serialize());
    } catch (e) {
      toast("Coin minted, but the dev buy failed: " + (e.message || e) +
            ". Buy on pump.fun instead", "warn", 8000);
    }
  }

  // ---- signature 2: the fee split, enforced by pump.fun's own program ----
  // A failure here is recoverable, not fatal: the coin exists and the split
  // can be attached later, so report it instead of throwing the launch away.
  let splitError = null;
  try {
    step("Writing the fee split...");
    await waitForAccount(mintStr);
    const sdk = await import(PUMP);
    const creator = new PublicKey(creatorStr);
    const mint = new PublicKey(mintStr);
    const shares = shareholdersFor(selected, creatorStr, executor).map((s) => ({
      address: new PublicKey(s.address),
      shareBps: s.shareBps,
    }));
    const ixs = await splitInstructions(sdk, PublicKey, creator, mint, shares);
    if (!ixs.length) throw new Error("The split on chain already matches this adha");
    const bh = await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
    const tx2 = new Transaction({ feePayer: creator, recentBlockhash: bh.value.blockhash });
    ixs.forEach((i) => tx2.add(i));
    const signed2 = await wallet.provider.signTransaction(tx2);
    record.policySig = await sendSigned(signed2.serialize());
    step("Publishing...");
    await firstPublish;
    await publish();
  } catch (e) {
    splitError = (e && e.message) || String(e);
    if (/insufficient lamports|custom program error: 0x1\b/i.test(splitError)) {
      splitError = "The wallet ran out of SOL before the fee split could be " +
        "written. The split account needs about " + SPLIT_RENT + " SOL of rent. " +
        "Top the wallet up, then attach the split from the launches page. [" +
        splitError + "]";
    } else if (/custom program error: 0x19[0-9a-f]{2}/i.test(splitError)) {
      splitError = "Your wallet's own safety check (Lighthouse) blocked the " +
        "transaction, usually because the chain moved between signing and " +
        "sending. Retry the split from the launches page. [" + splitError + "]";
    }
  }

  showResult({
    symbol, name, mint: mintStr, vanity: ground.vanity,
    hook: selected, mintSig, devBuySig, devSol,
    policySig: record.policySig, splitError,
  });
}

/* ---------------- launch result ----------------
   The launch used to end in a redirect plus a toast, so a partial launch left
   nothing on screen to read. This is a modal you can check yourself: every
   step, its real signature, and links out to verify on chain. */

function showResult(r) {
  const ok = !!r.policySig;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const sol = (sig) => "https://solscan.io/tx/" + sig;

  const line = (state, label, detail, href) =>
    '<li style="display:flex;gap:10px;align-items:flex-start;padding:9px 0;' +
      'border-bottom:1px solid rgba(18,15,25,.07)">' +
      '<span style="flex:none;width:16px;line-height:19px;font-size:13px;color:' +
        (state === "ok" ? "#1f9d55" : state === "fail" ? "#b4265a" : "#8d8ba3") + '">' +
        (state === "ok" ? "\u2713" : state === "fail" ? "\u00d7" : "\u2013") + "</span>" +
      '<span style="flex:1;min-width:0">' +
        '<span style="font-size:13.5px;color:#120f19">' + esc(label) + "</span>" +
        (detail ? '<span style="display:block;font-size:12px;color:#6b6880;' +
          'word-break:break-all;margin-top:2px">' + esc(detail) + "</span>" : "") +
        (href ? '<a href="' + href + '" target="_blank" rel="noreferrer" ' +
          'style="display:inline-block;margin-top:3px;font-size:12px;color:#6f5bd6">' +
          "view transaction \u2197</a>" : "") +
      "</span></li>";

  let rows = line("ok", "Coin minted on pump.fun",
    r.vanity ? null : "non-vanity mint address", sol(r.mintSig));

  if (r.devSol > 0) {
    rows += r.devBuySig
      ? line("ok", "Dev buy of " + r.devSol.toFixed(4) + " SOL", null, sol(r.devBuySig))
      : line("fail", "Dev buy did not go through", "Buy on pump.fun instead.");
  }

  rows += ok
    ? line("ok", "Fee split written: " + r.hook.name, null, sol(r.policySig))
    : line("fail", "Fee split not attached",
        (r.splitError || "").slice(0, 180) +
        ". The coin is live and its address is fine; only the fee split is " +
        "missing, so fees go to you by default. You can attach it from the " +
        "launches page.");

  const wrap = document.createElement("div");
  wrap.style.cssText =
    "position:fixed;inset:0;z-index:9999;background:rgba(18,15,25,.42);" +
    "display:flex;align-items:center;justify-content:center;padding:20px";
  wrap.innerHTML =
    '<div style="background:#fff;border-radius:18px;max-width:470px;width:100%;' +
      'padding:26px 24px 20px;box-shadow:0 24px 60px rgba(18,15,25,.28);' +
      'max-height:88vh;overflow:auto">' +
      '<div style="font-size:20px;font-weight:600;letter-spacing:-.01em;color:#120f19">' +
        (ok ? esc(r.symbol) + " is live." : esc(r.symbol) + " minted, with one problem.") +
      "</div>" +
      '<div style="font-size:13px;color:#6b6880;margin-top:5px">' +
        (ok ? "Both signatures landed. Check any of them yourself below."
            : "The coin exists on chain. The adha did not get attached.") +
      "</div>" +
      '<div style="margin-top:16px;padding:11px 12px;border-radius:11px;background:#f4f3f8">' +
        '<div style="font-size:11.5px;color:#8d8ba3">Mint address</div>' +
        '<div style="font-size:12.5px;color:#120f19;word-break:break-all;margin-top:3px;' +
          'font-family:ui-monospace,SFMono-Regular,Menlo,monospace">' + esc(r.mint) + "</div>" +
      "</div>" +
      '<ul style="list-style:none;padding:0;margin:14px 0 0">' + rows + "</ul>" +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:18px">' +
        '<a href="https://pump.fun/coin/' + esc(r.mint) + '" target="_blank" rel="noreferrer" ' +
          'style="flex:1;min-width:130px;text-align:center;padding:10px;border-radius:10px;' +
          'background:#120f19;color:#fff;font-size:13px;text-decoration:none">Open on pump.fun \u2197</a>' +
        '<a href="https://solscan.io/token/' + esc(r.mint) + '" target="_blank" rel="noreferrer" ' +
          'style="flex:1;min-width:130px;text-align:center;padding:10px;border-radius:10px;' +
          'border:1px solid rgba(18,15,25,.12);color:#120f19;font-size:13px;text-decoration:none">Solscan \u2197</a>' +
      "</div>" +
      '<div style="display:flex;gap:8px;margin-top:8px">' +
        '<button data-a="copy" style="flex:1;padding:10px;border-radius:10px;cursor:pointer;' +
          'border:1px solid rgba(18,15,25,.12);background:none;font-size:13px;color:#120f19">Copy mint</button>' +
        '<a href="' + api("launches") + '" style="flex:1;text-align:center;padding:10px;' +
          'border-radius:10px;border:1px solid rgba(18,15,25,.12);color:#120f19;font-size:13px;' +
          'text-decoration:none">My launches</a>' +
      "</div>" +
      '<button data-a="close" style="width:100%;margin-top:10px;padding:9px;border:0;' +
        'background:none;cursor:pointer;font-size:12.5px;color:#8d8ba3">Close</button>' +
    "</div>";

  wrap.addEventListener("click", async (ev) => {
    const a = ev.target.dataset && ev.target.dataset.a;
    if (a === "copy") {
      try { await navigator.clipboard.writeText(r.mint); toast("Mint address copied", "ok", 2000); }
      catch { toast("Could not copy"); }
      return;
    }
    if (a === "close" || ev.target === wrap) wrap.remove();
  });
  document.body.appendChild(wrap);
}

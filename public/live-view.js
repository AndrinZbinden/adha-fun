/* Live — every coin launched through adha, newest and biggest first.
   Laid out like a token terminal, but the number that leads each card is the
   split, not the price. The market figures come from pump.fun and the split
   status is read off chain, so a coin whose split never landed says so here
   instead of quietly looking like all the others. */

const LABELS = {
  buyback: "Buy back", burn: "Buy & burn", holders: "Holder rewards",
  jackpot: "Jackpot", topholders: "Top holders", "top-holders": "Top holders",
  wallet: "Wallet", creator: "Creator", reserve: "Reserve buy",
};
const PALETTE = ["#6f5bd6", "#120f19", "#c8b8ff", "#8d8ba3", "#e4dcff"];

/* Pinned to the top of the grid regardless of market cap. Set to "" to let the
   page sort purely on size again. */
const FEATURED = "5zqHzNQMyX811qRvc5YJ4tP2N47NY7VbdMJBQqh3adha";

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const short = (m) => String(m || "").slice(0, 4) + "\u2026" + String(m || "").slice(-4);

function usd(n) {
  if (typeof n !== "number" || !isFinite(n)) return null;
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(2) + "K";
  return "$" + n.toFixed(0);
}
function ago(ts) {
  const s = Math.max(1, Math.floor((Date.now() - Number(ts || 0)) / 1000));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

/* One row of coloured segments, the same visual language the launch page and
   My launches already use for a split. */
function bar(legs) {
  return '<div class="lv-bar">' + legs.map((l, i) =>
    '<i title="' + esc(Math.round(l.bps / 100) + "% " + (LABELS[l.kind] || l.kind)) +
    '" style="width:' + (l.bps / 100) + "%;background:" + PALETTE[i % PALETTE.length] + '"></i>'
  ).join("") + "</div>";
}

function card(x) {
  const legs = Array.isArray(x.legs) ? x.legs : [];
  const lead = legs.slice().sort((a, b) => b.bps - a.bps)[0];
  const kind = lead ? (LABELS[lead.kind] || lead.kind) : "\u2014";
  const split = legs.map((l) => Math.round(l.bps / 100) + "% " + (LABELS[l.kind] || l.kind)).join(" \u00b7 ");
  const custom = x.hookId === "custom";
  return '' +
  '<article class="lv-card" data-hook="' + esc(x.hookId || "") + '" data-mint="' + esc(x.mint) + '">' +
    '<span data-art="' + esc(x.mint) + '" class="lv-art"></span>' +
    '<div class="lv-top">' +
      '<span data-logo="' + esc(x.mint) + '" class="lv-logo"></span>' +
      '<div class="lv-actions">' +
        '<button class="lv-ico" data-copy="' + esc(x.mint) + '" title="Copy the mint address">CA</button>' +
        '<a class="lv-ico" target="_blank" rel="noreferrer" title="Open on pump.fun" ' +
          'href="https://pump.fun/coin/' + esc(x.mint) + '">\u2197</a>' +
      "</div>" +
    "</div>" +
    '<a class="lv-sym" data-sym="' + esc(x.mint) + '" target="_blank" rel="noreferrer" ' +
      'href="https://pump.fun/coin/' + esc(x.mint) + '">' +
      (x.symbol ? "$" + esc(x.symbol) : esc(short(x.mint))) + "</a>" +
    '<div class="lv-name" data-name="' + esc(x.mint) + '">' +
      esc(x.name || "Launching today") + "</div>" +
    '<div data-mcap="' + esc(x.mint) + '" class="lv-mcap lv-dim">\u2014</div>' +
    '<div class="lv-tags">' +
      (x.mint === FEATURED ? '<span class="lv-tag lv-tag-f">Featured</span>' : "") +
      '<span data-lock="' + esc(x.mint) + '"></span>' +
      '<span class="lv-tag lv-tag-b">' + esc(kind) + "</span>" +
      (custom ? '<span class="lv-tag">Custom</span>' : "") +
      '<span class="lv-tag lv-tag-q" title="' + esc(split) + '">' + legs.length +
        (legs.length === 1 ? " leg" : " legs") + "</span>" +
    "</div>" +
    bar(legs) +
    '<div class="lv-foot">' +
      '<span data-holders="' + esc(x.mint) + '" class="lv-dim">' + esc(ago(x.createdAt)) + "</span>" +
      '<span data-split="' + esc(x.mint) + '" class="lv-dim">checking the split\u2026</span>' +
    "</div>" +
  "</article>";
}

/* The one thing this page must not do is flatter a broken coin. A missing
   sharing config means pump.fun pays 100% to the creator and none of the
   legs below it ever run, so it is stated on the card. */
function paintSplit(root, mint, h) {
  const el = root.querySelector('[data-split="' + CSS.escape(mint) + '"]');
  if (!el) return;
  if (!h || h.status === "unknown") { el.textContent = "split status unavailable"; return; }
  if (h.status === "ok") {
    el.className = "lv-ok";
    // No sharing config is the correct state for a dev-keeps-everything coin:
    // pump.fun pays the creator 100% by default, so there is nothing to route.
    el.textContent = h.viaDefault
      ? "\u2713 dev keeps 100% \u00b7 pump.fun default"
      : "\u2713 split live \u00b7 " + Math.round((h.executorBps || 0) / 100) + "% routed" +
        (h.revoked ? " \u00b7 locked" : "");
    return;
  }
  el.className = "lv-bad";
  el.textContent = h.status === "wrong" ? "\u26a0 split does not match" : "\u26a0 no split on chain";
}

/* Only shown while the escrow still holds the tokens. The server re-reads that
   account, so if the dev ever withdraws, this vanishes on the next check. */
function paintLock(root, mint, lock) {
  const el = root.querySelector('[data-lock="' + CSS.escape(mint) + '"]');
  if (!el) return;
  if (!lock || lock.status !== "locked") { el.innerHTML = ""; return; }
  const pct = lock.pct >= 1 ? Math.round(lock.pct) : Number(lock.pct).toFixed(2);
  const href = lock.sig ? "https://solscan.io/tx/" + encodeURIComponent(lock.sig)
                        : "https://solscan.io/account/" + encodeURIComponent(lock.escrow);
  el.innerHTML = '<a class="lv-tag lv-tag-l" target="_blank" rel="noreferrer" href="' + href +
    '" title="' + esc(lock.uiAmount ? Math.round(lock.uiAmount).toLocaleString() + " tokens held in " +
      (lock.program || "an") + " escrow \u2014 click to verify on Solscan" : "verify on Solscan") +
    '">\ud83d\udd12 dev locked \u00b7 ' + pct + '%</a>';
}

async function getJson(u) {
  const r = await fetch(u, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
const chunk = (a, n) => a.reduce((o, v, i) => (i % n ? o[o.length - 1].push(v) : o.push([v]), o), []);

export async function initLive() {
  const root = document.querySelector("[data-live]");
  if (!root) return;
  const grid = root.querySelector("[data-grid]");
  const count = root.querySelector("[data-count]");
  const chips = root.querySelector("[data-chips]");

  let coins = [];
  try {
    coins = (await getJson("api/launches?limit=500")).launches || [];
  } catch {
    grid.innerHTML = '<p class="lv-empty">The registry did not answer. Refresh in a moment.</p>';
    return;
  }
  if (!coins.length) {
    // The counter is set here too, otherwise an empty registry leaves it
    // reading "loading..." for good.
    count.textContent = "0 coins";
    grid.innerHTML = '<p class="lv-empty">No coins yet. The first one launched here shows up on this page.</p>';
    return;
  }

  const market = {};
  let filter = "all";

  function render() {
    // Biggest first once the market data lands, newest first before that, so
    // the page is never sorted on a number half the cards do not have yet.
    const list = coins
      .filter((c) => filter === "all" ||
        (filter === "custom" ? c.hookId === "custom" : (c.legs || []).some((l) => l.kind === filter)))
      .sort((a, b) => {
        // The featured coin leads the grid whatever its size.
        if (a.mint === FEATURED) return -1;
        if (b.mint === FEATURED) return 1;
        const ma = market[a.mint]?.mcapUsd || 0, mb = market[b.mint]?.mcapUsd || 0;
        return mb - ma || b.createdAt - a.createdAt;
      });
    count.textContent = list.length + (list.length === 1 ? " coin" : " coins");
    grid.innerHTML = list.length ? list.map(card).join("")
      : '<p class="lv-empty">Nothing launched with that leg yet.</p>';
    for (const c of list) paint(c.mint);
  }

  function paint(mint) {
    const m = market[mint];
    if (!m) return;
    const q = (a) => grid.querySelector("[data-" + a + '="' + CSS.escape(mint) + '"]');
    if (m.image) {
      // pump.fun serves whatever image URI the coin's creator uploaded, so this
      // string is attacker-controlled. Stripping quotes was not enough: a ")"
      // closes url() early and everything after it lands as live CSS. Only
      // http(s) is allowed through, and it is percent-encoded on the way in.
      const raw = String(m.image);
      const safe = /^https?:\/\//i.test(raw) ? encodeURI(raw).replace(/[()'"\\]/g, encodeURIComponent) : "";
      const url = safe ? "url('" + safe + "')" : "";
      const logo = q("logo"), art = q("art");
      if (url && logo) logo.style.backgroundImage = url;
      if (url && art) art.style.backgroundImage = url;
    }
    const sym = q("sym"), nm = q("name");
    if (sym && m.symbol) sym.textContent = "$" + m.symbol;
    if (nm && m.name) nm.textContent = m.name;
    const mc = q("mcap");
    if (mc && usd(m.mcapUsd)) { mc.textContent = usd(m.mcapUsd); mc.className = "lv-mcap"; }
    const hd = q("holders");
    if (hd && typeof m.holders === "number") {
      hd.textContent = m.holders + (m.holders === 1 ? " holder" : " holders");
    }
    if (m.health) paintSplit(grid, mint, m.health);
    paintLock(grid, mint, m.health && m.health.lock);
  }

  render();

  // Market data eight at a time and split health twenty-four at a time, which
  // is exactly what each endpoint accepts, then repaint as each batch lands.
  const mints = coins.map((c) => c.mint);
  (async () => {
    for (const g of chunk(mints, 8)) {
      try {
        const { market: mk } = await getJson("api/market?mints=" + g.join(","));
        for (const k of Object.keys(mk || {})) market[k] = { ...(market[k] || {}), ...mk[k] };
      } catch {}
      for (const k of g) paint(k);
    }
    render();
  })();
  (async () => {
    for (const g of chunk(mints, 24)) {
      try {
        const { health } = await getJson("api/launches/health?mints=" + g.join(","));
        for (const k of Object.keys(health || {})) {
          market[k] = { ...(market[k] || {}), health: health[k] };
          paintSplit(grid, k, health[k]);
          paintLock(grid, k, health[k] && health[k].lock);
        }
      } catch {
        for (const k of g) paintSplit(grid, k, null);
      }
    }
  })();

  chips.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-f]");
    if (!b) return;
    filter = b.getAttribute("data-f");
    chips.querySelectorAll("button[data-f]").forEach((x) =>
      x.classList.toggle("on", x === b));
    render();
  });

  grid.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-copy]");
    if (!b) return;
    try {
      await navigator.clipboard.writeText(b.getAttribute("data-copy"));
      const t = b.textContent; b.textContent = "\u2713";
      setTimeout(() => { b.textContent = t; }, 1200);
    } catch {}
  });
}

initLive();

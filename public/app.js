// Adha app layer: reveal animations, wallet connect, page wiring.
// No build step, no npm: plain ES modules; heavy deps are lazy-loaded from a
// CDN only at the moment a launch is actually signed.

const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const short = (a) => a.slice(0, 4) + "\u2026" + a.slice(-4);

/* ------------------------------------------------------------------ *
 * 1. Reveal-on-scroll.
 *    app.css ships .reveal-up{opacity:0} and .reveal.is-shown{opacity:1}.
 *    The original bundle added is-shown via IntersectionObserver; without
 *    that observer the homepage renders fully invisible.
 * ------------------------------------------------------------------ */
function initReveal() {
  const els = $$(".reveal");
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced || typeof IntersectionObserver === "undefined") {
    els.forEach((e) => e.classList.add("is-shown"));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) {
          en.target.classList.add("is-shown");
          io.unobserve(en.target);
        }
      }
    },
    { threshold: 0.08, rootMargin: "0px 0px -10% 0px" }
  );
  els.forEach((e) => io.observe(e));
}

/* Hero copy fades in on mount. Excludes hover-driven elements, which are
   legitimately opacity-0 until hovered. */
function initFadeIn() {
  $$(".transition-opacity.opacity-0")
    .filter((e) => !String(e.className).includes("group-hover"))
    .forEach((el, i) =>
      setTimeout(() => {
        el.classList.remove("opacity-0");
        el.classList.add("opacity-100");
      }, 60 + i * 70)
    );
}

/* ------------------------------------------------------------------ *
 * 1a. Sticky header: the bar tracks the scroll, and a full-bleed blur
 *     panel behind it fades in once the page moves, so it blends into
 *     the hero instead of sitting on a hard band.
 * ------------------------------------------------------------------ */
function initStickyHeader() {
  const bar = document.querySelector("header.hl-bar");
  if (!bar) return;
  // On the homepage the hero carries its own rounded nav, so this bar is
  // taken out of the flow and only appears once that nav has scrolled off.
  const hero = document.querySelector("section.h-dvh");
  if (hero) bar.classList.add("hl-float");
  const trigger = 8;

  let on = null;
  const sync = () => {
    const next = window.scrollY > trigger;
    if (next !== on) {
      on = next;
      bar.classList.toggle("is-stuck", next);
    }
  };
  sync();
  addEventListener("scroll", () => requestAnimationFrame(sync), { passive: true });
}

/* ------------------------------------------------------------------ *
 * 1b. FAQ accordion.
 *     Markup ships each answer in a grid whose rows animate 0fr -> 1fr,
 *     and a "+" glyph that becomes an "x" at 45deg. Static HTML alone
 *     leaves every answer collapsed forever.
 * ------------------------------------------------------------------ */
function initFaq() {
  const items = $$('button[aria-expanded]').map((btn) => ({
    btn,
    panel: btn.nextElementSibling,
    icon: btn.lastElementChild,
    label: btn.firstElementChild,
  })).filter((it) => it.panel && it.panel.classList.contains("grid"));
  if (!items.length) return;

  const set = (it, open) => {
    it.btn.setAttribute("aria-expanded", open ? "true" : "false");
    it.panel.style.gridTemplateRows = open ? "1fr" : "0fr";
    if (it.icon) {
      it.icon.style.transform = open ? "rotate(45deg)" : "rotate(0deg)";
      it.icon.classList.toggle("text-brand", open);
      it.icon.classList.toggle("text-neutral3", !open);
    }
    if (it.label) it.label.classList.toggle("text-brand", open);
  };

  items.forEach((it) => {
    set(it, false);
    it.btn.addEventListener("click", () => {
      const open = it.btn.getAttribute("aria-expanded") !== "true";
      items.forEach((o) => set(o, o === it ? open : false)); // one at a time
    });
  });
}

/* ------------------------------------------------------------------ *
 * 2. Wallet: Phantom / Solflare via the injected provider.
 * ------------------------------------------------------------------ */
export const wallet = {
  provider: null,
  publicKey: null,
  name: null,
  listeners: new Set(),

  onChange(fn) { this.listeners.add(fn); fn(this); },
  emit() { this.listeners.forEach((fn) => fn(this)); },

  detect() {
    const out = [];
    const ph = (window.phantom && window.phantom.solana) ||
               (window.solana && window.solana.isPhantom ? window.solana : null);
    if (ph) out.push({ name: "Phantom", provider: ph });
    if (window.solflare && window.solflare.isSolflare) {
      out.push({ name: "Solflare", provider: window.solflare });
    }
    if (!out.length && window.solana) out.push({ name: "Wallet", provider: window.solana });
    return out;
  },

  async connect() {
    const found = this.detect();
    if (!found.length) {
      window.open("https://phantom.app/download", "_blank", "noopener");
      throw new Error("No Solana wallet detected. Install Phantom, then reload.");
    }
    const pick = found[0];
    const res = await pick.provider.connect();
    this.provider = pick.provider;
    this.name = pick.name;
    this.publicKey = ((res && res.publicKey) || pick.provider.publicKey).toString();
    if (pick.provider.on) {
      pick.provider.on("disconnect", () => this.reset());
      pick.provider.on("accountChanged", (pk) => {
        this.publicKey = pk ? pk.toString() : null;
        this.emit();
      });
    }
    this.emit();
    return this.publicKey;
  },

  async disconnect() {
    try { if (this.provider) await this.provider.disconnect(); } catch {}
    this.reset();
  },

  reset() { this.provider = null; this.publicKey = null; this.name = null; this.emit(); },

  /* Reconnect silently if the site is already trusted. */
  async eager() {
    const found = this.detect();
    if (!found.length) return;
    try {
      const res = await found[0].provider.connect({ onlyIfTrusted: true });
      this.provider = found[0].provider;
      this.name = found[0].name;
      this.publicKey = ((res && res.publicKey) || found[0].provider.publicKey).toString();
      this.emit();
    } catch { /* not trusted yet, stay disconnected */ }
  },
};

/* Header "Connect wallet" buttons only. Page-level CTAs that share the same
   label (the launch form's submit) are owned by their own page module. */
function initWalletButtons() {
  const buttons = $$("header button").filter((b) => b.textContent.trim() === "Connect wallet");
  if (!buttons.length) return;
  buttons.forEach((btn) => {
    btn.dataset.hlWallet = "1";
    btn.addEventListener("click", async (ev) => {
      // Connected: the pill opens a menu instead of disconnecting instantly,
      // so switching wallets is a deliberate act rather than a misclick.
      if (wallet.publicKey) { ev.stopPropagation(); return toggleWalletMenu(btn); }
      closeWalletMenu();
      btn.disabled = true;
      const prev = btn.textContent;
      btn.textContent = "Connecting\u2026";
      try {
        await wallet.connect();
      } catch (e) {
        btn.textContent = prev;
        toast(e.message || "Could not connect");
      } finally {
        btn.disabled = false;
      }
    });
  });
  wallet.onChange((w) => {
    if (!w.publicKey) closeWalletMenu();
    $$('button[data-hl-wallet="1"]').forEach((b) => {
      b.textContent = w.publicKey ? short(w.publicKey) : "Connect wallet";
      b.title = w.publicKey ? w.name + " account menu" : "";
    });
  });
}

/* Account menu: full address, copy, disconnect. Anchored under the pill. */
let walletMenu = null;

function closeWalletMenu() {
  if (walletMenu) { walletMenu.remove(); walletMenu = null; }
}

function toggleWalletMenu(btn) {
  if (walletMenu) return closeWalletMenu();

  const m = document.createElement("div");
  walletMenu = m;
  const r = btn.getBoundingClientRect();
  m.style.cssText =
    "position:fixed;z-index:9998;min-width:236px;padding:6px;border-radius:14px;" +
    "background:#fff;border:1px solid rgba(18,15,25,.08);" +
    "box-shadow:0 12px 34px rgba(18,15,25,.14);font-size:13px;" +
    "top:" + (r.bottom + 8) + "px;right:" + Math.max(8, innerWidth - r.right) + "px;";
  // wallet.name and wallet.publicKey come from the injected provider, i.e. from
  // outside this page. Everything else in the codebase escapes before it hits
  // innerHTML; this one spot did not. A malicious or spoofed extension could
  // name itself with markup and get script into the page.
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  m.innerHTML =
    '<div style="padding:9px 10px 10px">' +
      '<div style="font-size:11.5px;color:#8d8ba3;letter-spacing:.02em">' +
        esc(wallet.name || "Wallet") + "</div>" +
      '<div style="margin-top:3px;font-size:12px;color:#120f19;word-break:break-all;' +
        'font-family:ui-monospace,SFMono-Regular,Menlo,monospace">' +
        esc(wallet.publicKey) + "</div>" +
    "</div>" +
    '<button data-act="copy" style="display:block;width:100%;text-align:left;padding:9px 10px;' +
      'border-radius:9px;background:none;border:0;cursor:pointer;color:#120f19">Copy address</button>' +
    '<button data-act="disconnect" style="display:block;width:100%;text-align:left;padding:9px 10px;' +
      'border-radius:9px;background:none;border:0;cursor:pointer;color:#b4265a">Disconnect</button>';

  for (const b of m.querySelectorAll("button")) {
    b.addEventListener("mouseenter", () => { b.style.background = "#f4f3f8"; });
    b.addEventListener("mouseleave", () => { b.style.background = "none"; });
  }
  m.addEventListener("click", async (ev) => {
    const act = ev.target.dataset && ev.target.dataset.act;
    if (!act) return;
    ev.stopPropagation();
    if (act === "copy") {
      try {
        await navigator.clipboard.writeText(wallet.publicKey);
        toast("Address copied", "ok", 2200);
      } catch { toast("Could not copy"); }
    } else {
      await wallet.disconnect();
      toast("Wallet disconnected. Connect again to switch accounts", "ok", 3200);
    }
    closeWalletMenu();
  });

  document.body.appendChild(m);
  setTimeout(() => {
    addEventListener("click", closeWalletMenu, { once: true });
    addEventListener("keydown", function esc(e) {
      if (e.key === "Escape") { closeWalletMenu(); removeEventListener("keydown", esc); }
    });
  }, 0);
  addEventListener("scroll", closeWalletMenu, { once: true, passive: true });
}

/* ------------------------------------------------------------------ *
 * 3. Toast
 * ------------------------------------------------------------------ */
let toastEl;
export function toast(msg, kind = "err", ms = 6000) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.style.cssText =
      "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:9999;" +
      "max-width:min(560px,92vw);padding:12px 16px;border-radius:14px;font-size:14px;" +
      "line-height:1.45;box-shadow:0 8px 30px rgba(18,15,25,.18);transition:opacity .25s;";
    document.body.appendChild(toastEl);
  }
  toastEl.style.background = kind === "ok" ? "#11131a" : "#2a1220";
  toastEl.style.color = "#fff";
  toastEl.textContent = msg;
  toastEl.style.opacity = "1";
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => { toastEl.style.opacity = "0"; }, ms);
}

/* ------------------------------------------------------------------ *
 * 4. Page routing
 * ------------------------------------------------------------------ */
function pageName() {
  const p = location.pathname.replace(/\/+$/, "");
  if (/\/hooks\/custom$/.test(p)) return "custom";
  if (/\/hooks$/.test(p)) return "hooks";
  if (/\/launch$/.test(p)) return "launch";
  if (/\/launches$/.test(p)) return "launches";
  return "home";
}

async function boot() {
  window.__hlBoot = true;
  initStickyHeader();
  initReveal();
  initFadeIn();
  initFaq();
  initWalletButtons();
  wallet.eager();

  const page = pageName();
  try {
    if (page === "custom") {
      const m = await import(new URL("hooks-custom.js?v=56a8b25c", document.baseURI).href);
      m.initCustom();
      import(new URL("launch-flow.js?v=c0eb4639", document.baseURI).href)
        .then((lf) => lf.prewarm()).catch(() => {});
    } else if (page === "hooks") {
      const m = await import(new URL("hooks-list.js?v=9c5ebe6e", document.baseURI).href);
      await m.initHooksList();
      import(new URL("launch-flow.js?v=c0eb4639", document.baseURI).href)
        .then((lf) => lf.prewarm()).catch(() => {});
    } else if (page === "launch") {
      const m = await import(new URL("launch-flow.js?v=c0eb4639", document.baseURI).href);
      await m.initLaunch();
    } else if (page === "launches") {
      const m = await import(new URL("launches-view.js?v=908cb055", document.baseURI).href);
      await m.initLaunches();
    }
  } catch (e) {
    console.error("page module failed:", e);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

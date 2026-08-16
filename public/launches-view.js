// Launches page: renders the real server-side index.
// The original shipped a localStorage store keyed "adha.launches.v1", so
// every visitor saw a different "public" list. This reads the shared index.

import { wallet } from "./app.js";

const api = (p) => new URL(p, document.baseURI).toString();
const short = (a) => a.slice(0, 4) + "\u2026" + a.slice(-4);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const usd = (n) => n >= 1e6 ? "$" + (n / 1e6).toFixed(2) + "M"
  : n >= 1e3 ? "$" + (n / 1e3).toFixed(1) + "K"
  : "$" + n.toFixed(2);

let LABELS = {}, HOOKS = [];

export async function initLaunches() {
  try {
    const cfg = await fetch(api("hooks.json")).then((r) => r.json());
    LABELS = cfg.legLabels || {};
    HOOKS = cfg.hooks || [];
  } catch {}

  const main = document.querySelector("main");
  if (!main) return;
  const hero = main.querySelector("div.text-center");
  const list = main.querySelector("div.max-w-\\[1120px\\]") ||
               main.querySelectorAll("div")[main.querySelectorAll("div").length - 1];
  if (!list) return;

  const render = async () => {
    if (!wallet.publicKey) {
      list.innerHTML = "";
      if (hero) hero.style.display = "";
      return;
    }
    list.innerHTML = '<p class="text-[13.5px] text-neutral2 text-center">Loading\u2026</p>';
    let rows = [];
    try {
      const r = await fetch(api("api/launches?creator=" + encodeURIComponent(wallet.publicKey)));
      rows = (await r.json()).launches || [];
    } catch {
      list.innerHTML = '<p class="text-[13.5px] text-neutral2 text-center">Could not reach the index.</p>';
      return;
    }
    if (!rows.length) {
      // Connected, just nothing launched yet, which is a different state from
      // "not connected", and the hero's connect prompt is wrong here.
      if (hero) hero.style.display = "none";
      list.innerHTML =
        '<div class="text-center py-16">' +
          '<h1 class="text-[30px] semi tracking-tight">You have no launches yet.</h1>' +
          '<p class="text-[14px] text-neutral2 mt-2.5">Pick an adha, set your split, and launch your first coin.</p>' +
          '<a href="' + api("launch") + '" class="inline-flex items-center justify-center mt-6 h-[42px] px-5 rounded-full bg-neutral1 text-white text-[13.5px] medium hover:opacity-90 transition-opacity">Launch now</a>' +
          '<div class="mt-4"><a href="' + api("hooks") + '" class="text-[13px] text-brand hover:text-brand-hover transition-colors">Browse the ten adhas</a></div>' +
        "</div>";
      return;
    }
    if (hero) hero.style.display = "none";
    list.innerHTML =
      '<h1 class="text-[30px] semi tracking-tight mb-6">Your launches</h1>' +
      '<div class="grid gap-3">' + rows.map(card).join("") + "</div>";
    enrich(rows.map((r) => r.mint));
  };

  // Market data lands after the list: the cards render instantly from the
  // index, then fill in logo and numbers when the upstream answers.
  async function enrich(mints) {
    if (!mints.length) return;
    let market = {};
    try {
      const r = await fetch(api("api/market?mints=" + mints.join(",")));
      market = (await r.json()).market || {};
    } catch { }
    for (const mint of mints) {
      const m = market[mint] || {};
      const logo = list.querySelector('[data-logo="' + mint + '"]');
      if (logo && m.image) {
        logo.innerHTML = '<img src="' + esc(m.image) + '" alt="" ' +
          'class="w-full h-full object-cover" loading="lazy">';
      }
      const stats = list.querySelector('[data-stats="' + mint + '"]');
      if (stats) {
        const bits = [];
        if (typeof m.mcapUsd === "number") bits.push(usd(m.mcapUsd) + " market cap");
        if (typeof m.holders === "number") bits.push(m.holders + (m.holders === 1 ? " holder" : " holders"));
        if (m.complete) bits.push("graduated");
        stats.textContent = bits.length ? bits.join(" \u00b7 ") : "no market data yet";
      }
    }
  }

  // Delegated: the list is rebuilt on every render, so per-button listeners
  // would be lost each time.
  list.addEventListener("click", (e) => {
    const btn = e.target.closest && e.target.closest("button[data-attach]");
    if (btn) onAttach(btn);
  });

  wallet.onChange(render);
}

function bar(legs) {
  const palette = ["#120f19", "#6f5bd6", "#c8b8ff", "#8d8ba3", "#e4dcff"];
  return '<div class="flex w-full gap-1 mt-3" style="height:5px">' +
    legs.map((l, i) =>
      '<div class="rounded-full" title="' +
      esc(Math.round(l.bps / 100) + "% " + (LABELS[l.kind] || l.kind)) +
      '" style="width:' + (l.bps / 100) + "%;background:" + palette[i % palette.length] + '"></div>'
    ).join("") + "</div>";
}

function card(x) {
  const legs = Array.isArray(x.legs) ? x.legs : [];
  const split = legs.map((l) => Math.round(l.bps / 100) + "% " + (LABELS[l.kind] || l.kind)).join(" \u00b7 ");
  return '' +
    '<div class="rounded-[14px] border border-surface3 bg-surface2 p-4">' +
      '<div class="flex items-center justify-between gap-3">' +
        '<div class="flex items-center gap-2.5">' +
          // Filled in by the market fetch: the coin's own artwork, the one
          // thing that makes a row recognisable at a glance.
          '<span data-logo="' + esc(x.mint) + '" class="w-9 h-9 rounded-full bg-surface3 shrink-0 overflow-hidden inline-block"></span>' +
          '<span class="text-[15px] medium text-neutral1">' + esc(x.name || "") + "</span>" +
          '<span class="text-[12.5px] text-neutral2">$' + esc(x.symbol || "") + "</span>" +
        "</div>" +
        '<a class="text-[12.5px] text-brand hover:text-brand-hover transition-colors" target="_blank" rel="noreferrer" href="https://pump.fun/coin/' +
          esc(x.mint) + '">' + esc(short(x.mint)) + " \u2197</a>" +
      "</div>" +
      '<div data-stats="' + esc(x.mint) + '" class="mt-2 text-[12.5px] text-neutral3">market cap \u00b7 holders\u2026</div>' +
      bar(legs) +
      '<div class="mt-3 flex items-center justify-between gap-3 text-[12.5px] text-neutral2">' +
        "<span>" + esc(split) + "</span>" +
        (x.policySig
          ? '<a class="hover:text-neutral1 transition-colors" target="_blank" rel="noreferrer" href="https://solscan.io/tx/' +
            esc(x.policySig) + '">split tx \u2197</a>'
          // A coin whose second signature never landed is live but unsplit.
          // It can be repaired at any time, so offer that instead of a dead
          // label the creator can do nothing with.
          : '<button data-attach="' + esc(x.mint) + '" data-hook="' + esc(x.hookId || "") + '" ' +
            'class="text-brand hover:text-brand-hover transition-colors">attach the split</button>') +
      "</div>" +
    "</div>";
}

async function onAttach(btn) {
  const mint = btn.getAttribute("data-attach");
  const hook = HOOKS.find((h) => h.id === btn.getAttribute("data-hook"));
  if (!hook) { btn.textContent = "unknown adha"; return; }
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "check your wallet\u2026";
  try {
    const { attachSplit } = await import(new URL("launch-flow.js?v=c0eb4639", document.baseURI).href);
    const r = await attachSplit(mint, hook);
    btn.outerHTML = r.already
      ? '<span class="text-neutral3">split already on chain</span>'
      : '<a class="hover:text-neutral1 transition-colors" target="_blank" rel="noreferrer" ' +
        'href="https://solscan.io/tx/' + esc(r.sig) + '">split tx \u2197</a>';
  } catch (e) {
    btn.disabled = false;
    btn.textContent = label;
    alert("Could not attach the split: " + ((e && e.message) || e));
  }
}

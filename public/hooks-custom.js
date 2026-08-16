// /hooks/custom: the sentence compiler.
// Deterministic: the same sentence always produces the same legs, and
// anything it cannot place is reported instead of guessed at.

const KEY = "adha.customHook.v1";
const LEGS_KEY = "adha.customHook.legs";

const WORDS = [
  { kind: "burn", words: ["burn", "burnt", "burned", "buyandburn"] },
  { kind: "buyback", words: ["buy back", "buyback", "buy the coin", "buys", "buy"] },
  { kind: "holders", words: ["holders", "holder rewards", "the book", "rewards", "reflect", "reflections", "pay out", "payout"] },
  { kind: "jackpot", words: ["jackpot", "lottery", "raffle", "pot", "draw"] },
  { kind: "topholders", words: ["top holders", "top holder", "biggest holders", "whales", "conviction"] },
  { kind: "reserve", words: ["reserve", "vault", "treasury buy", "accumulate"] },
  { kind: "creator", words: ["me", "creator", "dev", "myself", "my wallet", "salary"] },
  { kind: "wallet", words: ["treasury", "wallet", "charity", "marketing", "team", "ops"] },
];
const ADDR = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

export const LABEL = { buyback: "Buy back", burn: "Buy & burn", holders: "Holder rewards", jackpot: "Jackpot", topholders: "Top holders", wallet: "Wallet", creator: "Creator", reserve: "Reserve buy" };
export const COLOR = { buyback: "#9585e8", burn: "#120f19", holders: "#6f5bd6", jackpot: "#e0a03c", topholders: "#c58bd8", wallet: "#8a8794", creator: "#d9d2f7", reserve: "#4bb3a6" };

const short = (a, n = 4) => (a.length <= n * 2 + 1 ? a : a.slice(0, n) + "\u2026" + a.slice(-n));
export const pct = (bps) => (Number.isInteger(bps / 100) ? bps / 100 + "%" : (bps / 100).toFixed(1) + "%");
const sum = (legs) => legs.reduce((t, l) => t + l.bps, 0);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const validAddr = (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a || "");

export function legText(l) {
  switch (l.kind) {
    case "buyback": return "buys the coin on the open market";
    case "burn": return "buys the coin and burns it";
    case "holders": return "pays out to every holder, pro rata";
    case "jackpot": return "goes to one holder, drawn by balance weight";
    case "topholders": return "splits across the top " + (l.count ?? 25) + " holders";
    case "wallet": return "goes to " + (l.address ? short(l.address) : "a named wallet");
    case "creator": return "goes to the launch wallet";
    case "reserve": return "buys the coin into a reserve wallet";
    default: return l.kind;
  }
}

function matchKind(clause) {
  let best = null;
  for (const g of WORDS)
    for (const w of g.words)
      if (clause.includes(w) && (!best || w.length > best.len)) best = { kind: g.kind, len: w.length };
  return best ? best.kind : null;
}

export function compile(text) {
  // "buy and burn" is one action, not two clauses, so protect it before the
  // and->comma split, or the number sticks to "buy" and the burn is dropped.
  const norm = text.toLowerCase()
    .replace(/\bbuys?\s*(?:and|&|\+)\s*burns?\b/g, "buyandburn")
    .replace(/\bburns?\s*(?:and|&|\+)\s*buys?\b/g, "buyandburn")
    .replace(/\band\b/g, ",").replace(/\bthen\b/g, ",");
  const warnings = [], unparsed = [], legs = [];
  const clauses = norm.split(/[,;/]|\.\s/).map((c) => c.trim()).filter(Boolean);

  for (const c of clauses) {
    const num = c.match(/(\d+(?:\.\d+)?)\s*(?:%|percent|pct)/);
    const half = /\bhalf\b/.test(c);
    const all = /\b(all|everything|100)\b/.test(c);
    const kind = matchKind(c);
    if (!kind) { if (num || half) unparsed.push(c); continue; }
    let bps = null;
    if (num) bps = Math.round(parseFloat(num[1]) * 100);
    else if (half) bps = 5000;
    else if (all) bps = 10000;
    const addr = c.match(ADDR)?.[0];
    const top = c.match(/top\s+(\d+)/);
    const leg = { kind, bps: bps ?? 0 };
    if (addr) leg.address = addr;
    if (kind === "topholders") leg.count = top ? parseInt(top[1], 10) : 25;
    legs.push(leg);
  }

  if (!legs.length)
    return { legs: [], unparsed, warnings: ["Nothing to compile yet. Name a share and where it goes."] };

  const numbered = legs.filter((l) => l.bps > 0);
  const blank = legs.filter((l) => l.bps === 0);
  if (blank.length) {
    const left = 10000 - sum(numbered);
    if (left <= 0) {
      warnings.push("The stated shares already reach 100%, so the unnumbered legs were dropped.");
      legs.splice(0, legs.length, ...numbered);
    } else {
      const each = Math.floor(left / blank.length);
      blank.forEach((l, i) => { l.bps = i === blank.length - 1 ? left - each * (blank.length - 1) : each; });
    }
  }

  const total = sum(legs);
  if (total !== 10000) {
    if (total < 10000) {
      warnings.push("Shares add up to " + (total / 100).toFixed(1) + "%. The rest is sent to the launch wallet.");
      legs.push({ kind: "creator", bps: 10000 - total, note: "Remainder" });
    } else {
      warnings.push("Shares add up to " + (total / 100).toFixed(1) + "%, so they were scaled back to 100%.");
      const k = 10000 / total;
      let run = 0;
      legs.forEach((l, i) => {
        if (i === legs.length - 1) l.bps = 10000 - run;
        else { l.bps = Math.round(l.bps * k); run += l.bps; }
      });
    }
  }
  for (const l of legs)
    if ((l.kind === "wallet" || l.kind === "reserve") && !l.address)
      warnings.push("The " + (l.kind === "wallet" ? "wallet" : "reserve") + " leg still needs an address.");

  return { legs, unparsed, warnings };
}

/* ---------------------------- rendering ---------------------------- */

const bar = (legs, h) =>
  '<div class="flex w-full gap-1" style="height:' + h + 'px">' +
  legs.map((l) => '<div class="rounded-full transition-[width] duration-500" style="width:' +
    (l.bps / 100) + "%;background:" + (COLOR[l.kind] || "#8a8794") + '"></div>').join("") + "</div>";

const chips = (legs) =>
  '<div class="flex flex-wrap gap-x-4 gap-y-1.5">' + legs.map((l) =>
    '<span class="inline-flex items-center gap-1.5 text-[12px] text-neutral3">' +
    '<span class="w-1.5 h-1.5 rounded-full" style="background:' + (COLOR[l.kind] || "#8a8794") + '"></span>' +
    esc(LABEL[l.kind] || l.kind) + " " + pct(l.bps) + "</span>").join("") + "</div>";

const rows = (legs) =>
  '<ul class="flex flex-col border-t border-surface3">' + legs.map((l, i) =>
    '<li class="flex items-baseline gap-3 py-3 border-b border-surface3">' +
    '<span class="w-2 h-2 rounded-full shrink-0 translate-y-[-1px]" style="background:' + (COLOR[l.kind] || "#8a8794") + '"></span>' +
    '<span class="medium text-neutral1 font-mono text-[13px] w-14 shrink-0">' + pct(l.bps) + "</span>" +
    '<span class="text-[14px] text-neutral2 leading-snug">' + esc(legText(l)) +
    ((l.kind === "wallet" || l.kind === "reserve")
      ? '<input data-addr="' + i + '" value="' + esc(l.address || "") + '" placeholder="Paste the address" ' +
        'class="mt-2 block w-full bg-surface2 border border-surface3 rounded-[10px] px-3 h-9 text-[13px] ' +
        'font-mono text-neutral1 placeholder:text-neutral3 outline-none transition-colors focus:border-brand">'
      : "") + "</span></li>").join("") + "</ul>";

export function initCustom() {
  const ta = document.querySelector("textarea");
  const out = document.querySelector(".rounded-card:last-of-type") ||
    document.querySelectorAll(".rounded-card")[1];
  if (!ta || !out) return;
  const counter = document.querySelector("span.text-\\[12px\\].text-neutral3");
  const addrs = {};

  document.querySelectorAll("button.rounded-full.h-7, button.h-7").forEach((b) => {
    const t = b.textContent.trim();
    if (!t) return;
    b.addEventListener("click", () => {
      ta.value = t;
      for (const k in addrs) delete addrs[k];
      render();
      ta.focus();
    });
  });

  const saved = localStorage.getItem(KEY);
  if (saved) ta.value = saved;
  ta.addEventListener("input", render);
  out.addEventListener("input", (e) => {
    const f = e.target.closest("[data-addr]");
    if (f) { addrs[f.dataset.addr] = f.value.trim(); render(true); }
  });
  out.addEventListener("click", (e) => {
    if (!e.target.closest("[data-use]")) return;
    localStorage.setItem(KEY, ta.value);
    localStorage.setItem(LEGS_KEY, JSON.stringify(current()));
    location.href = new URL("../launch?hook=custom", document.baseURI).toString();
  });

  let result = null;
  function current() {
    if (!result) return [];
    return result.legs.map((l, i) => (addrs[i] ? { ...l, address: addrs[i] } : l));
  }

  function render(keepFocus) {
    const text = ta.value;
    if (counter) counter.textContent = text.length + "/240";
    result = text.trim() ? compile(text) : null;
    const legs = current();
    const missing = legs.some((l) => (l.kind === "wallet" || l.kind === "reserve") && !validAddr(l.address));
    const ready = legs.length > 0 && !missing;
    const badge = !result ? ["Waiting", "border-surface3 text-neutral2"]
      : ready ? ["Ready", "border-brand text-brand"] : ["Needs work", "border-warn text-warn"];

    // an address typed into the panel clears that leg's warning
    const stillMissing = (kind) =>
      legs.some((l) => l.kind === kind && !validAddr(l.address));
    const live = result
      ? result.warnings.filter((w) => {
          const m = /^The (wallet|reserve) leg still needs an address\.$/.exec(w);
          return m ? stillMissing(m[1]) : true;
        })
      : [];
    const warn = result ? live.concat(result.unparsed.map(
      (u) => "Could not place \u201c" + u + "\u201d. Name where that share goes.")) : [];

    out.innerHTML =
      '<div class="flex items-center justify-between mb-5">' +
        '<span class="text-[13px] medium text-neutral2">Compiled</span>' +
        '<span class="inline-flex items-center gap-1.5 rounded-full border px-2.5 h-6 text-[12px] medium ' +
          badge[1] + '">' + badge[0] + "</span></div>" +
      (!legs.length
        ? '<div class="py-10 text-center text-[13.5px] text-neutral3">Write a sentence and the legs appear here.</div>'
        : bar(legs, 10) +
          '<div class="mt-4">' + chips(legs) + "</div>" +
          '<div class="mt-5">' + rows(legs) + "</div>" +
          (warn.length
            ? '<div class="mt-5 rounded-[12px] border border-warn/30 bg-warn/10 p-3.5 flex flex-col gap-1.5">' +
              warn.map((w) => '<p class="text-[13px] text-warn leading-relaxed">' + esc(w) + "</p>").join("") + "</div>"
            : "") +
          '<button data-use="1" ' + (ready ? "" : "disabled ") +
            'class="mt-5 w-full rounded-full bg-neutral1 text-white text-[14px] medium h-11 cursor-pointer ' +
            'transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed">Use this adha</button>');

    if (keepFocus) {
      const k = Object.keys(addrs).pop();
      const f = out.querySelector('[data-addr="' + k + '"]');
      if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
    }
  }

  render();
}

// /hooks: expandable hook rows.
// The static markup ships the row header and the chevron but no panel, so
// nothing opened. This rebuilds the original's behaviour: click a row to
// reveal the leg breakdown, the description, the "what it does not do"
// caveat, the cadence and a "Use this hook" button. One row open at a time.

const api = (p) => new URL(p, document.baseURI).toString();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pct = (bps) => (bps % 100 === 0 ? bps / 100 + "%" : (bps / 100).toFixed(2) + "%");

const COLORS = {
  burn: "rgb(18, 15, 25)",
  buyback: "rgb(111, 91, 214)",
  holders: "rgb(111, 91, 214)",
  jackpot: "rgb(230, 160, 30)",
  topholders: "rgb(200, 184, 255)",
  reserve: "rgb(141, 139, 163)",
  creator: "rgb(200, 184, 255)",
  wallet: "rgb(141, 139, 163)",
};

export async function initHooksList() {
  let cfg;
  try {
    cfg = await fetch(api("hooks.json")).then((r) => r.json());
  } catch {
    return;
  }
  const labels = cfg.legLabels || {};
  const cadences = cfg.cadenceLabels || {};
  const byName = new Map(cfg.hooks.map((h) => [h.name, h]));

  const rows = [];
  for (const btn of document.querySelectorAll("button")) {
    const title = btn.querySelector("span.text-\\[19px\\]");
    if (!title) continue;
    const hook = byName.get(title.textContent.trim());
    if (!hook) continue;

    // mark the chevron so CSS can rotate it
    const chev = btn.querySelector("svg");
    if (chev && chev.parentElement) chev.parentElement.classList.add("hl-chev");

    // Put the hook's explanation beside the row: left column keeps the
    // name / tagline / leg bar, right column carries the description and
    // the badge + chevron.
    if (hook.description && !btn.querySelector("[data-desc]")) {
      const kids = [...btn.children];
      const head = kids[0];
      const right = head && head.lastElementChild;
      const grid = document.createElement("div");
      grid.className = "grid md:grid-cols-[1fr_minmax(0,42%)] gap-x-10 items-start";
      const left = document.createElement("div");
      kids.forEach((k) => left.appendChild(k));
      const col = document.createElement("div");
      col.className = "flex items-start justify-between gap-4 mt-1 md:mt-0";
      const p = document.createElement("p");
      p.dataset.desc = "1";
      p.className = "text-[14px] text-neutral2 leading-relaxed";
      p.textContent = hook.description;
      col.appendChild(p);
      if (right) col.appendChild(right);
      grid.appendChild(left);
      grid.appendChild(col);
      btn.appendChild(grid);
    }

    const panel = document.createElement("div");
    panel.className = "hl-hookpanel";
    panel.innerHTML = body(hook, labels, cadences);
    btn.parentElement.appendChild(panel);
    rows.push({ btn, panel, hook, wrap: btn.parentElement });
  }
  if (!rows.length) return;

  const close = (r) => {
    r.wrap.classList.remove("hl-open");
    r.btn.setAttribute("aria-expanded", "false");
    r.panel.style.height = r.panel.scrollHeight + "px";
    requestAnimationFrame(() => { r.panel.style.height = "0px"; });
  };
  const open = (r) => {
    r.wrap.classList.add("hl-open");
    r.btn.setAttribute("aria-expanded", "true");
    const inner = r.panel.firstElementChild;
    if (inner) { inner.classList.remove("hl-rise"); void inner.offsetWidth; inner.classList.add("hl-rise"); }
    r.panel.style.height = r.panel.scrollHeight + "px";
    const done = () => {
      r.panel.style.height = "auto";
      r.panel.removeEventListener("transitionend", done);
    };
    r.panel.addEventListener("transitionend", done);
  };

  rows.forEach((r) => {
    r.btn.setAttribute("aria-expanded", "false");
    r.btn.addEventListener("click", (e) => {
      if (e.target.closest("[data-use]")) return;
      const isOpen = r.wrap.classList.contains("hl-open");
      rows.forEach((o) => { if (o !== r && o.wrap.classList.contains("hl-open")) close(o); });
      isOpen ? close(r) : open(r);
    });
    r.panel.addEventListener("click", (e) => {
      const use = e.target.closest("[data-use]");
      if (use) location.href = api("launch?hook=" + encodeURIComponent(use.dataset.use));
    });
  });
}

function legRows(hook, labels) {
  return hook.legs.map((l) => {
    const c = COLORS[l.kind] || "rgb(141, 139, 163)";
    return '<div class="flex items-center gap-3 py-2 border-b border-surface3 last:border-0">' +
      '<span class="shrink-0 rounded-full" style="width:8px;height:8px;background:' + c + '"></span>' +
      '<span class="font-mono text-[13px] text-neutral1 w-[52px] shrink-0">' + pct(l.bps) + "</span>" +
      '<span class="text-[14px] text-neutral2">' + esc(labels[l.kind] || l.kind) + "</span>" +
      "</div>";
  }).join("");
}

function body(hook, labels, cadences) {
  const cadence = cadences[hook.cadence] || hook.cadence;
  return '<div class="pb-7 grid md:grid-cols-2 gap-x-10 gap-y-6">' +
      "<div>" + legRows(hook, labels) + "</div>" +
      "<div>" +
        (hook.description
          ? '<p class="text-[15px] text-neutral2 leading-relaxed">' + esc(hook.description) + "</p>"
          : "") +
        (hook.caveat
          ? '<div class="mt-5 border-t border-surface3 pt-4">' +
              '<div class="text-[12px] medium uppercase tracking-[0.1em] text-warn mb-1.5">What it does not do</div>' +
              '<p class="text-[14px] text-neutral2 leading-relaxed">' + esc(hook.caveat) + "</p>" +
            "</div>"
          : "") +
        '<div class="mt-6 flex items-center justify-between gap-4">' +
          (cadence ? '<span class="text-[13px] text-neutral2">Runs: ' + esc(cadence) + "</span>" : "<span></span>") +
          '<button data-use="' + esc(hook.id) + '" class="shrink-0 rounded-full bg-neutral1 text-white ' +
            'text-[13px] medium px-4 py-2 cursor-pointer transition-opacity hover:opacity-90">Use this adha</button>' +
        "</div>" +
      "</div>" +
    "</div>";
}

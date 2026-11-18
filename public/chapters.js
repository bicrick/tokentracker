// Landing chapters after the demo unlocks: heatmaps (cycling styles), badges,
// graphs, and a typed API query that renders its own chart.
import { formatTokens, MONTHS } from '/lib/heatmap.js';

const HANDLE = 'bicrick';
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Fade a chapter in the first time it scrolls into view. */
function onEnter(el, fn) {
  if (reduced || !('IntersectionObserver' in window)) {
    el.classList.add('in');
    fn?.();
    return;
  }
  const io = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    io.disconnect();
    el.classList.add('in');
    fn?.();
  }, { threshold: 0.2 });
  io.observe(el);
}

import '/embed.js?v=24';

const mix = (a, b, t) => {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [A, B] = [p(a), p(b)];
  return `#${A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
};

/** Live heatmap playground: controls restyle the web component instantly. */
function playground() {
  const el = document.getElementById('pg-heatmap');
  const stage = document.getElementById('pg-stage');
  const code = document.getElementById('pg-code');
  const accent = document.getElementById('pg-accent');
  const radius = document.getElementById('pg-radius');
  const gap = document.getElementById('pg-gap');
  const state = { theme: 'dark', range: 'year' };

  const render = () => {
    const empty = state.theme === 'light' ? '#edeef0' : '#23252b';
    const bg = state.theme === 'light' ? '#ffffff' : '#121317';
    el.style.setProperty('--tt-cell-0', empty);
    [0.3, 0.55, 0.8, 1].forEach((t, i) => el.style.setProperty(`--tt-cell-${i + 1}`, mix(empty, accent.value, t)));
    el.style.setProperty('--tt-radius', `${radius.value}%`);
    el.style.setProperty('--tt-gap', `${gap.value}px`);
    el.style.setProperty('--tt-muted', state.theme === 'light' ? '#6b6f7a' : '#8b8e97');
    stage.style.background = bg;
    stage.style.color = state.theme === 'light' ? '#16181d' : '#ecece8';
    if (state.range === 'year') el.removeAttribute('range');
    else el.setAttribute('range', state.range);

    const attrs = state.range === 'year' ? '' : ` range="${state.range}"`;
    code.textContent = `<script type="module" src="${location.origin}/embed.js"><\/script>\n<token-heatmap handle="you"${attrs}></token-heatmap>\n\n<style>\n  token-heatmap {\n    --tt-cell-4: ${accent.value};\n    --tt-radius: ${radius.value}%;\n    --tt-gap: ${gap.value}px;\n  }\n</style>`;
  };

  const chips = (id, key) => document.getElementById(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    e.preventDefault();
    [...e.currentTarget.children].forEach((x) => x.classList.toggle('on', x === b));
    state[key] = b.dataset.v;
    render();
  });
  chips('pg-theme', 'theme');
  chips('pg-range', 'range');
  [accent, radius, gap].forEach((i) => i.addEventListener('input', render));
  render();
}

async function apiDemo(data) {
  const term = document.getElementById('api-term');
  const bars = document.getElementById('api-bars');
  const cmd = `curl tokentracker-nu.vercel.app/u/${HANDLE}.json?group=month`;
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const d = await data;
  const year = String(new Date().getFullYear());
  const monthly = Array(12).fill(0);
  for (const r of d?.activityCounts || []) if (r.date.startsWith(year)) monthly[Number(r.date.slice(5, 7)) - 1] += r.count;
  const rows = monthly.map((tokens, m) => ({ month: `${year}-${String(m + 1).padStart(2, '0')}`, tokens })).filter((r, m) => m <= new Date().getMonth());

  if (!reduced) {
    for (let n = 1; n <= cmd.length; n += 1) {
      term.innerHTML = `<span class="t-gray">$</span> ${esc(cmd.slice(0, n))}<span class="caret"></span>`;
      await sleep(22);
    }
    await sleep(300);
  }
  const shown = rows.slice(-6);
  const json = [
    '{',
    `  "handle": "${HANDLE}", "group": "month",`,
    `  "total": ${rows.reduce((s, r) => s + r.tokens, 0)},`,
    '  "rows": [',
    ...shown.map((r, k) => `    { "month": "${r.month}", "tokens": ${r.tokens} }${k < shown.length - 1 ? ',' : ''}`),
    '  ]',
    '}',
  ];
  term.innerHTML = `<span class="t-gray">$</span> ${esc(cmd)}\n`;
  for (const line of json) {
    term.innerHTML += `<span class="t-blue">${esc(line)}</span>\n`;
    if (!reduced) await sleep(55);
  }

  // Draw a chart from the "response"
  const max = Math.max(1, ...rows.map((r) => r.tokens));
  bars.innerHTML = rows.map((r) => {
    const m = Number(r.month.slice(5)) - 1;
    return `<div title="${MONTHS[m]} · ${formatTokens(r.tokens)}"><span style="--h:${(r.tokens / max) * 100}%"></span><small>${MONTHS[m][0]}</small></div>`;
  }).join('');
  requestAnimationFrame(() => bars.classList.add('grow'));
}

export function mountChapters(data) {
  playground();
  onEnter(document.getElementById('ch-heatmaps'));
  onEnter(document.getElementById('ch-badges'));
  onEnter(document.getElementById('ch-graphs'));
  onEnter(document.getElementById('ch-api'), () => apiDemo(data));
}

// Landing chapters after the demo unlocks: heatmaps (cycling styles), badges,
// graphs, and a typed API query that renders its own chart.
import { formatTokens, MONTHS } from '/lib/heatmap.js';

const HANDLE = 'bicrick';
// The plain blue square heatmap opens the section above; these are the variations
const STYLES = [
  { q: 'cells=round&theme=light', label: 'round · light' },
  { q: 'cells=dot&accent=f0c463', label: 'dot · gold accent' },
  { q: 'cells=dither&theme=gold', label: 'dither · gold' },
  { q: 'cells=square&accent=6fd39b&range=365d', label: 'last 365 days · green' },
  { q: 'cells=round&accent=d97757&tools=claude-code', label: 'claude code only' },
  { q: 'cells=square&theme=light&accent=e11d48&hide=title', label: 'no title · red' },
];

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

function heatmapCycler() {
  const a = document.getElementById('cycler-a');
  const b = document.getElementById('cycler-b');
  const url = document.getElementById('cycler-url');
  const dots = document.getElementById('cycler-dots');
  const src = (s) => `/u/${HANDLE}.svg${s.q ? `?${s.q}` : ''}`;
  STYLES.forEach((s) => new Image().src = src(s)); // warm the cache

  dots.innerHTML = STYLES.map((s, i) => `<button type="button" aria-label="${s.label}" data-i="${i}"></button>`).join('');
  let i = 0;
  let front = a;
  let timer = 0;

  const show = (n) => {
    i = (n + STYLES.length) % STYLES.length;
    const back = front === a ? b : a;
    back.src = src(STYLES[i]);
    back.onload = () => {
      back.classList.add('front');
      front.classList.remove('front');
      front = back;
    };
    url.textContent = src(STYLES[i]).replace(HANDLE, 'you');
    [...dots.children].forEach((d, k) => d.classList.toggle('on', k === i));
  };
  const start = () => {
    clearInterval(timer);
    if (!reduced) timer = setInterval(() => show(i + 1), 2600);
  };

  a.src = src(STYLES[0]);
  a.classList.add('front');
  url.textContent = src(STYLES[0]).replace(HANDLE, 'you');
  dots.children[0].classList.add('on');
  dots.addEventListener('click', (e) => {
    const d = e.target.closest('button');
    if (!d) return;
    show(Number(d.dataset.i));
    start();
  });
  return start;
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
  const startCycler = heatmapCycler();
  onEnter(document.getElementById('ch-heatmaps'), startCycler);
  onEnter(document.getElementById('ch-badges'));
  onEnter(document.getElementById('ch-graphs'));
  onEnter(document.getElementById('ch-api'), () => apiDemo(data));
}

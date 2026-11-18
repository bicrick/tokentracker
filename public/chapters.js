// Landing chapters after the demo unlocks: heatmaps (cycling styles), badges,
// graphs, and a typed API query that renders its own chart.
import { formatTokens, MONTHS } from '/lib/heatmap.js';

const HANDLE = 'bicrick';
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Fade a chapter in the first time it scrolls into view. */
function onEnter(el, fn) {
  let done = false;
  const fire = () => {
    if (done) return;
    done = true;
    el.classList.add('in');
    fn?.();
  };
  if (reduced) return fire();
  // Intersection observer, plus a plain scroll check as a fallback so the
  // chapter can never get stuck hidden
  const check = () => {
    const r = el.getBoundingClientRect();
    if (r.top < window.innerHeight * 0.85 && r.bottom > 0) {
      window.removeEventListener('scroll', check);
      fire();
    }
  };
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        io.disconnect();
        fire();
      }
    }, { threshold: 0.2 });
    io.observe(el);
  }
  window.addEventListener('scroll', check, { passive: true });
  check();
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

  // Morph the skeleton bars into the real ones (same elements, so no pop-in)
  const max = Math.max(1, ...rows.map((r) => r.tokens));
  const cols = [...bars.children];
  while (cols.length < rows.length) {
    const div = document.createElement('div');
    div.innerHTML = '<span style="--h:0%"></span><small>&nbsp;</small>';
    bars.appendChild(div);
    cols.push(div);
  }
  cols.slice(rows.length).forEach((c) => c.remove());
  bars.classList.remove('skeleton');
  rows.forEach((r, k) => {
    const m = Number(r.month.slice(5)) - 1;
    const col = cols[k];
    col.title = `${MONTHS[m]} · ${formatTokens(r.tokens)} tokens`;
    col.dataset.label = `${MONTHS[m]} · ${formatTokens(r.tokens)}`;
    col.querySelector('small').textContent = MONTHS[m][0];
    col.querySelector('span').style.setProperty('--h', `${Math.max(1.5, (r.tokens / max) * 100)}%`);
    col.style.setProperty('--delay', `${k * 45}ms`);
  });
}

/** Swap card <img>s for inline SVG so they can respond to hover. */
async function inlineCards() {
  for (const img of document.querySelectorAll('img[data-inline]')) {
    try {
      const text = await (await fetch(img.src)).text();
      const holder = document.createElement('div');
      holder.className = 'card-svg';
      holder.innerHTML = text;
      const svg = holder.querySelector('svg');
      if (!svg) continue;
      svg.removeAttribute('width');
      svg.removeAttribute('height');
      svg.setAttribute('aria-label', img.alt);
      img.replaceWith(holder);
      if (img.hasAttribute('data-line')) lineHover(svg);
      if (svg.querySelector('.tt-row')) breakdownHover(svg);
    } catch {
      // leave the static image in place
    }
  }
}

function lineHover(svg) {
  const ns = 'http://www.w3.org/2000/svg';
  const points = [...svg.querySelectorAll('.tt-point')];
  if (!points.length) return;
  const guide = document.createElementNS(ns, 'line');
  guide.setAttribute('class', 'tt-guide');
  const dot = document.createElementNS(ns, 'circle');
  dot.setAttribute('class', 'tt-dot');
  dot.setAttribute('r', '4');
  const label = document.createElementNS(ns, 'text');
  label.setAttribute('class', 'tt-readout');
  label.setAttribute('font-size', '11');
  [guide, dot, label].forEach((n) => { n.style.display = 'none'; svg.appendChild(n); });
  const top = Number(points[0].getAttribute('y'));
  const bottom = top + Number(points[0].getAttribute('height'));
  const width = Number(svg.getAttribute('viewBox').split(' ')[2]);

  const show = (p) => {
    const x = Number(p.dataset.x);
    const y = Number(p.dataset.y);
    guide.setAttribute('x1', x); guide.setAttribute('x2', x);
    guide.setAttribute('y1', top); guide.setAttribute('y2', bottom);
    dot.setAttribute('cx', x); dot.setAttribute('cy', y);
    label.textContent = p.querySelector('title').textContent;
    const right = x > width * 0.6;
    label.setAttribute('x', right ? x - 8 : x + 8);
    label.setAttribute('y', Math.max(top + 10, y - 10));
    label.setAttribute('text-anchor', right ? 'end' : 'start');
    [guide, dot, label].forEach((n) => { n.style.display = ''; });
  };
  points.forEach((p) => p.addEventListener('mouseenter', () => show(p)));
  svg.addEventListener('mouseleave', () => [guide, dot, label].forEach((n) => { n.style.display = 'none'; }));
}

function breakdownHover(svg) {
  const parts = [...svg.querySelectorAll('[data-tool]')];
  parts.forEach((el) => {
    el.addEventListener('mouseenter', () => {
      const tool = el.dataset.tool;
      parts.forEach((p) => p.classList.toggle('tt-dim', p.dataset.tool !== tool));
    });
  });
  svg.addEventListener('mouseleave', () => parts.forEach((p) => p.classList.remove('tt-dim')));
}

export function mountChapters(data) {
  playground();
  onEnter(document.getElementById('ch-heatmaps'));
  onEnter(document.getElementById('ch-badges'));
  onEnter(document.getElementById('ch-graphs'));
  inlineCards();
  onEnter(document.getElementById('ch-api'), () => apiDemo(data));
}

// Live, interactive examples for the docs' embed section.
import { formatTokens, getHeatmap, MONTHS } from '/lib/heatmap.js';

const ORIGIN = location.origin;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

let handle = 'bicrick';

// Chip groups: one active value each
function chips(group, onChange) {
  group.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $$('button', group).forEach((x) => x.classList.toggle('on', x === b));
    onChange(b.dataset.v);
  });
  return () => $('button.on', group)?.dataset.v;
}

// ── image cards ──────────────────────────────────────────────────────────────
const cards = $('#try-cards');
const cardOpts = {};
function renderCards() {
  const shared = new URLSearchParams();
  if (cardOpts.theme && cardOpts.theme !== 'dark') shared.set('theme', cardOpts.theme);
  if (cardOpts.range && cardOpts.range !== 'year') shared.set('range', cardOpts.range);
  let example = '';
  for (const fig of $$('figure[data-card]', cards)) {
    const q = new URLSearchParams(fig.dataset.card);
    shared.forEach((v, k) => q.set(k, v));
    if (q.get('type') === 'heatmap' && cardOpts.cells && cardOpts.cells !== 'square') q.set('cells', cardOpts.cells);
    if (q.get('type') === 'heatmap') q.delete('type');
    const url = `${ORIGIN}/u/${handle}.svg${q.toString() ? `?${q}` : ''}`;
    $('img', fig).src = url;
    if (!example) example = url;
  }
  $('[data-out=cards]', cards).textContent = `[![AI tokens](${example})](${ORIGIN}/u/${handle})`;
}
// Start the card examples in the page's colour scheme
if (window.matchMedia('(prefers-color-scheme: light)').matches) {
  $$('[data-opt=theme] button', cards).forEach((b) => b.classList.toggle('on', b.dataset.v === 'light'));
  const empty = $('[data-var="--tt-cell-0"]');
  const busy = $('[data-var="--tt-cell-4"]');
  if (empty) empty.value = '#edeef0';
  if (busy) busy.value = '#1d4ed8';
}
for (const g of $$('[data-opt]', cards)) {
  cardOpts[g.dataset.opt] = $('button.on', g)?.dataset.v;
  chips(g, (v) => {
    cardOpts[g.dataset.opt] = v;
    renderCards();
  });
}

// ── web component ────────────────────────────────────────────────────────────
const comp = $('#try-component');
const el = $('token-heatmap', comp);
function renderComponent() {
  const vars = $$('[data-var]', comp).map((i) => {
    const v = `${i.value}${i.dataset.unit || ''}`;
    el.style.setProperty(i.dataset.var, v);
    return `  ${i.dataset.var}: ${v};`;
  });
  // keep the in-between levels in step with the two chosen colours
  const a = $('[data-var="--tt-cell-0"]', comp).value;
  const b = $('[data-var="--tt-cell-4"]', comp).value;
  [0.28, 0.5, 0.75].forEach((t, i) => el.style.setProperty(`--tt-cell-${i + 1}`, mix(a, b, t)));
  const range = el.getAttribute('range') || 'year';
  el.setAttribute('handle', handle);
  $('[data-out=component]', comp).textContent = `<token-heatmap handle="${handle}"${range !== 'year' ? ` range="${range}"` : ''}></token-heatmap>\n\ntoken-heatmap {\n${vars.join('\n')}\n}`;
}
function mix(x, y, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [A, B] = [p(x), p(y)];
  return `#${A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}
$$('[data-var]', comp).forEach((i) => i.addEventListener('input', renderComponent));
chips($('[data-attr=range]', comp), (v) => {
  if (v === 'year') el.removeAttribute('range');
  else el.setAttribute('range', v);
  renderComponent();
});

// ── headless library ─────────────────────────────────────────────────────────
const lib = $('#try-library');
const stage = $('#lib-stage');
const CODE = {
  bars: `const hm = await getHeatmap('${'${handle}'}');
// sum each month and draw your own bars
const months = Array(12).fill(0);
hm.weeks.flat().forEach((d) => { if (d && !d.future) months[+d.date.slice(5, 7) - 1] += d.count; });`,
  rings: `const hm = await getHeatmap('${'${handle}'}', { range: '90d' });
// one ring per week, sized by that week's tokens
const weeks = hm.weeks.map((w) => w.reduce((s, d) => s + (d?.count || 0), 0));`,
  text: `const hm = await getHeatmap('${'${handle}'}', { range: '30d' });
// a unicode sparkline from each day's colour level
const line = hm.weeks.flat().filter(Boolean).map((d) => ' ▁▃▅█'[d.level]).join('');`,
};
async function renderLibrary(style) {
  stage.innerHTML = '<span class="muted">loading…</span>';
  try {
    if (style === 'bars') {
      const hm = await getHeatmap(handle, { origin: ORIGIN });
      const months = Array(12).fill(0);
      hm.weeks.flat().forEach((d) => { if (d && !d.future) months[+d.date.slice(5, 7) - 1] += d.count; });
      const max = Math.max(1, ...months);
      stage.innerHTML = `<div class="lib-bars">${months.map((m, i) => `<div title="${MONTHS[i]} · ${formatTokens(m)}"><span style="height:${(m / max) * 100}%"></span><small>${MONTHS[i][0]}</small></div>`).join('')}</div>`;
    } else if (style === 'rings') {
      const hm = await getHeatmap(handle, { origin: ORIGIN, range: '90d' });
      const weeks = hm.weeks.map((w) => w.reduce((s, d) => s + (d?.count || 0), 0));
      const max = Math.max(1, ...weeks);
      stage.innerHTML = `<div class="lib-rings">${weeks.map((w) => `<i title="${formatTokens(w)}" style="--s:${0.25 + 0.75 * Math.sqrt(w / max)}"></i>`).join('')}</div>`;
    } else {
      const hm = await getHeatmap(handle, { origin: ORIGIN, range: '30d' });
      const line = hm.weeks.flat().filter(Boolean).map((d) => ' ▁▃▅█'[d.level]).join('');
      stage.innerHTML = `<div class="lib-text"><b>${esc(line)}</b> <span>${formatTokens(hm.total)} tokens in 30 days</span></div>`;
    }
  } catch (err) {
    stage.innerHTML = `<span class="muted">${esc(err.message)}</span>`;
  }
  $('[data-out=library]', lib).textContent = `import { getHeatmap } from '${ORIGIN}/lib/heatmap.js';\n\n${CODE[style].replace('${handle}', handle)}`;
}
const libStyle = chips($('[data-style]', lib), renderLibrary);

// ── raw data ─────────────────────────────────────────────────────────────────
const data = $('#try-data');
const dataOpts = { group: 'month', format: 'json' };
async function renderData() {
  const url = `${ORIGIN}/u/${handle}.${dataOpts.format}?group=${dataOpts.group}`;
  $('[data-out=url]', data).textContent = `GET ${url}`;
  const out = $('#data-result');
  out.textContent = 'loading…';
  try {
    const res = await fetch(url);
    const text = await res.text();
    if (dataOpts.format === 'json') {
      const j = JSON.parse(text);
      const shown = { ...j, rows: j.rows.slice(0, 8) };
      out.textContent = JSON.stringify(shown, null, 2) + (j.rows.length > 8 ? `\n// … ${j.rows.length - 8} more rows` : '');
    } else {
      const lines = text.trim().split('\n');
      out.textContent = lines.slice(0, 10).join('\n') + (lines.length > 10 ? `\n… ${lines.length - 10} more lines` : '');
    }
  } catch (err) {
    out.textContent = err.message;
  }
}
for (const g of $$('[data-opt]', data)) {
  chips(g, (v) => {
    dataOpts[g.dataset.opt] = v;
    renderData();
  });
}

// ── shared handle ────────────────────────────────────────────────────────────
let t;
$('[data-global=handle]').addEventListener('input', (e) => {
  clearTimeout(t);
  t = setTimeout(() => {
    handle = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') || 'bicrick';
    renderAll();
  }, 300);
});

function renderAll() {
  renderCards();
  renderComponent();
  renderLibrary(libStyle());
  renderData();
}
renderAll();

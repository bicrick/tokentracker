// Shared rendering for the landing and profile pages. No dependencies.

const SOURCE_COLORS = {
  cursor: 'var(--ink)',
  'claude-code': 'var(--bot)',
  opencode: 'var(--link)',
};
const SOURCE_NAMES = { cursor: 'cursor', 'claude-code': 'claude code', opencode: 'opencode' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatCount(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2).replace(/\.?0+$/, '')}b`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}m`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

function iso(d) {
  return d.toISOString().slice(0, 10);
}




export function renderSplit(container, sources) {
  const entries = Object.entries(sources).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const bar = document.createElement('div');
  bar.className = 'split';
  const legend = document.createElement('div');
  legend.className = 'legend';
  for (const [source, value] of entries) {
    const color = SOURCE_COLORS[source] || 'var(--muted)';
    const seg = document.createElement('span');
    seg.style.flexGrow = value;
    seg.style.background = color;
    bar.appendChild(seg);
    const item = document.createElement('span');
    item.innerHTML = `<i style="background:${color}"></i>`;
    item.append(`${SOURCE_NAMES[source] || source} ${formatCount(value)}`);
    legend.appendChild(item);
  }
  container.replaceChildren(bar, legend);
}

export function wireCopy(button, text) {
  button.addEventListener('click', async () => {
    await navigator.clipboard.writeText(text);
    const prev = button.textContent;
    button.textContent = 'copied';
    setTimeout(() => { button.textContent = prev; }, 1400);
  });
}

/** Render the grid returned by GET /api/v1/users/{handle}/heatmap. */
export function renderHeatmapGrid(container, hm) {
  const weeks = hm.weeks.length;
  const grid = document.createElement('div');
  grid.className = 'hm';
  grid.style.gridTemplateColumns = `repeat(${weeks}, 1fr)`;
  const months = document.createElement('div');
  months.className = 'hm-months';
  for (const m of hm.months) {
    const span = document.createElement('span');
    span.textContent = m.label;
    span.style.left = `${(m.week / weeks) * 100}%`;
    months.appendChild(span);
  }
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.hidden = true;
  document.body.appendChild(tip);
  hm.weeks.forEach((week, w) => week.forEach((d) => {
    const cell = document.createElement('span');
    cell.style.setProperty('--w', w);
    if (!d) cell.className = 'out';
    else if (d.tokens == null) cell.className = 'l0';
    else {
      cell.className = `l${d.level} live`;
      const label = `${d.date} · ${formatCount(d.tokens)}`;
      cell.addEventListener('mouseenter', () => {
        const r = cell.getBoundingClientRect();
        tip.textContent = label;
        tip.style.left = `${r.left + r.width / 2}px`;
        tip.style.top = `${r.top}px`;
        tip.hidden = false;
      });
      cell.addEventListener('mouseleave', () => { tip.hidden = true; });
    }
    grid.appendChild(cell);
  }));
  const legend = document.createElement('div');
  legend.className = 'hm-legend';
  legend.innerHTML = '<span class="lbl">less</span>'
    + [0, 1, 2, 3, 4].map((l) => `<i style="background:var(--l${l})"></i>`).join('')
    + '<span class="lbl">more</span>';
  container.replaceChildren(months, grid, legend);
}

export async function api(path) {
  const res = await fetch(`/api/v1${path}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message || `status ${res.status}`);
  return body;
}

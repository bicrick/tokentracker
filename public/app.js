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

export async function fetchActivity(handle) {
  const res = await fetch(`/api/activity?handle=${encodeURIComponent(handle)}`);
  if (!res.ok) throw new Error(res.status === 404 ? 'not found' : `status ${res.status}`);
  return res.json();
}

export function yearTotals(data) {
  const year = String(new Date().getFullYear());
  const days = (data.activityCounts || []).filter((d) => d.date.startsWith(year));
  const total = days.reduce((s, d) => s + d.count, 0);
  const sources = {};
  for (const d of days) {
    for (const [k, v] of Object.entries(d.sources || {})) sources[k] = (sources[k] || 0) + v;
  }
  return { total, sources, days };
}

export function renderHeatmap(container, data) {
  const now = new Date();
  const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const jan1 = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
  const byDate = new Map((data.activityCounts || []).map((d) => [d.date, d.count]));

  const values = [...byDate.entries()]
    .filter(([date, c]) => c > 0 && date >= iso(jan1) && date <= iso(today))
    .map(([, c]) => c)
    .sort((a, b) => a - b);
  const q = (p) => (values.length ? values[Math.min(values.length - 1, Math.floor(values.length * p))] : 1);
  const t = [q(0.25), q(0.5), q(0.75), q(0.9)];
  const level = (c) => (c <= 0 ? 0 : c <= t[0] ? 1 : c <= t[1] ? 2 : c <= t[2] ? 3 : 4);

  const start = new Date(jan1);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  const dec31 = new Date(Date.UTC(today.getUTCFullYear(), 11, 31));
  const end = new Date(dec31);
  end.setUTCDate(end.getUTCDate() + (6 - end.getUTCDay()));
  const weeks = Math.round((end - start) / 86400000 + 1) / 7;

  const grid = document.createElement('div');
  grid.className = 'hm';
  grid.style.gridTemplateColumns = `repeat(${weeks}, 1fr)`;

  const months = document.createElement('div');
  months.className = 'hm-months';

  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.hidden = true;
  document.body.appendChild(tip);

  let week = 0;
  for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = iso(d);
    const cell = document.createElement('span');
    cell.style.setProperty('--w', week);
    if (d < jan1 || d > dec31) {
      cell.className = 'out';
    } else if (d > today) {
      cell.className = 'l0';
    } else {
      const count = byDate.get(key) || 0;
      cell.className = `l${level(count)} live`;
      const label = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} · ${formatCount(count)}`;
      cell.addEventListener('mouseenter', () => {
        const r = cell.getBoundingClientRect();
        tip.textContent = label;
        tip.style.left = `${r.left + r.width / 2}px`;
        tip.style.top = `${r.top}px`;
        tip.hidden = false;
      });
      cell.addEventListener('mouseleave', () => { tip.hidden = true; });
    }
    if (d >= jan1 && d <= dec31 && d.getUTCDate() === 1) {
      const m = document.createElement('span');
      m.textContent = MONTHS[d.getUTCMonth()];
      m.style.left = `${(week / weeks) * 100}%`;
      months.appendChild(m);
    }
    grid.appendChild(cell);
    if (d.getUTCDay() === 6) week += 1;
  }

  const legend = document.createElement('div');
  legend.className = 'hm-legend';
  legend.innerHTML = '<span class="lbl">less</span>'
    + [0, 1, 2, 3, 4].map((l) => `<i style="background:var(--l${l})"></i>`).join('')
    + '<span class="lbl">more</span>';

  container.replaceChildren(months, grid, legend);
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

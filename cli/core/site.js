// Build a user's static API from their machines' rows: the same resources as
// the hosted v1 API, written as plain JSON files that GitHub Pages serves.
import { devices, heatmap, models, stats, tools, totals, usage } from './query.js';

export const RANGES = ['all', 'ytd', '30d', '90d', '365d'];
const GROUPS = ['day', 'week', 'month'];
const iso = (d) => d.toISOString().slice(0, 10);
const short = (n) => {
  for (const [v, u] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) if (n >= v) return `${(n / v).toFixed(2).replace(/\.?0+$/, '')}${u}`;
  return String(n);
};

function rangeFrom(range, today) {
  if (range === 'all') return null;
  if (range === 'ytd') return `${today.slice(0, 4)}-01-01`;
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (parseInt(range, 10) - 1));
  return iso(d);
}

/** Convert a machine file's rows (camelCase, like the upload API) to query rows. */
export function toQueryRows(machineRows, device) {
  return machineRows.map((r) => ({
    date: r.date,
    source: r.source,
    model: r.model,
    input: r.input || 0,
    output: r.output || 0,
    reasoning: r.reasoning || 0,
    cache_read: r.cacheRead || 0,
    cache_write: r.cacheWrite || 0,
    messages: r.messages || 0,
    device,
  }));
}

/**
 * Returns { [path]: object } for every file in the static API, rooted at
 * api/v1/. `machines` is [{ device, updatedAt, rows }] already in query form.
 */
export function buildStaticApi({ handle, rows, machines, baseUrl, generatedAt = new Date().toISOString() }) {
  const today = iso(new Date());
  const files = {};
  const meta = (filters) => ({ handle, generatedAt, filters });
  const syncs = new Map(machines.map((m) => [m.device, m.updatedAt]));

  for (const range of RANGES) {
    const from = rangeFrom(range, today);
    const filters = { from, to: null, tools: null, models: null };
    const r = from ? rows.filter((x) => x.date >= from) : rows;
    const dir = range === 'all' ? 'api/v1' : `api/v1/${range}`;
    for (const group of GROUPS) {
      const name = group === 'day' ? 'usage' : `usage-${group}`;
      files[`${dir}/${name}.json`] = { ...meta(filters), group, split: 'tool', totals: totals(r), rows: usage(r, filters, { group, split: 'tool' }) };
    }
    files[`${dir}/models.json`] = { ...meta(filters), rows: models(r) };
    files[`${dir}/tools.json`] = { ...meta(filters), rows: tools(r) };
    const st = stats(r);
    // Short display strings (e.g. "9.79B"), used by the README's live badges
    const display = { tokens: short(st.tokens), thisMonth: short(st.thisMonth), today: short(st.today), activeDays: String(st.activeDays), currentStreak: `${st.currentStreak}d`, longestStreak: `${st.longestStreak}d` };
    files[`${dir}/stats.json`] = { ...meta(filters), ...st, display };
    files[`${dir}/devices.json`] = { ...meta(filters), rows: devices(r, syncs) };
  }
  // Heatmaps are calendar grids with their own range handling
  for (const range of ['year', '365d', '90d']) {
    files[range === 'year' ? 'api/v1/heatmap.json' : `api/v1/heatmap-${range}.json`] = { ...meta({ range }), ...heatmap(handle, rows, { range }) };
  }

  const ytdFrom = `${today.slice(0, 4)}-01-01`;
  const last = [...syncs.values()].filter(Boolean).sort().at(-1) || null;
  const links = {};
  for (const p of Object.keys(files)) links[p.replace(/^api\/v1\//, '').replace(/\.json$/, '')] = `${baseUrl}/${p}`;
  files['api/v1/profile.json'] = {
    ...meta({}),
    storage: 'github',
    totals: totals(rows),
    thisYear: totals(rows.filter((x) => x.date >= ytdFrom)),
    tools: tools(rows).map((t) => t.tool),
    models: models(rows).filter((m) => m.model !== 'cursor/all').length,
    devices: machines.length,
    firstDay: rows.reduce((m, x) => (!m || x.date < m ? x.date : m), null),
    lastDay: rows.reduce((m, x) => (!m || x.date > m ? x.date : m), null),
    lastSync: last,
    links,
  };
  // Every row, so other services (like the hosted bridge) can run any query
  files['api/v1/rows.json'] = { ...meta({}), machines: machines.map((m) => ({ device: m.device, updatedAt: m.updatedAt })), rows };
  files['api/v1/index.json'] = {
    name: 'tokentracker static API',
    version: 'v1',
    handle,
    generatedAt,
    note: 'Pre-built JSON. Ranges: all (default), ytd, 30d, 90d, 365d as a folder, e.g. api/v1/30d/usage.json. For any other filter use the hosted bridge.',
    resources: Object.keys(links).sort(),
  };
  return files;
}

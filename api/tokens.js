import { publicAccount } from '../lib/auth.js';
import { refreshCursor } from '../lib/cursor.js';
import { ensureSchema } from '../lib/db.js';
import { getActivity } from '../lib/activity.js';
import { buildSeries, resolveRange, TOOL_NAMES } from '../public/lib/heatmap.js';

// GET /api/tokens?handle=you&range=90d&group=day|week|month|tool|model&tools=a,b&format=json|csv
// Raw token data for building your own charts. Public, CORS-open, edge cached.
const GROUPS = ['day', 'week', 'month', 'tool', 'model'];

function weekKey(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay()); // week starting Sunday
  return d.toISOString().slice(0, 10);
}

export function shape(data, query) {
  const range = /^(year|\d{1,3}d|365d|rolling|\d{4})$/.test(query.range || '') ? query.range : 'year';
  const group = GROUPS.includes(query.group) ? query.group : 'day';
  const tools = query.tools ? String(query.tools).split(',').filter((t) => /^[a-z0-9-]{1,30}$/.test(t)) : null;
  const [start, end] = resolveRange(range);

  let rows;
  if (group === 'tool') {
    const totals = {};
    for (const d of data.activityCounts || []) {
      if (d.date < start || d.date > end) continue;
      for (const [k, v] of Object.entries(d.sources || {})) {
        if (!tools || tools.includes(k)) totals[k] = (totals[k] || 0) + v;
      }
    }
    rows = Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([tool, tokens]) => ({ tool, name: TOOL_NAMES[tool] || tool, tokens }));
  } else if (group === 'model') {
    // Per-model totals are all-time; the range filter doesn't apply to them
    rows = (data.models || [])
      .filter((m) => m.model !== 'cursor/all' && (!tools || tools.includes(m.source)))
      .map((m) => ({ tool: m.source, model: m.model, tokens: m.tokens, input: m.input, output: m.output, cache: m.cache, responses: m.messages }));
  } else {
    const series = buildSeries(data, { range, tools });
    if (group === 'day') {
      rows = series.map(({ date, count }) => ({ date, tokens: count }));
    } else {
      const buckets = new Map();
      for (const { date, count } of series) {
        const key = group === 'week' ? weekKey(date) : date.slice(0, 7);
        buckets.set(key, (buckets.get(key) || 0) + count);
      }
      rows = [...buckets].map(([period, tokens]) => ({ [group]: period, tokens }));
    }
  }

  const total = group === 'model' ? rows.reduce((s, r) => s + r.tokens, 0) : rows.reduce((s, r) => s + r.tokens, 0);
  return { handle: data.handle, range: { start, end }, group, tools, total, rows };
}

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const handle = String(req.query.handle || '').toLowerCase();
  try {
    await ensureSchema();
    const account = await publicAccount(handle);
    if (!account) return res.status(404).json({ error: 'No such profile' });
    if (account.cursor_handle) await refreshCursor({ account: handle, handle: account.cursor_handle }).catch(() => {});

    const out = shape(await getActivity(handle), req.query);
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.setHeader('CDN-Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');
    if (req.query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `inline; filename="${handle}-tokens-${out.group}.csv"`);
      return res.status(200).send(toCsv(out.rows));
    }
    return res.status(200).json(out);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load tokens' });
  }
}

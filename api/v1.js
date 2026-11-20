import {
  ApiError, devices, filterRows, heatmap, models, parseFilters, stats, toCsv, tools, totals, usage,
} from '../cli/core/query.js';

// Public, read-only v1 API. Stateless: a user's handle is their GitHub
// username, and their rows come from their own tokentracker-data repo's
// GitHub Pages (api/v1/rows.json). Nothing is stored here. Routed by vercel.json:
//   /api/v1/users/:handle            -> resource=profile
//   /api/v1/users/:handle/:resource  -> usage | models | tools | heatmap | stats | devices
//   /api/v1/github/:owner(/:resource) is an alias
const RESOURCES = ['profile', 'usage', 'models', 'tools', 'heatmap', 'stats', 'devices'];
const LIST = new Set(['usage', 'models', 'tools', 'devices']);

function send(res, status, body) {
  res.status(status).json(body);
}

const GITHUB_REPO = 'tokentracker-data';
const OWNER_RE = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const pagesBase = (owner) => `https://${owner}.github.io/${GITHUB_REPO}`;
const ghCache = new Map();

/** Read a user's rows.json from their GitHub Pages; nothing is stored here. */
async function githubSource(owner) {
  if (!OWNER_RE.test(owner)) throw new ApiError(400, 'bad_owner', 'Invalid GitHub username');
  let hit = ghCache.get(owner);
  if (!hit || Date.now() - hit.at > 60_000) {
    const res = await fetch(`${pagesBase(owner)}/api/v1/rows.json`, { headers: { 'user-agent': 'tokentracker' } }).catch(() => null);
    if (!res || res.status === 404) throw new ApiError(404, 'user_not_found', `No tokentracker data at github.com/${owner}/${GITHUB_REPO} (or its GitHub Pages isn't built yet)`);
    if (!res.ok) throw new ApiError(502, 'github_unavailable', `GitHub Pages returned ${res.status}`);
    const body = await res.json();
    hit = { at: Date.now(), rows: body.rows || [], machines: body.machines || [] };
    ghCache.set(owner, hit);
  }
  return {
    loadRows: async (f) => filterRows(hit.rows, f),
    syncs: async () => new Map(hit.machines.map((m) => [m.device, m.updatedAt])),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return send(res, 405, { error: { code: 'method_not_allowed', message: 'Only GET is supported' } });

  const githubOwner = req.query.github ? String(req.query.github).toLowerCase() : null;
  const handle = githubOwner || String(req.query.handle || '').toLowerCase();
  const resource = String(req.query.resource || 'profile');
  const origin = `https://${req.headers.host}`;

  if (!handle) {
    res.setHeader('CDN-Cache-Control', 'public, s-maxage=3600');
    return send(res, 200, {
      name: 'tokentracker API',
      version: 'v1',
      docs: `${origin}/docs`,
      openapi: `${origin}/openapi.json`,
      llms: `${origin}/llms.txt`,
      auth: 'None. All reads are public and keyless.',
      endpoints: {
        profile: `${origin}/api/v1/users/{handle}`,
        usage: `${origin}/api/v1/users/{handle}/usage?group=day|week|month|year|total&split=tool|model`,
        models: `${origin}/api/v1/users/{handle}/models`,
        tools: `${origin}/api/v1/users/{handle}/tools`,
        heatmap: `${origin}/api/v1/users/{handle}/heatmap?range=year|365d|90d|2026&levels=5&weekStart=sun|mon`,
        stats: `${origin}/api/v1/users/{handle}/stats`,
        devices: `${origin}/api/v1/users/{handle}/devices`,
      },
      filters: 'range=all|ytd|Nd|YYYY, from=YYYY-MM-DD, to=YYYY-MM-DD, tools=a,b, models=x,y, format=csv (list endpoints)',
      example: `${origin}/api/v1/users/bicrick/usage?range=30d&group=day`,
    });
  }

  try {
    // Only requests that miss the CDN cache reach this point

    if (!RESOURCES.includes(resource)) throw new ApiError(404, 'unknown_resource', `Unknown resource. Use one of: ${RESOURCES.slice(1).join(', ')}`);
    // Where the rows come from: our database, or a user's own GitHub data repo
    const src = await githubSource(handle);
    const filters = parseFilters(req.query);
    const rows = await src.loadRows(filters);
    const meta = { handle, filters: { from: filters.from, to: filters.to, tools: filters.tools, models: filters.models } };
    let data;

    switch (resource) {
      case 'profile': {
        const all = filters.from || filters.to ? rows : rows;
        const ytdFrom = `${new Date().toISOString().slice(0, 4)}-01-01`;
        const syncs = await src.syncs();
        const last = [...syncs.values()].sort().at(-1) || null;
        data = {
          handle,
          url: `${origin}/u/${handle}`,
          data: `https://github.com/${handle}/${GITHUB_REPO}`,
          static: `${pagesBase(handle)}/api/v1/`,
          totals: totals(all),
          thisYear: totals(all.filter((r) => r.date >= ytdFrom)),
          tools: tools(all).map((t) => t.tool),
          models: models(all).filter((m) => m.model !== 'cursor/all').length,
          devices: [...syncs.keys()].filter((d) => d !== 'cursor.com').length,
          firstDay: all.reduce((m, r) => (!m || r.date < m ? r.date : m), null),
          lastDay: all.reduce((m, r) => (!m || r.date > m ? r.date : m), null),
          lastSync: last,
          links: Object.fromEntries(RESOURCES.slice(1).map((r) => [r, `${origin}/api/v1/users/${handle}/${r}`])),
        };
        break;
      }
      case 'usage': {
        const group = String(req.query.group || 'day');
        const rowsOut = usage(rows, filters, { group, split: req.query.split || null, fill: req.query.fill !== 'false' });
        data = { group, split: req.query.split || null, totals: totals(rows), rows: rowsOut };
        break;
      }
      case 'models':
        data = { rows: models(rows) };
        break;
      case 'tools':
        data = { rows: tools(rows) };
        break;
      case 'heatmap':
        // The heatmap has its own calendar range handling
        data = heatmap(handle, await src.loadRows({ ...filters, from: null, to: null }), req.query);
        break;
      case 'stats':
        data = stats(rows);
        break;
      case 'devices':
        data = { rows: devices(rows, await src.syncs()) };
        break;
    }

    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.setHeader('CDN-Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
    if (req.query.format === 'csv') {
      if (!LIST.has(resource)) throw new ApiError(400, 'csv_unsupported', `format=csv is available for ${[...LIST].join(', ')}`);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      return res.status(200).send(toCsv(data.rows));
    }
    return send(res, 200, { ...meta, ...data });
  } catch (err) {
    if (err instanceof ApiError) {
      // Cache client errors briefly so repeated junk requests never reach the database
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      res.setHeader('CDN-Cache-Control', `public, s-maxage=${err.status === 404 ? 300 : 60}`);
      return send(res, err.status, { error: { code: err.code, message: err.message } });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('CDN-Cache-Control', 'no-store');
    console.error(err);
    return send(res, 500, { error: { code: 'internal', message: 'Something went wrong' } });
  }
}

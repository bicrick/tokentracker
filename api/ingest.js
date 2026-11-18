import { accountFromRequest, cors } from '../lib/auth.js';
import { ensureSchema, replaceUsage } from '../lib/db.js';
import { rateLimit, tooMany } from '../lib/ratelimit.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
// Any local tool id; 'cursor' is fetched server-side and can't be uploaded
const SOURCE_RE = /^[a-z0-9][a-z0-9-]{0,29}$/;
const isSource = (s) => typeof s === 'string' && SOURCE_RE.test(s) && s !== 'cursor';
const NUMERIC = ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'messages'];

// Only daily numeric aggregates are accepted. Anything else is rejected so
// the payload can't carry prompts, code, or credentials.
function validate(body) {
  if (!body || typeof body !== 'object') return 'body must be JSON';
  if (typeof body.device !== 'string' || !body.device || body.device.length > 100) return 'invalid device';
  if (!Array.isArray(body.sources) || body.sources.length > 50 || !body.sources.every(isSource)) return 'invalid sources';
  if (body.since !== undefined && !DATE.test(body.since)) return 'invalid since';
  if (!Array.isArray(body.rows) || body.rows.length > 50_000) return 'invalid rows';

  for (const row of body.rows) {
    const keys = Object.keys(row);
    const allowed = new Set(['date', 'source', 'model', ...NUMERIC]);
    if (keys.some((k) => !allowed.has(k))) return `unexpected field in row: ${keys.find((k) => !allowed.has(k))}`;
    if (!DATE.test(row.date)) return `invalid date: ${row.date}`;
    if (!body.sources.includes(row.source)) return `row source not in sources: ${row.source}`;
    if (typeof row.model !== 'string' || row.model.length > 200) return 'invalid model';
    for (const n of NUMERIC) {
      if (row[n] != null && (!Number.isSafeInteger(row[n]) || row[n] < 0)) return `invalid ${n}`;
    }
  }
  return null;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const error = validate(req.body);
  if (error) return res.status(400).json({ error });

  try {
    await ensureSchema();
    const account = await accountFromRequest(req);
    if (!account) return res.status(401).json({ error: 'Unauthorized' });
    const limited = await rateLimit(`ingest:${account.handle}`, { limit: 120, windowSeconds: 3600 });
    if (!limited.ok) return tooMany(res, limited);
    const { device, sources, rows, since } = req.body;
    await replaceUsage({ account: account.handle, device, sources, rows, since });
    return res.status(200).json({ ok: true, account: account.handle, rows: rows.length, since: since ?? null });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to store usage' });
  }
}

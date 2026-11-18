import { ACCOUNT, cors, isAuthorizedIngest } from '../lib/auth.js';
import { ensureSchema, replaceUsage } from '../lib/db.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_SOURCES = new Set(['opencode', 'claude-code']);
const NUMERIC = ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'messages'];

// Only daily numeric aggregates are accepted. Anything else is rejected so
// the payload can't carry prompts, code, or credentials.
function validate(body) {
  if (!body || typeof body !== 'object') return 'body must be JSON';
  if (typeof body.device !== 'string' || !body.device || body.device.length > 100) return 'invalid device';
  if (!Array.isArray(body.sources) || !body.sources.every((s) => ALLOWED_SOURCES.has(s))) return 'invalid sources';
  if (!Array.isArray(body.rows) || body.rows.length > 50_000) return 'invalid rows';

  for (const row of body.rows) {
    const keys = Object.keys(row);
    const allowed = new Set(['date', 'source', 'model', ...NUMERIC]);
    if (keys.some((k) => !allowed.has(k))) return `unexpected field in row: ${keys.find((k) => !allowed.has(k))}`;
    if (!DATE.test(row.date)) return `invalid date: ${row.date}`;
    if (!ALLOWED_SOURCES.has(row.source)) return `invalid source: ${row.source}`;
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
  if (!isAuthorizedIngest(req)) return res.status(401).json({ error: 'Unauthorized' });

  const error = validate(req.body);
  if (error) return res.status(400).json({ error });

  try {
    await ensureSchema();
    await replaceUsage({ account: ACCOUNT, ...req.body });
    return res.status(200).json({ ok: true, rows: req.body.rows.length });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to store usage' });
  }
}

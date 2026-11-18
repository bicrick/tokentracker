import { cors, hashKey, newKey, OWNER, validHandle } from '../lib/auth.js';
import { createAccount, ensureSchema } from '../lib/db.js';
import { refreshCursor } from '../lib/cursor.js';
import { clientIp, rateLimit, tooMany } from '../lib/ratelimit.js';

const CURSOR_RE = /^[A-Za-z0-9_-]{1,40}$/;

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const handle = String(req.body?.handle || '').toLowerCase();
  const cursorHandle = req.body?.cursorHandle ? String(req.body.cursorHandle) : null;

  if (handle === OWNER) return res.status(409).json({ error: 'Handle is taken' });
  if (!validHandle(handle)) {
    return res.status(400).json({ error: 'Handle must be 1-30 lowercase letters, numbers or dashes' });
  }
  if (cursorHandle && !CURSOR_RE.test(cursorHandle)) {
    return res.status(400).json({ error: 'Invalid Cursor handle' });
  }

  try {
    await ensureSchema();
    const limited = await rateLimit(`signup:${clientIp(req)}`, { limit: 5, windowSeconds: 3600 });
    if (!limited.ok) return tooMany(res, limited);
    const key = newKey();
    const created = await createAccount({ handle, keyHash: hashKey(key), cursorHandle });
    if (!created) return res.status(409).json({ error: 'Handle is taken' });

    if (cursorHandle) {
      await refreshCursor({ account: handle, handle: cursorHandle, force: true })
        .catch((err) => console.warn('initial cursor fetch failed:', err.message));
    }

    // The key is only ever returned here; the server stores its hash
    return res.status(201).json({ handle, key });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create account' });
  }
}

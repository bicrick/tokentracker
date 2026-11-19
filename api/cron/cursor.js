import { isAuthorizedCron, OWNER, OWNER_CURSOR } from '../../lib/auth.js';
import { refreshCursor } from '../../lib/cursor.js';
import { db, ensureSchema } from '../../lib/db.js';
import { pruneRateLimits } from '../../lib/ratelimit.js';

export default async function handler(req, res) {
  if (!isAuthorizedCron(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    await ensureSchema();
    const accounts = await db()`select handle, cursor_handle from accounts where cursor_handle is not null`;
    const targets = [{ handle: OWNER, cursor_handle: OWNER_CURSOR }, ...accounts.filter((a) => a.handle !== OWNER)];

    const results = {};
    for (const a of targets) {
      results[a.handle] = await refreshCursor({ account: a.handle, handle: a.cursor_handle, force: true })
        .catch((err) => ({ error: err.message }));
    }
    const pruned = await pruneRateLimits().catch((err) => ({ error: err.message }));
    return res.status(200).json({ ok: true, results, pruned });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: err.message });
  }
}

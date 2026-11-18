import { ACCOUNT, CURSOR_HANDLE, isAuthorizedCron } from '../../lib/auth.js';
import { refreshCursor } from '../../lib/cursor.js';
import { ensureSchema } from '../../lib/db.js';

export default async function handler(req, res) {
  if (!isAuthorizedCron(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    await ensureSchema();
    const result = await refreshCursor({ account: ACCOUNT, handle: CURSOR_HANDLE, force: true });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: err.message });
  }
}

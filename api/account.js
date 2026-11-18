import { accountFromRequest, cors, OWNER } from '../lib/auth.js';
import { deleteAccount, ensureSchema, updateCursorHandle } from '../lib/db.js';
import { refreshCursor } from '../lib/cursor.js';

const CURSOR_RE = /^[A-Za-z0-9_-]{1,40}$/;

// GET: who am I. POST: update settings. DELETE: remove account and all data.
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    await ensureSchema();
    const account = await accountFromRequest(req);
    if (!account) return res.status(401).json({ error: 'Unauthorized' });

    if (req.method === 'GET') {
      return res.status(200).json({ handle: account.handle, cursorHandle: account.cursor_handle || null });
    }

    if (req.method === 'POST') {
      const cursorHandle = req.body?.cursorHandle ? String(req.body.cursorHandle) : null;
      if (cursorHandle && !CURSOR_RE.test(cursorHandle)) {
        return res.status(400).json({ error: 'Invalid Cursor handle' });
      }
      if (account.handle === OWNER) {
        return res.status(400).json({ error: 'Owner settings are configured with env vars' });
      }
      await updateCursorHandle(account.handle, cursorHandle);
      if (cursorHandle) await refreshCursor({ account: account.handle, handle: cursorHandle, force: true });
      return res.status(200).json({ ok: true, cursorHandle });
    }

    if (req.method === 'DELETE') {
      if (account.handle === OWNER) {
        return res.status(400).json({ error: 'Owner account cannot be deleted via API' });
      }
      await deleteAccount(account.handle);
      return res.status(200).json({ ok: true, deleted: account.handle });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Request failed' });
  }
}

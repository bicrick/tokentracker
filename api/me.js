import { OWNER } from '../lib/auth.js';
import { deleteAccount, ensureSchema, updateCursorHandle } from '../lib/db.js';
import { listDevices, revokeDevice, sessionAccount, sessionCookie } from '../lib/authflow.js';
import { refreshCursor } from '../lib/cursor.js';

const CURSOR_RE = /^[A-Za-z0-9_-]{1,40}$/;

// Settings page API, authenticated by the web session cookie from email sign-in.
// GET: account + machines. POST { cursorHandle } or { revoke: id }. DELETE: delete account.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    await ensureSchema();
    const account = await sessionAccount(req);
    if (!account) return res.status(401).json({ error: 'Not signed in' });

    if (req.method === 'GET') {
      return res.status(200).json({
        handle: account.handle,
        email: account.email,
        cursorHandle: account.cursor_handle || null,
        devices: await listDevices(account.handle),
      });
    }

    if (req.method === 'POST') {
      if (req.body?.revoke) {
        const done = await revokeDevice(account.handle, String(req.body.revoke));
        return done ? res.status(200).json({ ok: true, revoked: done.device }) : res.status(404).json({ error: 'No such machine' });
      }
      if ('cursorHandle' in (req.body || {})) {
        const cursorHandle = req.body.cursorHandle ? String(req.body.cursorHandle) : null;
        if (cursorHandle && !CURSOR_RE.test(cursorHandle)) return res.status(400).json({ error: 'Invalid Cursor handle' });
        await updateCursorHandle(account.handle, cursorHandle);
        if (cursorHandle) await refreshCursor({ account: account.handle, handle: cursorHandle, force: true }).catch(() => {});
        return res.status(200).json({ ok: true, cursorHandle });
      }
      return res.status(400).json({ error: 'Nothing to change' });
    }

    if (req.method === 'DELETE') {
      if (account.handle === OWNER) return res.status(400).json({ error: 'The site owner account cannot be deleted here' });
      await deleteAccount(account.handle);
      res.setHeader('Set-Cookie', sessionCookie('', 0));
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Request failed' });
  }
}

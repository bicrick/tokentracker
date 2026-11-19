import { cors, publicAccount, validHandle } from '../../lib/auth.js';
import { accountByHandle, ensureSchema } from '../../lib/db.js';
import {
  accountByEmail, approveRequest, createRequest, describeRequest, EMAIL_RE, endSession, pollRequest, sessionCookie,
} from '../../lib/authflow.js';
import { sendEmail, signInEmail } from '../../lib/email.js';
import { clientIp, rateLimit, tooMany } from '../../lib/ratelimit.js';
import { refreshCursor } from '../../lib/cursor.js';

const CURSOR_RE = /^[A-Za-z0-9_-]{1,40}$/;
const DEVICE_RE = /^[\w.-]{1,40}$/;

// POST /api/auth/start   { email, purpose: signup|login|web, handle?, cursorHandle?, device? }
// GET  /api/auth/describe?token=
// POST /api/auth/verify  { token }      (from the confirm page)
// POST /api/auth/poll    { deviceCode } (CLI, every few seconds)
// POST /api/auth/logout
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  const action = req.query.action;

  try {
    await ensureSchema();

    if (action === 'start' && req.method === 'POST') {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const purpose = ['signup', 'login', 'web'].includes(req.body?.purpose) ? req.body.purpose : null;
      const handle = req.body?.handle ? String(req.body.handle).toLowerCase() : null;
      const cursor = req.body?.cursorHandle ? String(req.body.cursorHandle) : null;
      const device = req.body?.device ? String(req.body.device) : null;
      const machineId = /^[a-f0-9]{64}$/.test(String(req.body?.machineId || '')) ? String(req.body.machineId) : null;
      if (!purpose) return res.status(400).json({ error: 'Invalid request' });
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
      if (device && !DEVICE_RE.test(device)) return res.status(400).json({ error: 'Invalid machine name' });

      const byIp = await rateLimit(`auth-ip:${clientIp(req)}`, { limit: 10, windowSeconds: 3600 });
      if (!byIp.ok) return tooMany(res, byIp);
      const byEmail = await rateLimit(`auth-email:${email}`, { limit: 5, windowSeconds: 3600 });
      if (!byEmail.ok) return tooMany(res, byEmail);

      const existing = await accountByEmail(email);
      if (purpose === 'signup') {
        if (!validHandle(handle)) return res.status(400).json({ error: 'Handle must be 1-30 lowercase letters, numbers or dashes' });
        if (cursor && !CURSOR_RE.test(cursor)) return res.status(400).json({ error: 'Invalid Cursor handle' });
        if (existing) return res.status(409).json({ error: `This email already has an account (@${existing.handle}). Choose "sign in" instead.` });
        if (await publicAccount(handle)) return res.status(409).json({ error: 'Handle is taken' });
      } else if (!existing) {
        return res.status(404).json({ error: 'No account uses this email' });
      }

      const reqInfo = await createRequest({ email, purpose, handle, device, cursor, machineId });
      const link = `${process.env.TOKENTRACK_PUBLIC_URL || `https://${req.headers.host}`}/auth?token=${reqInfo.emailToken}`;
      await sendEmail({ to: email, ...signInEmail({ link, purpose, handle: handle || existing?.handle, device }) });
      return res.status(200).json({ ok: true, deviceCode: reqInfo.deviceCode, expiresIn: reqInfo.expiresIn, interval: 3 });
    }

    if (action === 'describe' && req.method === 'GET') {
      const info = await describeRequest(String(req.query.token || ''));
      if (!info) return res.status(404).json({ error: 'Unknown link' });
      return res.status(200).json({
        purpose: info.purpose,
        email: info.email.replace(/^(.).*(@.*)$/, '$1…$2'),
        handle: info.handle,
        device: info.device,
        usable: info.status === 'pending' && !info.expired,
      });
    }

    if (action === 'verify' && req.method === 'POST') {
      const result = await approveRequest(String(req.body?.token || ''));
      if (result.error) return res.status(400).json(result);
      if (result.sessionToken) res.setHeader('Set-Cookie', sessionCookie(result.sessionToken));
      if (result.purpose === 'signup') {
        const acct = await accountByHandle(result.handle);
        if (acct?.cursor_handle) await refreshCursor({ account: result.handle, handle: acct.cursor_handle, force: true }).catch(() => {});
      }
      return res.status(200).json({ ok: true, purpose: result.purpose, handle: result.handle });
    }

    if (action === 'poll' && req.method === 'POST') {
      const out = await pollRequest(String(req.body?.deviceCode || ''));
      return res.status(200).json(out);
    }

    if (action === 'logout' && req.method === 'POST') {
      await endSession(req);
      res.setHeader('Set-Cookie', sessionCookie('', 0));
      return res.status(200).json({ ok: true });
    }

    return res.status(404).json({ error: 'Not found' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message.startsWith('email') ? 'Could not send the email. Try again shortly.' : 'Request failed' });
  }
}

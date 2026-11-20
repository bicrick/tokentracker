import { isAuthorizedCron } from '../../lib/auth.js';
import { db, ensureSchema } from '../../lib/db.js';
import { sendEmail, staleEmail } from '../../lib/email.js';

// Daily: email the owner once when a machine that used to upload goes quiet
// for 3 days. Machines silent for over 30 days are left alone (retired), and
// each machine gets one email per stall: uploading again resets it.
export default async function handler(req, res) {
  if (!isAuthorizedCron(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await ensureSchema();
    const q = db();
    const stale = await q`
      select k.key_hash, k.handle, k.device, k.last_used, a.email
      from device_keys k join accounts a on a.handle = k.handle
      where k.revoked_at is null and a.email is not null and k.last_used is not null
        and k.last_used < now() - interval '3 days' and k.last_used > now() - interval '30 days'
        and (k.stale_notified_at is null or k.stale_notified_at < k.last_used)`;
    const settingsUrl = `https://${req.headers.host}/settings`;
    const sent = [];
    for (const k of stale) {
      try {
        await sendEmail({ to: k.email, ...staleEmail({ handle: k.handle, device: k.device, lastSync: k.last_used, settingsUrl }) });
        await q`update device_keys set stale_notified_at = now() where key_hash = ${k.key_hash}`;
        sent.push(`${k.handle}/${k.device}`);
      } catch (err) {
        console.error('stale email failed', k.handle, k.device, err.message);
      }
    }
    return res.status(200).json({ ok: true, checked: stale.length, sent });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

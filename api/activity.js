import { cors, OWNER, publicAccount } from '../lib/auth.js';
import { refreshCursor } from '../lib/cursor.js';
import { ensureSchema } from '../lib/db.js';
import { getActivity } from '../lib/activity.js';
import { limitHeaders, readLimit, tooMany } from '../lib/ratelimit.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const handle = String(req.query.handle || OWNER).toLowerCase();

  try {
    const limited = await readLimit(req);
    limitHeaders(res, limited);
    if (!limited.ok) return tooMany(res, limited);

    await ensureSchema();
    const account = await publicAccount(handle);
    if (!account) {
      res.setHeader('CDN-Cache-Control', 'public, s-maxage=300');
      return res.status(404).json({ error: 'No such profile' });
    }

    // Lazily refresh Cursor if the cron hasn't run recently
    if (account.cursor_handle) {
      await refreshCursor({ account: handle, handle: account.cursor_handle })
        .catch((err) => console.warn('cursor refresh failed:', err.message));
    }

    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.setHeader('CDN-Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
    return res.status(200).json(await getActivity(handle));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load activity' });
  }
}

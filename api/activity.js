import { ACCOUNT, CURSOR_HANDLE, cors } from '../lib/auth.js';
import { refreshCursor } from '../lib/cursor.js';
import { ensureSchema } from '../lib/db.js';
import { getActivity } from '../lib/activity.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    await ensureSchema();
    // Lazily refresh Cursor if the cron hasn't run recently
    await refreshCursor({ account: ACCOUNT, handle: CURSOR_HANDLE })
      .catch((err) => console.warn('cursor refresh failed:', err.message));

    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.setHeader('CDN-Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
    return res.status(200).json(await getActivity(ACCOUNT));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load activity' });
  }
}

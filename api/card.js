import { publicAccount } from '../lib/auth.js';
import { refreshCursor } from '../lib/cursor.js';
import { ensureSchema } from '../lib/db.js';
import { getActivity } from '../lib/activity.js';
import { renderCard } from '../lib/cards.js';

// GET /api/card?handle=you&type=heatmap&theme=dark&cells=square&accent=6b9eff&range=year
// Also served at /u/<handle>.svg. Cached at the edge for an hour, so embeds on
// busy pages cost about one function run per profile per hour.
export default async function handler(req, res) {
  const handle = String(req.query.handle || '').toLowerCase();
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    await ensureSchema();
    const account = await publicAccount(handle);
    if (!account) {
      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.status(404).send(`<svg xmlns="http://www.w3.org/2000/svg" width="260" height="40"><rect width="260" height="40" fill="#121317"/><text x="14" y="25" font-family="monospace" font-size="12" fill="#8b8e97">no tokentracker profile: ${handle.replace(/[^a-z0-9-]/g, '')}</text></svg>`);
    }
    if (account.cursor_handle) {
      await refreshCursor({ account: handle, handle: account.cursor_handle }).catch(() => {});
    }
    const svg = renderCard(await getActivity(handle), req.query);
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.setHeader('CDN-Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).send(svg);
  } catch (err) {
    console.error(err);
    return res.status(500).send('error');
  }
}

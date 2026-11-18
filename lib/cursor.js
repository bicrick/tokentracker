import { fetchCursorDaily } from './cursor-profile.js';
import { getMeta, replaceUsage, setMeta } from './db.js';

const TTL_MS = 60 * 60 * 1000;

export async function refreshCursor({ account, handle, force = false }) {
  if (!handle) return { skipped: 'no cursor handle' };

  const key = `cursor_fetched_at:${account}`;
  const last = Number(await getMeta(key)) || 0;
  if (!force && Date.now() - last < TTL_MS) return { skipped: 'fresh' };

  const daily = await fetchCursorDaily(handle);
  await replaceUsage({
    account,
    device: 'cursor.com',
    sources: ['cursor'],
    rows: daily
      .filter((d) => d.count > 0)
      .map((d) => ({ source: 'cursor', date: d.date, model: 'cursor/all', input: d.count })),
  });
  await setMeta(key, String(Date.now()));
  return { days: daily.length };
}

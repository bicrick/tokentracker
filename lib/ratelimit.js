import { db } from './db.js';

let ready;
function ensure() {
  ready ||= db()`
    create table if not exists rate_limits (
      key          text primary key,
      window_start timestamptz not null,
      count        integer not null
    )`;
  return ready;
}

/**
 * Fixed-window rate limit. Returns { ok, remaining, retryAfter }.
 * One upsert per call, so it adds no extra round trip beyond the write itself.
 */
export async function rateLimit(key, { limit, windowSeconds }) {
  await ensure();
  const rows = await db()`
    insert into rate_limits (key, window_start, count) values (${key}, now(), 1)
    on conflict (key) do update set
      count = case when rate_limits.window_start < now() - make_interval(secs => ${windowSeconds})
                   then 1 else rate_limits.count + 1 end,
      window_start = case when rate_limits.window_start < now() - make_interval(secs => ${windowSeconds})
                          then now() else rate_limits.window_start end
    returning count, extract(epoch from (window_start + make_interval(secs => ${windowSeconds}) - now()))::int as retry`;
  const { count, retry } = rows[0];
  return { ok: count <= limit, remaining: Math.max(0, limit - count), retryAfter: Math.max(1, retry) };
}

export function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
}

export function tooMany(res, r) {
  res.setHeader('Retry-After', String(r.retryAfter));
  return res.status(429).json({ error: `Too many requests, try again in ${r.retryAfter}s` });
}

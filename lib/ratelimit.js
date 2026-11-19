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

// Vercel sets x-real-ip from the actual connection; callers can't spoof it the
// way they can prepend entries to x-forwarded-for
export function clientIp(req) {
  const h = req.headers;
  return String(h['x-real-ip'] || h['x-vercel-forwarded-for'] || h['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .split(',')[0]
    .trim();
}

// Public reads: generous per-IP budget for requests that miss the CDN cache
export const READ_LIMIT = { limit: 120, windowSeconds: 60 };

export function readLimit(req) {
  return rateLimit(`read:${clientIp(req)}`, READ_LIMIT);
}

/** Standard rate limit headers on every limited response, hit or not. */
export function limitHeaders(res, r, limit = READ_LIMIT.limit) {
  res.setHeader('RateLimit-Limit', String(limit));
  res.setHeader('RateLimit-Remaining', String(r.remaining));
  res.setHeader('RateLimit-Reset', String(r.retryAfter));
}

export function tooMany(res, r, body) {
  res.setHeader('Retry-After', String(r.retryAfter));
  // Never let the CDN serve one client's 429 to everyone else
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('CDN-Cache-Control', 'no-store');
  return res.status(429).json(body || { error: `Too many requests, try again in ${r.retryAfter}s` });
}

/** Drop counters whose window ended long ago, so the table stays small. */
export async function pruneRateLimits() {
  await ensure();
  const rows = await db()`delete from rate_limits where window_start < now() - interval '1 day' returning 1`;
  return rows.length;
}

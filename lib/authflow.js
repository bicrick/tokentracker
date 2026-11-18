// Email magic-link sign-in with a CLI device flow, per-machine keys, and web
// sessions for the settings page.
import { createHash, randomBytes } from 'node:crypto';
import { db } from './db.js';
import { HANDLE_RE, hashKey, newKey, OWNER } from './auth.js';

const TTL_MINUTES = 15;
const SESSION_DAYS = 30;
export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

const token = () => randomBytes(24).toString('base64url');
const sha = (s) => createHash('sha256').update(s).digest('hex');

export async function accountByEmail(email) {
  const rows = await db()`select handle, email, cursor_handle from accounts where lower(email) = lower(${email})`;
  return rows[0] ?? null;
}

/** Create a pending request. Returns the emailed token and (for CLI flows) the device code. */
export async function createRequest({ email, purpose, handle = null, device = null, cursor = null }) {
  const id = token();
  const emailToken = token();
  const deviceCode = purpose === 'web' ? null : token();
  await db()`
    insert into auth_requests (id, token_hash, device_hash, email, handle, purpose, device, cursor, expires_at)
    values (${id}, ${sha(emailToken)}, ${deviceCode ? sha(deviceCode) : null}, ${email.toLowerCase()}, ${handle},
            ${purpose}, ${device}, ${cursor}, now() + make_interval(mins => ${TTL_MINUTES}))`;
  return { emailToken, deviceCode, expiresIn: TTL_MINUTES * 60 };
}

/** Peek at a request from its emailed token (for the confirm page). */
export async function describeRequest(emailToken) {
  const rows = await db()`
    select purpose, email, handle, device, status, expires_at < now() as expired
    from auth_requests where token_hash = ${sha(emailToken)}`;
  return rows[0] ?? null;
}

/**
 * Approve a request from the confirm page. Signups create the account here.
 * Returns { ok, purpose, handle, sessionToken? } or { error }.
 */
export async function approveRequest(emailToken) {
  const q = db();
  const rows = await q`
    update auth_requests set status = 'approved'
    where token_hash = ${sha(emailToken)} and status = 'pending' and expires_at > now()
    returning id, purpose, email, handle, cursor`;
  const r = rows[0];
  if (!r) return { error: 'This link has expired or was already used.' };

  let handle = r.handle;
  if (r.purpose === 'signup') {
    if (!HANDLE_RE.test(handle || '')) return { error: 'Invalid handle.' };
    // Accounts made by email have no shared key; each machine gets its own
    const created = await q`
      insert into accounts (handle, key_hash, cursor_handle, email)
      values (${handle}, ${hashKey(newKey())}, ${r.cursor}, ${r.email})
      on conflict do nothing returning handle`;
    if (!created.length) {
      await q`update auth_requests set status = 'failed' where id = ${r.id}`;
      return { error: 'That handle or email was taken in the meantime. Run init again.' };
    }
  } else {
    const acct = await accountByEmail(r.email);
    if (!acct) return { error: 'No account uses this email.' };
    handle = acct.handle;
  }
  await q`update auth_requests set result_handle = ${handle} where id = ${r.id}`;

  if (r.purpose === 'web') {
    const sessionToken = token();
    await q`
      insert into web_sessions (token_hash, handle, expires_at)
      values (${sha(sessionToken)}, ${handle}, now() + make_interval(days => ${SESSION_DAYS}))`;
    await q`update auth_requests set status = 'claimed' where id = ${r.id}`;
    return { ok: true, purpose: r.purpose, handle, sessionToken };
  }
  return { ok: true, purpose: r.purpose, handle };
}

/** CLI polls with its device code; on approval it gets a fresh per-machine key, once. */
export async function pollRequest(deviceCode) {
  const q = db();
  const rows = await q`
    select id, status, device, result_handle, expires_at < now() as expired
    from auth_requests where device_hash = ${sha(deviceCode)}`;
  const r = rows[0];
  if (!r) return { status: 'invalid' };
  if (r.status === 'pending') return { status: r.expired ? 'expired' : 'pending' };
  if (r.status !== 'approved') return { status: r.status === 'claimed' ? 'used' : r.status };

  const claimed = await q`update auth_requests set status = 'claimed' where id = ${r.id} and status = 'approved' returning id`;
  if (!claimed.length) return { status: 'used' };
  const key = newKey();
  await q`insert into device_keys (key_hash, handle, device) values (${hashKey(key)}, ${r.result_handle}, ${r.device || 'machine'})`;
  return { status: 'approved', handle: r.result_handle, key };
}

/** Resolve a per-machine key (and record its use). */
export async function accountFromDeviceKey(key) {
  const rows = await db()`
    update device_keys set last_used = now()
    where key_hash = ${hashKey(key)} and revoked_at is null
    returning handle`;
  if (!rows.length) return null;
  const acct = await db()`select handle, cursor_handle from accounts where handle = ${rows[0].handle}`;
  return acct[0] ?? null;
}

// ── web sessions ─────────────────────────────────────────────────────────────

export const SESSION_COOKIE = 'tt_session';

export function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function sessionCookie(value, maxAgeDays = SESSION_DAYS) {
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeDays * 86400}`;
}

export async function sessionAccount(req) {
  const t = readCookie(req, SESSION_COOKIE);
  if (!t) return null;
  const rows = await db()`
    select a.handle, a.email, a.cursor_handle from web_sessions s join accounts a on a.handle = s.handle
    where s.token_hash = ${sha(t)} and s.expires_at > now()`;
  return rows[0] ?? null;
}

export async function endSession(req) {
  const t = readCookie(req, SESSION_COOKIE);
  if (t) await db()`delete from web_sessions where token_hash = ${sha(t)}`;
}

export async function listDevices(handle) {
  return db()`
    select left(key_hash, 12) as id, device, created_at as "createdAt", last_used as "lastUsed", revoked_at as "revokedAt"
    from device_keys where handle = ${handle} order by created_at desc`;
}

export async function revokeDevice(handle, id) {
  const rows = await db()`
    update device_keys set revoked_at = now()
    where handle = ${handle} and left(key_hash, 12) = ${id} and revoked_at is null returning device`;
  return rows[0] ?? null;
}

export async function setEmail(handle, email) {
  await db()`update accounts set email = ${email} where handle = ${handle}`;
}

export const isOwner = (handle) => handle === OWNER;

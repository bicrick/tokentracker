import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { accountByHandle, accountByKeyHash, db } from './db.js';

// The site owner's account, backed by env keys (works with no accounts table row)
export const OWNER = process.env.TOKENTRACK_ACCOUNT || 'bicrick';
export const OWNER_CURSOR = process.env.CURSOR_HANDLE || OWNER;

export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;
const RESERVED = new Set(['api', 'u', 'admin', 'www', 'app', 'docs', 'login', 'signup', 'tokentracker']);

export function validHandle(handle) {
  return typeof handle === 'string' && HANDLE_RE.test(handle) && !RESERVED.has(handle);
}

export function newKey() {
  return `tt_${randomBytes(24).toString('hex')}`;
}

export function hashKey(key) {
  return createHash('sha256').update(key).digest('hex');
}

function ownerKeys() {
  return (process.env.TOKENTRACK_INGEST_KEYS || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
}

function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function bearer(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

/** Resolve the account a request's bearer key belongs to, or null. */
export async function accountFromRequest(req) {
  const token = bearer(req);
  if (!token) return null;
  if (ownerKeys().some((k) => safeEqual(k, token))) {
    return { handle: OWNER, cursor_handle: OWNER_CURSOR };
  }
  const legacy = await accountByKeyHash(hashKey(token));
  if (legacy) return legacy;
  // Per-machine keys issued by email sign-in
  const rows = await db()`
    update device_keys set last_used = now()
    where key_hash = ${hashKey(token)} and revoked_at is null
    returning handle, device`;
  if (!rows.length) return null;
  const account = await accountByHandle(rows[0].handle);
  // A per-machine key always uploads as its own machine, whatever name is sent
  return account ? { ...account, device: rows[0].device } : null;
}

/** Look up a public profile by handle. The owner always exists. */
export async function publicAccount(handle) {
  const account = await accountByHandle(handle);
  if (account) return account;
  if (handle === OWNER) return { handle: OWNER, cursor_handle: OWNER_CURSOR };
  return null;
}

export function isAuthorizedCron(req) {
  const secret = process.env.CRON_SECRET;
  return !!secret && req.headers.authorization === `Bearer ${secret}`;
}

export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
}

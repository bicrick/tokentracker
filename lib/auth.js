import { timingSafeEqual } from 'node:crypto';

export const ACCOUNT = process.env.TOKENTRACK_ACCOUNT || 'bicrick';
export const CURSOR_HANDLE = process.env.CURSOR_HANDLE || ACCOUNT;

function keys() {
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

export function isAuthorizedIngest(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return !!token && keys().some((k) => safeEqual(k, token));
}

export function isAuthorizedCron(req) {
  const secret = process.env.CRON_SECRET;
  return !!secret && req.headers.authorization === `Bearer ${secret}`;
}

export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientIp, limitHeaders, READ_LIMIT, tooMany } from '../lib/ratelimit.js';

const fakeRes = () => {
  const res = { headers: {}, statusCode: 200, body: null };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};

test('clientIp prefers the platform-set x-real-ip over a spoofable x-forwarded-for', () => {
  const ip = clientIp({ headers: { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '6.6.6.6, 203.0.113.7' } });
  assert.equal(ip, '203.0.113.7');
});

test('clientIp falls back to the first x-forwarded-for entry, then the socket', () => {
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '198.51.100.2, 10.0.0.1' } }), '198.51.100.2');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1');
  assert.equal(clientIp({ headers: {} }), 'unknown');
});

test('tooMany returns 429 with Retry-After and is never cached by the CDN', () => {
  const res = fakeRes();
  tooMany(res, { ok: false, remaining: 0, retryAfter: 42 }, { error: { code: 'rate_limited' } });
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['retry-after'], '42');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['cdn-cache-control'], 'no-store');
  assert.deepEqual(res.body, { error: { code: 'rate_limited' } });
});

test('limitHeaders reports the read budget', () => {
  const res = fakeRes();
  limitHeaders(res, { ok: true, remaining: 87, retryAfter: 31 });
  assert.equal(res.headers['ratelimit-limit'], String(READ_LIMIT.limit));
  assert.equal(res.headers['ratelimit-remaining'], '87');
  assert.equal(res.headers['ratelimit-reset'], '31');
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { autoUpdate, healthProblem, readState, recordSync } from '../cli/health.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tt-health-'));
const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();

test('healthProblem: quiet when recent, explains when stale or signed out', () => {
  assert.equal(healthProblem({ lastSuccess: hoursAgo(1) }), null);
  assert.equal(healthProblem({}), null); // never synced, never failed: nothing to say yet
  assert.match(healthProblem({ lastSuccess: hoursAgo(30), lastError: 'offline' }), /No upload since 30 hours ago: offline/);
  assert.match(healthProblem({ lastSuccess: hoursAgo(1), signedOut: true }), /signed out/);
});

test('recordSync: counts failures and resets on success', () => {
  const dir = tmp();
  recordSync(dir, { ok: false, error: 'a' });
  const s = recordSync(dir, { ok: false, error: 'b' });
  assert.equal(s.failures, 2);
  assert.equal(s.lastError, 'b');
  recordSync(dir, { ok: true });
  assert.equal(readState(dir).failures, 0);
  assert.ok(readState(dir).lastSuccess);
});

// Build a real npm-style tarball from this repo's cli/ with `npm pack`-like layout
function makeTarball(version) {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'package'));
  fs.cpSync(path.join(import.meta.dirname, '..', 'cli'), path.join(root, 'package', 'cli'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package', 'cli', 'marker.txt'), version);
  const tgz = path.join(root, 'pkg.tgz');
  execFileSync('tar', ['-czf', tgz, '-C', root, 'package']);
  return fs.readFileSync(tgz);
}

test('autoUpdate: installs a newer verified version, rejects tampering, checks once a day', async () => {
  const tgz = makeTarball('9.9.9');
  const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
  const realFetch = globalThis.fetch;
  let served = tgz;
  globalThis.fetch = async (url) => (String(url).includes('/latest')
    ? { ok: true, json: async () => ({ version: '9.9.9', dist: { tarball: 'https://x/pkg.tgz', integrity } }) }
    : { ok: true, arrayBuffer: async () => served });
  try {
    const installDir = tmp();
    const configDir = tmp();
    fs.mkdirSync(path.join(installDir, 'cli'));
    fs.writeFileSync(path.join(installDir, 'cli', 'tokentrack.js'), '// old');

    assert.equal(await autoUpdate({ configDir, installDir, current: '0.1.1' }), '9.9.9');
    assert.equal(fs.readFileSync(path.join(installDir, 'cli', 'marker.txt'), 'utf8'), '9.9.9');
    assert.ok(fs.readFileSync(path.join(installDir, 'cli', 'tokentrack.js'), 'utf8').length > 1000);
    assert.equal(JSON.parse(fs.readFileSync(path.join(installDir, 'package.json'), 'utf8')).version, '9.9.9');
    // checked today already: no second download
    assert.equal(await autoUpdate({ configDir, installDir, current: '0.1.1' }), null);

    // tampered tarball is refused and the live install is untouched
    const dir2 = tmp();
    fs.mkdirSync(path.join(dir2, 'cli'));
    fs.writeFileSync(path.join(dir2, 'cli', 'tokentrack.js'), '// old');
    served = Buffer.concat([tgz, Buffer.from('x')]);
    await assert.rejects(autoUpdate({ configDir: tmp(), installDir: dir2, current: '0.1.1' }), /integrity/);
    assert.equal(fs.readFileSync(path.join(dir2, 'cli', 'tokentrack.js'), 'utf8'), '// old');

    // same or older version: nothing happens
    assert.equal(await autoUpdate({ configDir: tmp(), installDir: dir2, current: '9.9.9' }), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

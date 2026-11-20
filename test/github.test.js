import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { filterRows, parseFilters, totals } from '../cli/core/query.js';
import { toQueryRows } from '../cli/core/site.js';
import { buildSite } from '../cli/github.js';

const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => {
  const d = new Date(`${iso(new Date())}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return iso(d);
};

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-data-'));
  fs.mkdirSync(path.join(dir, 'machines'));
  fs.writeFileSync(path.join(dir, 'tokentracker.json'), JSON.stringify({ version: 1 }));
  const machine = (id, device, rows) => fs.writeFileSync(path.join(dir, 'machines', `${id}.json`), JSON.stringify({ version: 1, device, updatedAt: '2026-11-19T10:00:00Z', sources: ['claude-code', 'codex'], rows }));
  machine('aaaa', 'laptop', [
    { date: daysAgo(0), source: 'claude-code', model: 'anthropic/claude-opus-5-5', input: 100, output: 50, cacheRead: 1000, messages: 3 },
    { date: daysAgo(40), source: 'claude-code', model: 'anthropic/claude-opus-5-5', input: 7, messages: 1 },
  ]);
  machine('bbbb', 'desktop', [{ date: daysAgo(1), source: 'codex', model: 'openai/gpt-5-codex', input: 10, output: 5, reasoning: 5, messages: 1 }]);
  // same name, different computer: must not merge into "laptop"
  machine('cccc', 'laptop', [{ date: daysAgo(2), source: 'codex', model: 'openai/gpt-5-codex', input: 1, messages: 1 }]);
  return dir;
}

test('build: static API files match the shared query logic', async () => {
  const dir = repo();
  const out = path.join(dir, '_site');
  const r = await buildSite({ repoDir: dir, outDir: out, owner: 'someone', repo: 'tokentracker-data' });
  assert.equal(r.machines, 3);
  const read = (p) => JSON.parse(fs.readFileSync(path.join(out, p), 'utf8'));

  const all = read('api/v1/stats.json');
  assert.equal(all.tokens, 100 + 50 + 1000 + 7 + 10 + 5 + 5 + 1);
  assert.equal(all.handle, 'someone');
  // 30d excludes the 40-day-old row
  assert.equal(read('api/v1/30d/stats.json').tokens, all.tokens - 7);
  assert.equal(read('api/v1/usage-month.json').rows.reduce((s, x) => s + x.tokens, 0), all.tokens);
  assert.equal(read('api/v1/heatmap.json').weeks[0].length, 7);
  assert.deepEqual(read('api/v1/devices.json').rows.map((d) => d.device).sort(), ['desktop', 'laptop', 'laptop-cccc']);
  const profile = read('api/v1/profile.json');
  assert.equal(profile.storage, 'github');
  assert.equal(profile.links.stats, 'https://someone.github.io/tokentracker-data/api/v1/stats.json');
  assert.equal(read('api/v1/rows.json').machines.length, 3);
  assert.ok(fs.existsSync(path.join(out, 'index.html')) && fs.existsSync(path.join(out, '.nojekyll')));
});

test('bridge filters rows in memory exactly like the hosted query', () => {
  const rows = toQueryRows([
    { date: '2026-11-01', source: 'codex', model: 'm1', input: 1 },
    { date: '2026-11-10', source: 'claude-code', model: 'm2', input: 2 },
    { date: '2026-11-20', source: 'codex', model: 'm2', input: 4 },
  ], 'x');
  assert.equal(totals(filterRows(rows, parseFilters({ from: '2026-11-05', to: '2026-11-15' }))).tokens, 2);
  assert.equal(totals(filterRows(rows, parseFilters({ tools: 'codex' }))).tokens, 5);
  assert.equal(totals(filterRows(rows, parseFilters({ models: 'm2', tools: 'codex' }))).tokens, 4);
});

// ─── durability ───────────────────────────────────────────────────────────────
import { checkMachines, mergeRows, readMachines, uploadMachine } from '../cli/github.js';

test('mergeRows: pruned local logs never erase stored history; covered days update', () => {
  const stored = [
    { date: '2026-01-05', source: 'claude-code', model: 'm', input: 50 },
    { date: '2026-11-01', source: 'claude-code', model: 'm', input: 1 },
    { date: '2026-02-01', source: 'codex', model: 'x', input: 9 },
  ];
  // Claude now only has logs from Nov 1 (older transcripts deleted); codex logs are gone
  const local = [{ date: '2026-11-01', source: 'claude-code', model: 'm', input: 5 }, { date: '2026-11-02', source: 'claude-code', model: 'm', input: 3 }];
  const out = mergeRows(stored, local);
  const get = (d, s) => out.find((r) => r.date === d && r.source === s)?.input;
  assert.equal(get('2026-01-05', 'claude-code'), 50); // pruned locally, kept
  assert.equal(get('2026-11-01', 'claude-code'), 5); // still covered: local wins
  assert.equal(get('2026-11-02', 'claude-code'), 3); // new day
  assert.equal(get('2026-02-01', 'codex'), 9); // tool no longer has logs at all: kept
});

/** In-memory stand-in for GitHub's contents API, with an optional write race. */
function fakeGithub({ raceOnce = false } = {}) {
  const files = new Map();
  let raced = false;
  let commits = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const m = String(url).match(/\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/);
    const file = decodeURIComponent(m[1]);
    const res = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (!opts.method || opts.method === 'GET') {
      const f = files.get(file);
      return f ? res(200, { sha: f.sha, content: Buffer.from(f.text).toString('base64') }) : res(404, { message: 'Not Found' });
    }
    const body = JSON.parse(opts.body);
    const cur = files.get(file);
    if (raceOnce && !raced) { raced = true; files.set(file, { sha: 'other', text: cur ? cur.text : '{"format":1,"rows":[]}\n' }); return res(409, { message: 'sha mismatch' }); }
    if (cur && body.sha !== cur.sha) return res(409, { message: 'sha mismatch' });
    if (!cur && body.sha) return res(422, { message: 'no file' });
    commits += 1;
    files.set(file, { sha: `s${commits}`, text: Buffer.from(body.content, 'base64').toString('utf8') });
    return res(200, {});
  };
  return { files, commits: () => commits };
}

test('uploadMachine: one file per year, merges, heartbeat once a day, survives a write race', async () => {
  const real = globalThis.fetch;
  try {
    const gh = fakeGithub({ raceOnce: true });
    const thisYear = new Date().toISOString().slice(0, 4);
    const rows = [
      { date: '2025-12-31', source: 'codex', model: 'x', input: 7, messages: 1 },
      { date: `${thisYear}-01-02`, source: 'codex', model: 'x', input: 3, messages: 1 },
    ];
    const args = { owner: 'me', repo: 'tokentracker-data', machineId: 'abc', device: 'laptop', rows };
    const r1 = await uploadMachine('t', args);
    assert.equal(r1.rows, 2);
    assert.deepEqual([...gh.files.keys()].sort(), ['machines/abc/2025.json', `machines/abc/${thisYear}.json`]);
    const cur = JSON.parse(gh.files.get(`machines/abc/${thisYear}.json`).text);
    assert.equal(cur.format, 1);
    assert.equal(cur.syncedOn, new Date().toISOString().slice(0, 10));

    // Same numbers, same day: no new commits at all
    const before = gh.commits();
    assert.equal((await uploadMachine('t', args)).changed, false);
    assert.equal(gh.commits(), before);

    // Logs for 2025 are gone locally: the 2025 file is left untouched
    await uploadMachine('t', { ...args, rows: [{ date: `${thisYear}-01-02`, source: 'codex', model: 'x', input: 4, messages: 2 }] });
    assert.equal(JSON.parse(gh.files.get('machines/abc/2025.json').text).rows[0].input, 7);
    assert.equal(JSON.parse(gh.files.get(`machines/abc/${thisYear}.json`).text).rows[0].input, 4);
  } finally {
    globalThis.fetch = real;
  }
});

test('readMachines: reads the 0.2.0 flat layout and the yearly layout together', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-read-'));
  fs.mkdirSync(path.join(dir, 'machines', 'm2'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'machines', 'm1.json'), JSON.stringify({ device: 'old', updatedAt: '2026-11-01T00:00:00Z', rows: [{ date: '2026-11-01', source: 'codex', model: 'x', input: 1 }] }));
  fs.writeFileSync(path.join(dir, 'machines', 'm2', '2025.json'), JSON.stringify({ format: 1, device: 'mac', syncedOn: '2025-12-31', rows: [{ date: '2025-12-31', source: 'codex', model: 'x', input: 2 }] }));
  fs.writeFileSync(path.join(dir, 'machines', 'm2', '2026.json'), JSON.stringify({ format: 1, device: 'mac-renamed', syncedOn: '2026-11-19', rows: [{ date: '2026-11-19', source: 'codex', model: 'x', input: 3 }] }));
  const ms = readMachines(dir);
  assert.deepEqual(ms.map((m) => [m.id, m.device, m.rows.length]), [['m1', 'old', 1], ['m2', 'mac-renamed', 2]]);
  assert.equal(ms[1].syncedOn, '2026-11-19');
});

test('checkMachines: opens one issue for a quiet machine and closes it when it is back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-check-'));
  const write = (day) => {
    fs.mkdirSync(path.join(dir, 'machines', 'abc'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'machines', 'abc', '2026.json'), JSON.stringify({ format: 1, device: 'laptop', syncedOn: day, rows: [] }));
  };
  const issues = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const res = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (String(url).includes('/issues?state=open')) return res(200, issues.filter((i) => i.state === 'open'));
    if (opts.method === 'POST' && /\/issues$/.test(url)) { const b = JSON.parse(opts.body); issues.push({ number: issues.length + 1, state: 'open', ...b }); return res(201, {}); }
    if (opts.method === 'PATCH') { issues[Number(String(url).split('/').pop()) - 1].state = 'closed'; return res(200, {}); }
    return res(201, {});
  };
  try {
    const now = new Date('2026-11-20T12:00:00Z');
    write('2026-11-15');
    assert.deepEqual((await checkMachines({ repoDir: dir, token: 't', repository: 'me/tokentracker-data', now })).opened, ['laptop']);
    assert.deepEqual((await checkMachines({ repoDir: dir, token: 't', repository: 'me/tokentracker-data', now })).opened, []); // no duplicate
    write('2026-11-20');
    assert.deepEqual((await checkMachines({ repoDir: dir, token: 't', repository: 'me/tokentracker-data', now })).closed, ['laptop']);
    write('2026-09-01'); // quiet for months: retired, not nagged
    assert.deepEqual((await checkMachines({ repoDir: dir, token: 't', repository: 'me/tokentracker-data', now })).opened, []);
  } finally {
    globalThis.fetch = real;
  }
});

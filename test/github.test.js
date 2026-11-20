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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, devices, heatmap, models, parseFilters, stats, toCsv, tools, totals, usage } from '../lib/query.js';

const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => {
  const d = new Date(`${iso(new Date())}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return iso(d);
};
const row = (date, source, model, input, output = 0, extra = {}) => ({
  date, source, model, input, output, reasoning: 0, cache_read: 0, cache_write: 0, messages: 1, device: 'laptop', ...extra,
});

const rows = [
  row(daysAgo(0), 'claude-code', 'anthropic/claude-opus-5-5', 100, 50, { cache_read: 1000, messages: 3 }),
  row(daysAgo(1), 'claude-code', 'anthropic/claude-opus-5-5', 200, 20),
  row(daysAgo(1), 'codex', 'openai/gpt-5-codex', 10, 5, { reasoning: 5, device: 'desktop' }),
  row(daysAgo(2), 'cursor', 'cursor/all', 5000, 0, { device: 'cursor.com', messages: 0 }),
  row(daysAgo(10), 'codex', 'openai/gpt-5-codex', 300, 30),
];

test('parseFilters: ranges, explicit dates, lists and errors', () => {
  assert.equal(parseFilters({ range: '30d' }).from, daysAgo(29));
  assert.deepEqual(parseFilters({ range: '2025' }), { from: '2025-01-01', to: '2025-12-31', tools: null, models: null });
  assert.equal(parseFilters({ range: 'ytd' }).from, `${iso(new Date()).slice(0, 4)}-01-01`);
  assert.deepEqual(parseFilters({ tools: 'codex, claude-code' }).tools, ['codex', 'claude-code']);
  for (const bad of [{ range: 'forever' }, { from: '2026-13' }, { from: '2026-02-02', to: '2026-01-01' }, { tools: 'a;drop' }]) {
    assert.throws(() => parseFilters(bad), ApiError, JSON.stringify(bad));
  }
});

test('totals add every token kind', () => {
  const t = totals(rows);
  assert.equal(t.tokens, 100 + 50 + 1000 + 200 + 20 + 10 + 5 + 5 + 5000 + 300 + 30);
  assert.equal(t.cacheRead, 1000);
  assert.equal(t.responses, 3 + 1 + 1 + 0 + 1);
});

test('usage: daily series is continuous and splits by tool', () => {
  const daily = usage(rows, {}, { group: 'day', split: 'tool' });
  assert.equal(daily.length, 11); // 10 days ago .. today, gaps filled
  assert.equal(daily.at(-1).period, daysAgo(0));
  assert.equal(daily.find((d) => d.period === daysAgo(5)).tokens, 0);
  assert.deepEqual(daily.find((d) => d.period === daysAgo(1)).split, { 'claude-code': 220, codex: 20 });
  assert.equal(usage(rows, {}, { group: 'total' })[0].tokens, totals(rows).tokens);
  assert.throws(() => usage(rows, {}, { group: 'hour' }), ApiError);
});

test('usage: week and month buckets', () => {
  const months = usage(rows, {}, { group: 'month' });
  assert.equal(months.reduce((s, m) => s + m.tokens, 0), totals(rows).tokens);
  const weeks = usage(rows, {}, { group: 'week' });
  for (const w of weeks) assert.equal(new Date(`${w.period}T00:00:00Z`).getUTCDay(), 1); // Mondays
});

test('models and tools: totals, shares, first/last use', () => {
  const m = models(rows);
  assert.equal(m[0].model, 'cursor/all');
  const opus = m.find((x) => x.name === 'claude-opus-5-5');
  assert.equal(opus.provider, 'anthropic');
  assert.equal(opus.responses, 4);
  assert.ok(Math.abs(m.reduce((s, x) => s + x.share, 0) - 1) < 1e-9);
  const t = tools(rows);
  assert.deepEqual(t.map((x) => x.tool), ['cursor', 'claude-code', 'codex']);
  const codex = t.find((x) => x.tool === 'codex');
  assert.equal(codex.firstUsed, daysAgo(10));
  assert.equal(codex.lastUsed, daysAgo(1));
  assert.equal(t.find((x) => x.tool === 'cursor').models, 0);
});

test('stats: streaks, busiest day, top model by responses', () => {
  const s = stats(rows);
  assert.equal(s.currentStreak, 3);
  assert.equal(s.longestStreak, 3);
  assert.equal(s.activeDays, 4);
  assert.equal(s.busiestDay.date, daysAgo(2));
  assert.equal(s.topModel.model, 'anthropic/claude-opus-5-5');
  assert.equal(s.topTool.tool, 'cursor');
  assert.equal(s.today, 1150);
});

test('heatmap: grid with levels, tools filter and bad levels', () => {
  const hm = heatmap('demo', rows, { range: '365d' });
  assert.ok(hm.weeks.length >= 52 && hm.weeks.every((w) => w.length === 7));
  const days = hm.weeks.flat().filter(Boolean);
  assert.equal(days.at(-1).date, daysAgo(0));
  assert.equal(days.find((d) => d.date === daysAgo(2)).level, 4);
  assert.equal(hm.total, totals(rows).tokens);
  assert.equal(heatmap('demo', rows, { range: '365d', tools: 'codex' }).total, 350);
  assert.throws(() => heatmap('demo', rows, { levels: '99' }), ApiError);
});

test('devices exclude the server-side cursor pseudo-device', () => {
  const d = devices(rows, new Map([['laptop', '2026-11-18T10:00:00Z']]));
  assert.deepEqual(d.map((x) => x.device).sort(), ['desktop', 'laptop']);
  assert.equal(d.find((x) => x.device === 'laptop').lastSync, '2026-11-18T10:00:00Z');
});

test('csv flattens nested split objects', () => {
  const csv = toCsv(usage(rows, {}, { group: 'month', split: 'tool' }));
  const [header] = csv.split('\n');
  assert.ok(header.includes('period') && header.includes('split.codex'));
});

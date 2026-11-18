import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildHeatmap, buildSeries, formatTokens, resolveRange } from '../lib/heatmap.js';

const TODAY = '2026-11-18';
const data = {
  handle: 'demo',
  activityCounts: [
    { date: '2026-01-01', count: 100, sources: { cursor: 100 } },
    { date: '2026-01-02', count: 300, sources: { cursor: 100, 'claude-code': 200 } },
    { date: '2026-01-03', count: 0, sources: {} },
    { date: '2026-11-17', count: 5000, sources: { 'claude-code': 4000, codex: 1000 } },
    { date: '2026-11-18', count: 1000, sources: { codex: 1000 } },
  ],
  models: [
    { source: 'claude-code', model: 'anthropic/claude-opus-5-5', tokens: 4200, input: 10, output: 90, cache: 4100, messages: 12 },
    { source: 'cursor', model: 'cursor/all', tokens: 200, input: 200, output: 0, cache: 0, messages: 0 },
  ],
};

test('formatTokens', () => {
  assert.equal(formatTokens(9_330_000_000), '9.33B');
  assert.equal(formatTokens(365_100_000), '365.1M');
  assert.equal(formatTokens(999), '999');
});

test('resolveRange', () => {
  assert.deepEqual(resolveRange('year', TODAY), ['2026-01-01', TODAY]);
  assert.deepEqual(resolveRange('30d', TODAY), ['2026-10-20', TODAY]);
  assert.deepEqual(resolveRange('2025', TODAY), ['2025-01-01', '2025-12-31']);
});

test('buildHeatmap: full-year grid, totals, levels and streaks', () => {
  const hm = buildHeatmap(data, { today: TODAY });
  assert.equal(hm.total, 6400);
  assert.equal(hm.max, 5000);
  assert.equal(hm.maxDay, '2026-11-17');
  assert.equal(hm.activeDays, 4);
  assert.equal(hm.longestStreak, 2);
  assert.ok(hm.weeks.length >= 53 && hm.weeks.every((w) => w.length === 7));
  assert.equal(hm.months.length, 12);
  const days = hm.weeks.flat().filter(Boolean);
  assert.equal(days[0].date, '2026-01-01');
  assert.equal(days.at(-1).date, '2026-12-31');
  assert.ok(days.find((d) => d.date === '2026-12-01').future);
  assert.equal(days.find((d) => d.date === '2026-11-17').level, 4);
  assert.equal(days.find((d) => d.date === '2026-01-03').level, 0);
  assert.deepEqual(hm.tools.map((t) => t.id), ['claude-code', 'codex', 'cursor']);
});

test('buildHeatmap: tool filter and week start', () => {
  const hm = buildHeatmap(data, { today: TODAY, tools: ['codex'], weekStart: 'mon' });
  assert.equal(hm.total, 2000);
  assert.deepEqual(hm.tools.map((t) => t.id), ['codex']);
  // 2026-01-01 is a Thursday: with Monday weeks it sits at index 3
  assert.equal(hm.weeks[0].findIndex((d) => d?.date === '2026-01-01'), 3);
});

test('buildSeries is cumulative', () => {
  const s = buildSeries(data, { today: TODAY });
  assert.equal(s.at(-1).cumulative, 6400);
  assert.equal(s.at(-1).date, TODAY);
});




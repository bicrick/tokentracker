import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildHeatmap, buildSeries, formatTokens, resolveRange } from '../public/lib/heatmap.js';
import { renderCard, parseOptions, CARD_TYPES, CELL_STYLES } from '../lib/cards.js';
import { shape } from '../api/tokens.js';

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

test('every card type and cell style renders valid-looking SVG', () => {
  for (const type of CARD_TYPES) {
    for (const cells of CELL_STYLES) {
      const svg = renderCard(data, { type, cells, theme: 'light', accent: 'e11d48' });
      assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, `${type}/${cells}`);
      assert.ok(svg.endsWith('</svg>'));
      assert.ok(!svg.includes('undefined') && !svg.includes('NaN'), `${type}/${cells} has bad values`);
    }
  }
  assert.match(renderCard(data, { type: 'badge' }), /6\.4K/);
});

test('card options are sanitised', () => {
  const o = parseOptions({ accent: 'url(javascript:x)', range: '../../etc', tools: 'codex,<script>', type: 'nope' });
  assert.equal(o.theme.accent, '#6b9eff');
  assert.equal(o.range, 'year');
  assert.deepEqual(o.tools, ['codex']);
  assert.equal(o.type, 'heatmap');
  const svg = renderCard({ ...data, handle: '<x>' }, {});
  assert.ok(!svg.includes('<x>'));
});

test('tokens API shapes data by group', () => {
  const byMonth = shape(data, { group: 'month' });
  assert.equal(byMonth.rows.find((r) => r.month === '2026-01').tokens, 400);
  const byTool = shape(data, { group: 'tool' });
  assert.equal(byTool.rows[0].tool, 'claude-code');
  const byModel = shape(data, { group: 'model' });
  assert.equal(byModel.rows.length, 1); // cursor/all is excluded
  const tools = shape(data, { group: 'day', tools: 'codex' });
  assert.ok(tools.rows.every((r) => r.tokens <= 1000));
});

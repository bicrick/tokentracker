// Run with: node --test test/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.XDG_CONFIG_HOME = path.join(home, '.config');
process.env.XDG_DATA_HOME = path.join(home, '.local', 'share');
process.env.TOKENTRACK_TZ = 'UTC';

const write = (rel, content) => {
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
};
const jsonl = (items) => items.map((i) => JSON.stringify(i)).join('\n');

// ── fixtures ──────────────────────────────────────────────────────────────────

const codexRollout = jsonl([
  { timestamp: '2026-11-10T10:00:00Z', type: 'turn_context', payload: { model: 'gpt-5-codex' } },
  { timestamp: '2026-11-10T10:00:01Z', type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 200, reasoning_output_tokens: 50 },
    last_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 200, reasoning_output_tokens: 50 },
  } } },
  // repeated event with unchanged total must add nothing
  { timestamp: '2026-11-10T10:00:02Z', type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 200, reasoning_output_tokens: 50 },
  } } },
  { timestamp: '2026-11-11T09:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: 2500, cached_input_tokens: 1600, output_tokens: 500, reasoning_output_tokens: 100 },
  } } },
]);
write('.codex/sessions/2026/11/10/rollout-abc.jsonl', codexRollout);
write('.codex/archived_sessions/rollout-abc.jsonl', codexRollout); // duplicate copy

write('.gemini/tmp/proj1/chats/session-1.json', {
  sessionId: 's1',
  messages: [
    { type: 'user', id: 'u1', timestamp: '2026-11-12T08:00:00Z' },
    { type: 'gemini', id: 'g1', timestamp: '2026-11-12T08:00:05Z', model: 'gemini-2.5-pro',
      tokens: { input: 800, output: 100, cached: 300, thoughts: 40, total: 940 } },
  ],
});

const clineTask = 'Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/1731400000000';
const linuxClineTask = '.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/1731400000000';
for (const dir of [clineTask, linuxClineTask]) {
  write(`${dir}/ui_messages.json`, [
    { ts: Date.parse('2026-11-13T12:00:00Z'), type: 'say', say: 'text', text: 'hi' },
    { ts: Date.parse('2026-11-13T12:00:01Z'), type: 'say', say: 'api_req_started',
      text: JSON.stringify({ tokensIn: 120, tokensOut: 30, cacheReads: 900, cacheWrites: 50 }) },
  ]);
  write(`${dir}/api_conversation_history.json`, [{ role: 'assistant', model: 'anthropic/claude-sonnet-4.5' }]);
}

write('.copilot/session-state/sess1/events.jsonl', jsonl([
  { type: 'session.start', timestamp: '2026-11-14T10:00:00Z' },
  { type: 'session.usage_record', timestamp: '2026-11-14T10:00:05Z',
    data: { usage: { model: 'claude-sonnet-4.5', inputTokens: 500, outputTokens: 80, cacheReadTokens: 200 } } },
]));

// ── tests ─────────────────────────────────────────────────────────────────────

const { resolveConnections, collectAll } = await import('../cli/sources/index.js');

async function run() {
  const conns = resolveConnections({});
  const rows = new Map();
  const report = await collectAll(conns, rows);
  return { conns, rows: [...rows.values()], report };
}

const byTool = (rows, source) => rows.filter((r) => r.source === source);
const sum = (rows, k) => rows.reduce((s, r) => s + r[k], 0);

test('auto-detects installed tools only', async () => {
  const { conns } = await run();
  const on = conns.filter((c) => c.enabled).map((c) => c.id).sort();
  const expected = ['cline', 'codex', 'copilot-cli', 'gemini-cli'];
  // Cline's fixture lives under the current platform's editor root
  assert.deepEqual(on, expected);
});

test('codex counts deltas of cumulative totals, once per rollout', async () => {
  const rows = byTool((await run()).rows, 'codex');
  assert.equal(rows.length, 2);
  const day1 = rows.find((r) => r.date === '2026-11-10');
  assert.deepEqual([day1.input, day1.cacheRead, day1.output, day1.reasoning], [400, 600, 150, 50]);
  const day2 = rows.find((r) => r.date === '2026-11-11');
  assert.deepEqual([day2.input, day2.cacheRead, day2.output, day2.reasoning], [500, 1000, 250, 50]);
  assert.equal(day1.model, 'openai/gpt-5-codex');
});

test('gemini splits cached out of input and maps thoughts to reasoning', async () => {
  const [row] = byTool((await run()).rows, 'gemini-cli');
  assert.deepEqual([row.input, row.cacheRead, row.output, row.reasoning], [500, 300, 100, 40]);
  assert.equal(row.model, 'google/gemini-2.5-pro');
});

test('cline reads api_req_started and finds the model', async () => {
  const rows = byTool((await run()).rows, 'cline');
  assert.equal(sum(rows, 'input'), 120);
  assert.equal(sum(rows, 'cacheRead'), 900);
  assert.equal(rows[0].model, 'anthropic/claude-sonnet-4.5');
});

test('copilot cli uses per-call usage records', async () => {
  const [row] = byTool((await run()).rows, 'copilot-cli');
  assert.deepEqual([row.input, row.cacheRead, row.output], [300, 200, 80]);
  assert.equal(row.model, 'github-copilot/claude-sonnet-4.5');
});

test('connections can be turned off in config', async () => {
  const conns = resolveConnections({ connections: { codex: { enabled: false } } });
  assert.equal(conns.find((c) => c.id === 'codex').enabled, false);
  assert.equal(conns.find((c) => c.id === 'gemini-cli').enabled, true);
});

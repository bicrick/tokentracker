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

// DeepSeek Harness: v4 jsonl with an older v3 copy (must be ignored), a forked
// session that inherits its parent's events, and a multi-frame zstd log
const dshEvents = (id, extra = []) => [
  { type: 'session', version: 4, id, createdAt: Date.parse('2026-11-15T09:00:00Z') },
  { type: 'request/header', seq: 1, time: Date.parse('2026-11-15T09:00:01Z'), data: { header: { config: { provider: 'deepseek', model: 'deepseek-v4' } } } },
  { type: 'assistant/message', seq: 2, time: Date.parse('2026-11-15T09:00:02Z'), data: { usage: { inputTokens: 400, outputTokens: 120, reasoningTokens: 20, cacheReadTokens: 9000, cacheWriteTokens: 600 } } },
  // usage only in the stream: use the last usage chunk
  { type: 'assistant/attempt', seq: 3, time: Date.parse('2026-11-15T09:00:03Z'), data: { stream: [
    { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } } },
    { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 50, outputTokens: 10 } } },
  ] } },
  { type: 'compaction/summary', seq: 4, time: Date.parse('2026-11-16T10:00:00Z'), data: { provider: 'deepseek', model: 'deepseek-v4-flash', usage: { inputTokens: 300, outputTokens: 40 } } },
  ...extra,
];
write('.dsh/sessions/proj/session-a/session.v4.jsonl', jsonl(dshEvents('session-a')));
write('.dsh/sessions/proj/session-a/session.v3.jsonl', jsonl(dshEvents('session-a'))); // old generation
// fork: inherits the parent's first events, then adds one of its own
write('.dsh/sessions/proj/session-b/session.v4.jsonl', jsonl([
  ...dshEvents('session-b').slice(0, 3),
  { type: 'session/end-seed', seq: 5, time: Date.parse('2026-11-17T08:00:00Z'), data: { inherited: true } },
  { type: 'assistant/message', seq: 6, time: Date.parse('2026-11-17T08:00:01Z'), data: { usage: { inputTokens: 70, outputTokens: 7 } } },
]));
{
  const zlib = await import('node:zlib');
  const lines = dshEvents('session-c').slice(0, 3).map((e) => `${JSON.stringify(e)}\n`);
  // one zstd frame per append, plus a truncated frame at the end (still writing)
  const frames = lines.map((l) => zlib.zstdCompressSync(Buffer.from(l)));
  const tail = zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'assistant/message', seq: 9, time: 1, data: { usage: { inputTokens: 999 } } })}\n`));
  const file = path.join(home, '.dsh/sessions/proj/session-c/session.v4.jsonl.zstd');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([...frames, tail.subarray(0, tail.length - 4)]));
}

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
  const expected = ['cline', 'codex', 'copilot-cli', 'deepseek-harness', 'gemini-cli'];
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

test('deepseek harness: current generation only, stream usage, compaction model, forks, zstd frames', async () => {
  const rows = byTool((await run()).rows, 'deepseek-harness');
  const day = (d, m) => rows.find((r) => r.date === d && r.model === m);
  // 2026-11-15: session-a (400+50 input) + session-c zstd (400 input, truncated tail dropped)
  const v4 = day('2026-11-15', 'deepseek/deepseek-v4');
  assert.equal(v4.input, 400 + 50 + 400);
  assert.equal(v4.cacheRead, 9000 * 2);
  assert.equal(v4.reasoning, 20 * 2);
  assert.equal(v4.output, (120 - 20) * 2 + 10);
  // compaction uses its own model
  assert.equal(day('2026-11-16', 'deepseek/deepseek-v4-flash').input, 300);
  // fork: only the post-seed call counts, nothing duplicated from the parent
  assert.equal(day('2026-11-17', 'deepseek/deepseek-v4').input, 70);
  assert.equal(rows.reduce((s, r) => s + r.messages, 0), 3 + 1 + 1); // session-a, fork, zstd
});

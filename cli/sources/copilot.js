import fs from 'node:fs';
import path from 'node:path';
import { addRow, dayOf } from '../day.js';
import { exists, HOME, readJsonl } from '../fs-util.js';

const n = (v) => (Number.isFinite(v) ? v : 0);

function usageOf(u = {}) {
  const input = n(u.inputTokens ?? u.input_tokens ?? u.promptTokens);
  const cacheRead = n(u.cacheReadTokens ?? u.cache_read_tokens ?? u.cachedTokens);
  const output = n(u.outputTokens ?? u.output_tokens ?? u.completionTokens);
  const reasoning = n(u.reasoningTokens ?? u.reasoning_tokens);
  return {
    input: Math.max(0, input - cacheRead),
    output: Math.max(0, output - reasoning),
    reasoning,
    cacheRead,
    cacheWrite: n(u.cacheWriteTokens ?? u.cache_write_tokens),
  };
}

export default {
  id: 'copilot-cli',
  name: 'Copilot CLI',
  detect() {
    const dir = path.join(process.env.COPILOT_HOME || path.join(HOME, '.copilot'), 'session-state');
    return exists(dir) ? [dir] : [];
  },
  // Current versions log a usage record per model call. Older versions only
  // log cumulative per-model snapshots at shutdown; for those, count the change
  // between snapshots within the session.
  collect(rows, dirs) {
    let count = 0;
    for (const dir of dirs) {
      let sessions;
      try {
        sessions = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
      } catch {
        continue;
      }
      for (const s of sessions) {
        const file = path.join(dir, s.name, 'events.jsonl');
        const events = [...readJsonl(file, '"session.')];
        const perCall = events.filter((e) => e.type === 'session.usage_record');

        if (perCall.length) {
          for (const e of perCall) {
            const u = e.data?.usage || e.data;
            const ts = Date.parse(e.timestamp || e.data?.timestamp);
            if (!u || !ts) continue;
            addRow(rows, { date: dayOf(ts), source: 'copilot-cli', model: `github-copilot/${u.model || 'unknown'}`, usage: usageOf(u) });
            count += 1;
          }
          continue;
        }

        const last = new Map();
        for (const e of events.filter((ev) => ev.type === 'session.shutdown')) {
          const ts = Date.parse(e.timestamp);
          const byModel = e.data?.modelMetrics || e.data?.usage?.byModel || {};
          for (const [model, m] of Object.entries(byModel)) {
            const cur = usageOf(m.usage || m);
            const prev = last.get(model) || {};
            const delta = Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, Math.max(0, v - (prev[k] || 0))]));
            last.set(model, cur);
            if (!ts || !Object.values(delta).some(Boolean)) continue;
            addRow(rows, { date: dayOf(ts), source: 'copilot-cli', model: `github-copilot/${model}`, usage: delta });
            count += 1;
          }
        }
      }
    }
    return count;
  },
};

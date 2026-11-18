import path from 'node:path';
import { addRow, dayOf } from '../day.js';
import { exists, HOME, readJsonl, walk } from '../fs-util.js';

const ZERO = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };

function diff(a, b) {
  const out = {};
  for (const k of Object.keys(ZERO)) out[k] = Math.max(0, (a?.[k] || 0) - (b?.[k] || 0));
  return out;
}

export default {
  id: 'codex',
  name: 'Codex',
  detect() {
    const root = process.env.CODEX_HOME || path.join(HOME, '.codex');
    return ['sessions', 'archived_sessions'].map((d) => path.join(root, d)).filter(exists);
  },
  // token_count events carry a cumulative session total plus the last request.
  // Count the change in the cumulative total between events, never the totals
  // themselves. Cached input is a subset of input; reasoning is a subset of output.
  collect(rows, dirs) {
    const seenRollouts = new Set();
    let count = 0;
    for (const dir of dirs) {
      for (const file of walk(dir, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'))) {
        // The same rollout can live in sessions/ and archived_sessions/
        const name = path.basename(file);
        if (seenRollouts.has(name)) continue;
        seenRollouts.add(name);

        let model = 'gpt-5';
        let prev = null;
        for (const entry of readJsonl(file)) {
          const p = entry.payload;
          if (entry.type === 'turn_context' && p?.model) {
            model = p.model;
            continue;
          }
          if (entry.type !== 'event_msg' || p?.type !== 'token_count' || !p.info) continue;
          const total = p.info.total_token_usage;
          const delta = total ? diff(total, prev) : p.info.last_token_usage;
          if (total) prev = total;
          if (!delta) continue;
          const sum = delta.input_tokens + delta.output_tokens;
          if (!sum || !entry.timestamp) continue;

          const cached = Math.min(delta.cached_input_tokens || 0, delta.input_tokens || 0);
          const reasoning = Math.min(delta.reasoning_output_tokens || 0, delta.output_tokens || 0);
          addRow(rows, {
            date: dayOf(Date.parse(entry.timestamp)),
            source: 'codex',
            model: `openai/${model}`,
            usage: {
              input: (delta.input_tokens || 0) - cached,
              output: (delta.output_tokens || 0) - reasoning,
              reasoning,
              cacheRead: cached,
            },
          });
          count += 1;
        }
      }
    }
    return count;
  },
};

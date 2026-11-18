import path from 'node:path';
import { addRow, dayOf } from '../day.js';
import { exists, HOME, readJsonl, unique, walk, xdgConfig } from '../fs-util.js';

export default {
  id: 'claude-code',
  name: 'Claude Code',
  detect() {
    const roots = [
      ...(process.env.CLAUDE_CONFIG_DIR || '').split(',').filter(Boolean),
      path.join(HOME, '.claude'),
      path.join(xdgConfig(), 'claude'),
    ];
    return unique(roots.map((r) => path.join(r, 'projects')).filter(exists));
  },
  // Claude Code writes one line per streamed content block, so the same API
  // response appears several times. Dedupe on message.id + requestId.
  collect(rows, dirs) {
    const seen = new Set();
    let count = 0;
    for (const dir of dirs) {
      for (const file of walk(dir, (n) => n.endsWith('.jsonl'))) {
        for (const entry of readJsonl(file, '"usage"')) {
          const msg = entry.message;
          const u = msg?.usage;
          if (!u || !entry.timestamp || !msg.model || msg.model === '<synthetic>') continue;
          const key = `${msg.id}|${entry.requestId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          addRow(rows, {
            date: dayOf(Date.parse(entry.timestamp)),
            source: 'claude-code',
            model: `anthropic/${msg.model}`,
            usage: {
              input: u.input_tokens,
              output: u.output_tokens,
              cacheRead: u.cache_read_input_tokens,
              cacheWrite: u.cache_creation_input_tokens,
            },
          });
          count += 1;
        }
      }
    }
    return count;
  },
};

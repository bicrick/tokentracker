import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addRow, dayOf } from '../day.js';

const ROOTS = [
  path.join(os.homedir(), '.claude/projects'),
  path.join(os.homedir(), '.config/claude/projects'),
];

function* walkJsonl(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkJsonl(full);
    else if (entry.name.endsWith('.jsonl')) yield full;
  }
}

// Claude Code writes one JSONL line per streamed content block, so the same
// API response appears multiple times. Dedupe on message.id + requestId.
export function collectClaude(rows) {
  const roots = ROOTS.filter((r) => fs.existsSync(r));
  if (!roots.length) return { source: 'claude-code', skipped: 'no projects dir' };

  const seen = new Set();
  let count = 0;

  for (const root of roots) {
    for (const file of walkJsonl(root)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.includes('"usage"')) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const msg = entry.message;
        const u = msg?.usage;
        if (!u || !entry.timestamp) continue;
        if (msg.model === '<synthetic>') continue;

        const key = `${msg.id}|${entry.requestId}`;
        if (seen.has(key)) continue;
        seen.add(key);

        addRow(rows, {
          date: dayOf(Date.parse(entry.timestamp)),
          source: 'claude-code',
          model: `anthropic/${msg.model || 'unknown'}`,
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

  return { source: 'claude-code', messages: count };
}

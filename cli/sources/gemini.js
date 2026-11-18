import path from 'node:path';
import { addRow, dayOf } from '../day.js';
import { exists, HOME, readJson, readJsonl, walk } from '../fs-util.js';

function messagesOf(file) {
  if (file.endsWith('.jsonl')) {
    const out = [];
    for (const entry of readJsonl(file)) {
      if (Array.isArray(entry.messages)) out.push(...entry.messages.map((m) => ({ ...m, sessionId: entry.sessionId })));
      else if (entry.tokens) out.push(entry);
    }
    return out;
  }
  const doc = readJson(file);
  if (!doc) return [];
  const list = Array.isArray(doc) ? doc : doc.messages || [];
  return list.map((m) => ({ ...m, sessionId: m.sessionId || doc.sessionId }));
}

export default {
  id: 'gemini-cli',
  name: 'Gemini CLI',
  detect() {
    const root = path.join(process.env.GEMINI_CLI_HOME || HOME, '.gemini', 'tmp');
    return exists(root) ? [root] : [];
  },
  // Chat files are rewritten as whole snapshots; dedupe on session + message id.
  // `cached` is included in `input`, so split it out.
  collect(rows, dirs) {
    const seen = new Set();
    let count = 0;
    for (const dir of dirs) {
      for (const file of walk(dir, (n, full) => /\.jsonl?$/.test(n) && full.includes(`${path.sep}chats${path.sep}`))) {
        for (const m of messagesOf(file)) {
          const t = m.tokens;
          if (!t || !m.timestamp) continue;
          const key = `${m.sessionId}|${m.id}|${m.timestamp}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const cached = Math.min(t.cached || 0, t.input || 0);
          addRow(rows, {
            date: dayOf(Date.parse(m.timestamp)),
            source: 'gemini-cli',
            model: `google/${m.model || 'gemini'}`,
            usage: {
              input: (t.input || 0) - cached,
              output: t.output || 0,
              reasoning: t.thoughts || 0,
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

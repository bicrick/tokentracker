import fs from 'node:fs';
import path from 'node:path';
import { addRow, dayOf } from '../day.js';
import { exists, extensionStorageDirs, HOME, readJson } from '../fs-util.js';

// Model is not on the usage line; look for it in the task's conversation history.
function taskModel(taskDir) {
  const meta = readJson(path.join(taskDir, 'task_metadata.json'));
  const fromMeta = meta?.model_usage?.at?.(-1)?.model_id || meta?.model;
  if (fromMeta) return fromMeta;
  try {
    const text = fs.readFileSync(path.join(taskDir, 'api_conversation_history.json'), 'utf8');
    const match = text.match(/"model(?:Id|_id)?"\s*:\s*"([^"]{2,80})"/);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

/** Factory for the Cline family (Cline, Roo Code, Kilo Code), which share one task format. */
function clineFamily({ id, name, extId, cliDir }) {
  return {
    id,
    name,
    detect() {
      const dirs = extensionStorageDirs(extId).map((d) => path.join(d, 'tasks')).filter(exists);
      if (cliDir && exists(cliDir)) dirs.push(cliDir);
      return dirs;
    },
    collect(rows, dirs) {
      const seen = new Set();
      let count = 0;
      for (const dir of dirs) {
        let tasks;
        try {
          tasks = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
        } catch {
          continue;
        }
        for (const task of tasks) {
          const taskDir = path.join(dir, task.name);
          const messages = readJson(path.join(taskDir, 'ui_messages.json'));
          if (!Array.isArray(messages)) continue;
          const model = taskModel(taskDir) || 'unknown';
          for (const m of messages) {
            if (m.type !== 'say' || m.say !== 'api_req_started' || !m.ts || !m.text) continue;
            let info;
            try {
              info = JSON.parse(m.text);
            } catch {
              continue;
            }
            if (!info.tokensIn && !info.tokensOut) continue;
            const key = `${task.name}|${m.ts}`;
            if (seen.has(key)) continue;
            seen.add(key);
            addRow(rows, {
              date: dayOf(m.ts),
              source: id,
              model: model.includes('/') ? model : `unknown/${model}`,
              usage: {
                input: info.tokensIn,
                output: info.tokensOut,
                cacheRead: info.cacheReads,
                cacheWrite: info.cacheWrites,
              },
            });
            count += 1;
          }
        }
      }
      return count;
    },
  };
}

export const cline = clineFamily({
  id: 'cline',
  name: 'Cline',
  extId: 'saoudrizwan.claude-dev',
  cliDir: path.join(process.env.CLINE_DIR || path.join(HOME, '.cline'), 'data', 'tasks'),
});

export const roo = clineFamily({ id: 'roo-code', name: 'Roo Code', extId: 'rooveterinaryinc.roo-cline' });

export const kilo = clineFamily({ id: 'kilo-code', name: 'Kilo Code', extId: 'kilocode.kilo-code' });

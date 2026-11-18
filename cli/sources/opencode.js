import fs from 'node:fs';
import path from 'node:path';
import { addRow, dayOf } from '../day.js';
import { exists, readJson, unique, walk, xdgData } from '../fs-util.js';

function dbFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((n) => /^opencode.*\.db$/.test(n))
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

function collectDb(file, ingest) {
  return import('node:sqlite').then(({ DatabaseSync }) => {
    const db = new DatabaseSync(file, { readOnly: true });
    const hasTable = (name) => !!db.prepare("select 1 from sqlite_master where type='table' and name=?").get(name);
    try {
      if (hasTable('session_message')) {
        const stmt = db.prepare(`
          select time_created as t,
                 json_extract(data, '$.tokens') as tokens,
                 json_extract(data, '$.model.providerID') as provider,
                 json_extract(data, '$.model.id') as model
          from session_message
          where type = 'assistant' and json_extract(data, '$.tokens') is not null`);
        for (const r of stmt.iterate()) ingest(r.t, JSON.parse(r.tokens), r.provider, r.model);
      }
      if (hasTable('message')) {
        const stmt = db.prepare(`
          select coalesce(json_extract(data, '$.time.created'), time_created) as t,
                 json_extract(data, '$.tokens') as tokens,
                 json_extract(data, '$.providerID') as provider,
                 json_extract(data, '$.modelID') as model
          from message
          where json_extract(data, '$.role') = 'assistant' and json_extract(data, '$.tokens') is not null`);
        for (const r of stmt.iterate()) ingest(r.t, JSON.parse(r.tokens), r.provider, r.model);
      }
    } finally {
      db.close();
    }
  });
}

export default {
  id: 'opencode',
  name: 'OpenCode',
  detect() {
    if (process.env.OPENCODE_DB) return exists(process.env.OPENCODE_DB) ? [process.env.OPENCODE_DB] : [];
    const dirs = [path.join(xdgData(), 'opencode'), path.join(xdgData(), 'kilo')];
    const found = dirs.flatMap(dbFiles);
    // Legacy JSON storage from older versions
    const legacy = path.join(xdgData(), 'opencode', 'storage', 'message');
    if (exists(legacy)) found.push(legacy);
    return unique(found);
  },
  // Messages appear in both the current and legacy tables after migration, so
  // dedupe on (timestamp, token counts).
  async collect(rows, paths) {
    const seen = new Set();
    let count = 0;
    const ingest = (createdMs, t, provider, model) => {
      if (!t || !createdMs) return;
      const usage = {
        input: t.input,
        output: t.output,
        reasoning: t.reasoning,
        cacheRead: t.cache?.read,
        cacheWrite: t.cache?.write,
      };
      const key = `${createdMs}|${usage.input}|${usage.output}|${usage.cacheRead}`;
      if (seen.has(key)) return;
      seen.add(key);
      addRow(rows, {
        date: dayOf(createdMs),
        source: 'opencode',
        model: `${provider || 'unknown'}/${model || 'unknown'}`,
        usage,
      });
      count += 1;
    };

    for (const p of paths) {
      if (p.endsWith('.db')) {
        await collectDb(p, ingest);
      } else {
        for (const file of walk(p, (n) => n.endsWith('.json'))) {
          const m = readJson(file);
          if (m?.role === 'assistant') ingest(m.time?.created, m.tokens, m.providerID, m.modelID);
        }
      }
    }
    return count;
  },
};

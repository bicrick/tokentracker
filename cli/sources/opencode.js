import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { addRow, dayOf } from '../day.js';

const DB_PATH = process.env.OPENCODE_DB
  || path.join(os.homedir(), '.local/share/opencode/opencode.db');

// OpenCode stores assistant messages (with token counts) in `session_message`
// (current schema) and `message` (legacy schema). Messages from the legacy
// table were migrated, so we prefer v2 and only fall back when it's missing.
export async function collectOpencode(rows) {
  if (!fs.existsSync(DB_PATH)) return { source: 'opencode', skipped: 'db not found' };

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const hasTable = (name) => !!db
    .prepare("select 1 from sqlite_master where type='table' and name=?")
    .get(name);

  let count = 0;
  const seen = new Set();

  const ingest = (createdMs, tokens, providerID, modelID) => {
    if (!tokens) return;
    const t = JSON.parse(tokens);
    const usage = {
      input: t.input,
      output: t.output,
      reasoning: t.reasoning,
      cacheRead: t.cache?.read,
      cacheWrite: t.cache?.write,
    };
    // Dedupe identical (time, tokens) pairs across legacy/v2 tables
    const key = `${createdMs}|${tokens}`;
    if (seen.has(key)) return;
    seen.add(key);
    addRow(rows, {
      date: dayOf(createdMs),
      source: 'opencode',
      model: `${providerID || 'unknown'}/${modelID || 'unknown'}`,
      usage,
    });
    count += 1;
  };

  if (hasTable('session_message')) {
    const stmt = db.prepare(`
      select time_created as t,
             json_extract(data, '$.tokens') as tokens,
             json_extract(data, '$.model.providerID') as provider,
             json_extract(data, '$.model.id') as model
      from session_message
      where type = 'assistant' and json_extract(data, '$.tokens') is not null
    `);
    for (const r of stmt.iterate()) ingest(r.t, r.tokens, r.provider, r.model);
  }

  if (hasTable('message')) {
    const stmt = db.prepare(`
      select coalesce(json_extract(data, '$.time.created'), time_created) as t,
             json_extract(data, '$.tokens') as tokens,
             json_extract(data, '$.providerID') as provider,
             json_extract(data, '$.modelID') as model
      from message
      where json_extract(data, '$.role') = 'assistant'
        and json_extract(data, '$.tokens') is not null
    `);
    for (const r of stmt.iterate()) {
      // strip `total` so the key matches the v2 token blob shape
      const t = JSON.parse(r.tokens);
      delete t.total;
      ingest(r.t, JSON.stringify(t), r.provider, r.model);
    }
  }

  db.close();
  return { source: 'opencode', messages: count };
}

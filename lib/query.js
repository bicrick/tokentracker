// Hosted API: database access on top of the shared query logic in cli/core.
import { db } from './db.js';

export * from '../cli/core/query.js';
import { dateStr } from '../cli/core/query.js';

const where = (handle, f) => db()`
  select date, source, model, input, output, reasoning, cache_read, cache_write, messages, device
  from usage
  where account = ${handle}
    and (${f.from}::date is null or date >= ${f.from}::date)
    and (${f.to}::date is null or date <= ${f.to}::date)
    and (${f.tools}::text[] is null or source = any(${f.tools}::text[]))
    and (${f.models}::text[] is null or model = any(${f.models}::text[]))`;

/** Load filtered rows once; every resource derives from these. */
export async function loadRows(handle, filters) {
  const rows = await where(handle, filters);
  return rows.map((r) => ({ ...r, date: dateStr(r.date) }));
}

export async function deviceSyncs(handle) {
  const rows = await db()`select device, max(updated_at) as synced from usage where account = ${handle} group by device`;
  return new Map(rows.map((r) => [r.device, r.synced instanceof Date ? r.synced.toISOString() : r.synced]));
}

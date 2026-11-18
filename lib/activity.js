import { db } from './db.js';

export async function getActivity(account) {
  const q = db();
  const [daily, models, devices] = await Promise.all([
    q`
      select to_char(date, 'YYYY-MM-DD') as date, source,
             sum(input + output + reasoning + cache_read + cache_write)::bigint as tokens
      from usage where account = ${account}
      group by date, source order by date`,
    q`
      select source, model,
             sum(input + output + reasoning + cache_read + cache_write)::bigint as tokens,
             sum(input)::bigint as input, sum(output + reasoning)::bigint as output,
             sum(cache_read + cache_write)::bigint as cache,
             sum(messages)::int as messages
      from usage where account = ${account}
      group by source, model order by tokens desc`,
    q`
      select device, source, max(updated_at) as "updatedAt"
      from usage where account = ${account}
      group by device, source order by device, source`,
  ]);

  const byDate = new Map();
  const totals = {};
  for (const row of daily) {
    const tokens = Number(row.tokens);
    const day = byDate.get(row.date) || { date: row.date, count: 0, sources: {} };
    day.count += tokens;
    day.sources[row.source] = tokens;
    byDate.set(row.date, day);
    totals[row.source] = (totals[row.source] || 0) + tokens;
  }

  return {
    handle: account,
    activityCounts: [...byDate.values()],
    totals,
    models: models.map((m) => ({
      ...m,
      tokens: Number(m.tokens),
      input: Number(m.input),
      output: Number(m.output),
      cache: Number(m.cache),
    })),
    devices,
    fetchedAt: new Date().toISOString(),
  };
}

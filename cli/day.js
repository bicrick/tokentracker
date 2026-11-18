export const TIME_ZONE = process.env.TOKEN_TZ || 'America/Chicago';

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function dayOf(ms) {
  return fmt.format(new Date(ms));
}

export function emptyUsage() {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, messages: 0 };
}

export function addRow(map, { date, source, model, usage }) {
  const key = `${date}|${source}|${model}`;
  let row = map.get(key);
  if (!row) {
    row = { date, source, model, ...emptyUsage() };
    map.set(key, row);
  }
  row.input += usage.input || 0;
  row.output += usage.output || 0;
  row.reasoning += usage.reasoning || 0;
  row.cacheRead += usage.cacheRead || 0;
  row.cacheWrite += usage.cacheWrite || 0;
  row.messages += 1;
}

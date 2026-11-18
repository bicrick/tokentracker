import { neon } from '@neondatabase/serverless';

let sql;
let schemaReady;

export function db() {
  if (!sql) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    sql = neon(url);
  }
  return sql;
}

export async function ensureSchema() {
  schemaReady ||= (async () => {
    const q = db();
    await q`
      create table if not exists usage (
        account     text   not null,
        device      text   not null,
        source      text   not null,
        date        date   not null,
        model       text   not null,
        input       bigint not null default 0,
        output      bigint not null default 0,
        reasoning   bigint not null default 0,
        cache_read  bigint not null default 0,
        cache_write bigint not null default 0,
        messages    integer not null default 0,
        updated_at  timestamptz not null default now(),
        primary key (account, device, source, date, model)
      )`;
    await q`
      create table if not exists accounts (
        handle        text primary key,
        key_hash      text not null unique,
        cursor_handle text,
        created_at    timestamptz not null default now()
      )`;
    // Email sign-in: optional email per account, one key per machine,
    // pending magic-link requests, and web sessions for the settings page
    await q`alter table accounts add column if not exists email text`;
    await q`create unique index if not exists accounts_email on accounts (lower(email))`;
    await q`
      create table if not exists device_keys (
        key_hash   text primary key,
        handle     text not null,
        device     text not null,
        created_at timestamptz not null default now(),
        last_used  timestamptz,
        revoked_at timestamptz
      )`;
    await q`
      create table if not exists auth_requests (
        id          text primary key,
        token_hash  text not null unique,
        device_hash text unique,
        email       text not null,
        handle      text,
        purpose     text not null,
        device      text,
        cursor      text,
        status      text not null default 'pending',
        result_handle text,
        created_at  timestamptz not null default now(),
        expires_at  timestamptz not null
      )`;
    await q`
      create table if not exists web_sessions (
        token_hash text primary key,
        handle     text not null,
        created_at timestamptz not null default now(),
        expires_at timestamptz not null
      )`;
    await q`
      create table if not exists meta (
        key   text primary key,
        value text not null
      )`;
  })();
  return schemaReady;
}

// Collectors send a full recomputation of each source's history (or of the
// days since `since`), so an ingest replaces that slice rather than adding.
export async function replaceUsage({ account, device, sources, rows, since = null }) {
  const q = db();
  const payload = JSON.stringify(rows);
  await q.transaction([
    q`delete from usage where account = ${account} and device = ${device} and source = any(${sources})
        and (${since}::date is null or date >= ${since}::date)`,
    q`
      insert into usage (account, device, source, date, model, input, output, reasoning, cache_read, cache_write, messages)
      select ${account}, ${device}, r.source, r.date::date, r.model,
             coalesce(r.input, 0), coalesce(r.output, 0), coalesce(r.reasoning, 0),
             coalesce(r."cacheRead", 0), coalesce(r."cacheWrite", 0), coalesce(r.messages, 0)
      from jsonb_to_recordset(${payload}::jsonb) as r(
        source text, date text, model text, input bigint, output bigint, reasoning bigint,
        "cacheRead" bigint, "cacheWrite" bigint, messages integer
      )
      where r.source = any(${sources})
      on conflict (account, device, source, date, model) do update set
        input = excluded.input, output = excluded.output, reasoning = excluded.reasoning,
        cache_read = excluded.cache_read, cache_write = excluded.cache_write,
        messages = excluded.messages, updated_at = now()`,
  ]);
}

export async function getMeta(key) {
  const rows = await db()`select value from meta where key = ${key}`;
  return rows[0]?.value ?? null;
}

export async function setMeta(key, value) {
  await db()`
    insert into meta (key, value) values (${key}, ${value})
    on conflict (key) do update set value = excluded.value`;
}

export async function createAccount({ handle, keyHash, cursorHandle }) {
  const rows = await db()`
    insert into accounts (handle, key_hash, cursor_handle)
    values (${handle}, ${keyHash}, ${cursorHandle})
    on conflict (handle) do nothing
    returning handle`;
  return rows.length > 0;
}

export async function accountByKeyHash(keyHash) {
  const rows = await db()`select handle, cursor_handle from accounts where key_hash = ${keyHash}`;
  return rows[0] ?? null;
}

export async function accountByHandle(handle) {
  const rows = await db()`select handle, cursor_handle from accounts where handle = ${handle}`;
  return rows[0] ?? null;
}

export async function updateCursorHandle(handle, cursorHandle) {
  await db()`update accounts set cursor_handle = ${cursorHandle} where handle = ${handle}`;
}

export async function deleteAccount(handle) {
  const q = db();
  await q.transaction([
    q`delete from usage where account = ${handle}`,
    q`delete from meta where key = ${`cursor_fetched_at:${handle}`}`,
    q`delete from device_keys where handle = ${handle}`,
    q`delete from web_sessions where handle = ${handle}`,
    q`delete from accounts where handle = ${handle}`,
  ]);
}

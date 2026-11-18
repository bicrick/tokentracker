#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectAll, CONNECTORS, resolveConnections } from './sources/index.js';
import { installSchedule, LOG_PATH, removeSchedule, scheduleInstalled, supported as scheduleSupported } from './scheduler.js';
import { box, c, formatTokens, input, isTTY, line, logo, multiselect, select, spinner, sym, task } from './ui.js';

const CONFIG_DIR = process.env.TOKENTRACK_CONFIG_DIR || path.join(os.homedir(), '.config', 'tokentrack');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const SELF = fileURLToPath(import.meta.url);
const HOSTED = process.env.TOKENTRACK_HOSTED || 'https://tokentracker-nu.vercel.app';
// Stable copy of the CLI for the background job, so it survives npx cache cleanup
const INSTALL_DIR = path.join(os.homedir(), '.local', 'share', 'tokentrack');
const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;
const RECENT_DAYS = 7;

// node:sqlite is stable enough for read-only use; hide its experimental warning
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...args) => {
  if (String(warning).includes('SQLite')) return;
  emitWarning(warning, ...args);
};

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    if (!args[i].startsWith('--')) continue;
    const name = args[i].slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next;
      i += 1;
    } else {
      flags[name] = true;
    }
  }
  return flags;
}

function tildify(p) {
  return p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p;
}

async function collect(config = readConfig()) {
  const connections = resolveConnections(config);
  const rows = new Map();
  const report = await collectAll(connections, rows);
  const totals = {};
  for (const r of rows.values()) {
    totals[r.source] = (totals[r.source] || 0) + r.input + r.output + r.reasoning + r.cacheRead + r.cacheWrite;
  }
  return {
    connections,
    report: report.map((r) => ({ ...r, tokens: totals[r.id] || 0 })),
    sources: report.filter((r) => r.messages !== undefined).map((r) => r.id),
    rows: [...rows.values()],
  };
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

async function api(server, pathname, { method = 'GET', key, body } = {}) {
  const res = await fetch(new URL(pathname, server), {
    method,
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

// The first upload sends full history; later ones send only recent days and
// ask the server to replace just that window, which keeps syncs small.
async function upload(config, { sources, rows }, { full = false } = {}) {
  const incremental = !full && config.fullSyncAt;
  const since = incremental ? daysAgo(RECENT_DAYS) : undefined;
  const body = {
    device: config.device || defaultDevice(),
    sources,
    rows: since ? rows.filter((r) => r.date >= since) : rows,
    ...(since ? { since } : {}),
  };
  const res = await api(config.server, '/api/ingest', { method: 'POST', key: config.key, body });
  if (!res.ok) throw new Error(res.json.error || `upload failed (${res.status})`);
  const updates = incremental ? {} : { fullSyncAt: new Date().toISOString() };
  // Configs from older versions don't know their handle; learn it once
  if (!config.handle) {
    const me = await api(config.server, '/api/account', { key: config.key }).catch(() => null);
    if (me?.ok) updates.handle = me.json.handle;
  }
  if (Object.keys(updates).length) writeConfig({ ...readConfig(), ...updates });
  return { ...res.json, since };
}

function defaultDevice() {
  return os.hostname().replace(/\.local$/, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40) || 'computer';
}

function networkHint(err) {
  const code = err?.cause?.code || '';
  if (code.includes('CERT') || code.includes('ISSUER')) {
    return 'TLS certificate error. Behind a corporate proxy? Re-run with NODE_USE_SYSTEM_CA=1';
  }
  return err?.cause?.message || err.message;
}

function printReport(report, { hideMissing = false } = {}) {
  for (const r of report) {
    if (r.error) line(`    ${sym.fail} ${r.name.padEnd(12)} ${c.red(r.error)}`);
    else if (r.skipped) {
      if (!hideMissing) line(`    ${sym.skip} ${c.gray(`${r.name.padEnd(12)} ${r.skipped}`)}`);
    } else {
      line(`    ${sym.dot} ${r.name.padEnd(12)} ${c.blue(formatTokens(r.tokens).padStart(7))} ${c.gray(`tokens · ${r.messages.toLocaleString()} responses`)}`);
    }
  }
}

/** Interactive checklist of connections; saves choices to config. */
async function chooseConnections(config) {
  const connections = resolveConnections(config);
  const options = connections.map((conn) => ({
    value: conn.id,
    label: conn.name,
    checked: conn.enabled,
    disabled: conn.paths.length === 0,
    hint: conn.paths.length
      ? `${conn.mode === 'auto' ? c.green('Auto') : 'Manual'} · ${conn.displayPaths[0]}${conn.paths.length > 1 ? ` +${conn.paths.length - 1}` : ''}`
      : 'not found on this machine',
  }));
  const picked = new Set(await multiselect('Which tools should be tracked?', options));
  const settings = { ...(config.connections || {}) };
  for (const conn of connections) {
    if (!conn.paths.length) continue;
    const on = picked.has(conn.id);
    // Stay on auto when the choice matches detection, so new installs keep working
    settings[conn.id] = { ...settings[conn.id], enabled: on === conn.detected && (settings[conn.id]?.enabled ?? 'auto') === 'auto' ? 'auto' : on };
  }
  return { ...config, connections: settings };
}

// ─── sync ──────────────────────────────────────────────────────────────────────

async function sync(flags) {
  const config = readConfig();
  const data = await collect();

  if (flags.dry) {
    printReport(data.report);
    line(`\n  ${c.bold('Dry run.')} This is exactly what would be uploaded:\n`);
    line(JSON.stringify({ device: config.device || defaultDevice(), sources: data.sources, rows: data.rows }, null, 2));
    return;
  }

  if (!config.server || !config.key) {
    line(`  ${sym.fail} Not set up yet. Run ${c.blue('tokentrack init')}`);
    process.exit(1);
  }

  // Background runs log plain lines; interactive runs get spinners
  if (!isTTY) {
    const summary = data.report.filter((r) => !r.skipped).map((r) => `${r.id}=${r.error ? 'error' : formatTokens(r.tokens)}`).join(' ');
    try {
      const res = await upload(config, data, { full: !!flags.full });
      line(`[${new Date().toISOString()}] sync ok ${summary} rows=${res.rows}${res.since ? ` since=${res.since}` : ' full'}`);
    } catch (err) {
      line(`[${new Date().toISOString()}] sync failed ${summary}: ${networkHint(err)}`);
      process.exit(1);
    }
    return;
  }

  printReport(data.report, { hideMissing: true });
  await task('Uploading daily totals', () => upload(config, data, { full: !!flags.full }),
    (res) => `Synced ${res.rows} day/model rows ${c.gray(res.since ? `(since ${res.since})` : '(full history)')}`)
    .catch((err) => {
      line(`    ${c.gray(networkHint(err))}`);
      process.exit(1);
    });
}

// ─── init ──────────────────────────────────────────────────────────────────────

async function init(flags) {
  line();
  const mark = logo();
  box([
    `${mark[0]}   ${sym.star} ${c.bold('Welcome to tokentracker')}`,
    `${mark[1]}   ${c.gray('every AI token you spend, every tool,')}`,
    `${mark[2]}   ${c.gray('every machine, in one place')}`,
  ], { pad: 2 });
  line();
  line(`  ${c.gray('Only daily token counts leave this machine. Never prompts, code, or keys.')}`);
  line();

  // 1. Scan
  const existing = readConfig();
  line(`  ${c.bold('Looking for AI tools on this machine')}`);
  const scan = spinner('Checking Claude Code, Codex, OpenCode, Gemini CLI, Copilot CLI, Cline, Roo, Kilo…');
  let data = await collect(existing);
  const found = data.connections.filter((conn) => conn.paths.length).length;
  scan.succeed(`Found ${found} tool${found === 1 ? '' : 's'} with usage`);
  printReport(data.report, { hideMissing: true });
  line();

  // 2. Connections
  let connectionSettings = existing.connections;
  if (isTTY && found > 0 && !flags.yes) {
    connectionSettings = (await chooseConnections(existing)).connections;
    data = await collect({ ...existing, connections: connectionSettings });
    line();
  }

  // 3. Account
  let { server, key, handle } = existing;
  let cursorHandle = null;

  if (server && key && !flags.reset) {
    line(`  ${sym.ok} Already connected as ${c.blue(`@${handle || 'unknown'}`)} ${c.gray(`on ${new URL(server).host}`)}`);
    line(`    ${c.gray('run with --reset to start over')}`);
  } else {
    const mode = flags.server || flags.key ? 'existing'
      : flags.hosted ? 'hosted'
        : await select('Where should your usage live?', [
          { value: 'hosted', label: 'Create a free account', hint: `tokentracker cloud · ${new URL(HOSTED).host}` },
          { value: 'existing', label: 'Connect an existing account', hint: 'another machine of yours, or your own self-hosted server' },
        ]);
    line();

    if (mode === 'hosted') {
      server = HOSTED;
      for (;;) {
        handle = flags.handle || await input('Pick a public handle', {
          placeholder: 'letters, numbers, dashes',
          validate: (v) => (HANDLE_RE.test(v.toLowerCase()) ? null : 'Use 1-30 lowercase letters, numbers or dashes'),
        });
        handle = handle.toLowerCase();
        cursorHandle = flags.cursor !== undefined ? (flags.cursor === true ? '' : flags.cursor)
          : await input('Cursor handle', { placeholder: 'from cursor.com/@handle · enter to skip' });

        const res = await task('Creating your account', () => api(server, '/api/signup', {
          method: 'POST',
          body: { handle, cursorHandle: cursorHandle || null },
        }).catch((err) => { throw new Error(networkHint(err)); }), (r) => (r.ok ? `Created ${c.blue(`@${handle}`)}` : 'Signup failed'));

        if (res.ok) {
          key = res.json.key;
          break;
        }
        line(`    ${c.red(res.json.error || `status ${res.status}`)}`);
        if (flags.handle) process.exit(1);
      }
    } else {
      server = flags.server && flags.server !== true ? flags.server
        : await input('Server URL', { initial: HOSTED });
      key = flags.key && flags.key !== true ? flags.key
        : await input('Account key', { placeholder: `from ${tildify(CONFIG_PATH)} on your other machine` });
      const me = await task('Checking your key', () => api(server, '/api/account', { key })
        .catch((err) => { throw new Error(networkHint(err)); }), (r) => (r.ok ? `Signed in as ${c.blue(`@${r.json.handle}`)}` : 'Key rejected'));
      if (!me.ok) {
        line(`    ${c.gray('Double-check the server URL and key, then run init again.')}`);
        process.exit(1);
      }
      handle = me.json.handle;
    }
  }

  // 4. Machine
  line();
  const device = flags.device && flags.device !== true ? flags.device
    : existing.device && !flags.reset ? existing.device
      : await input('Name this machine', {
        initial: defaultDevice(),
        validate: (v) => (/^[\w.-]{1,40}$/.test(v) ? null : 'Use up to 40 letters, numbers, dots or dashes'),
      });

  writeConfig({ server, key, handle, device, connections: connectionSettings });
  const config = readConfig();

  // 5. Sync + background
  line();
  await task('Uploading your history', () => upload(config, data, { full: true })
    .catch((err) => { throw new Error(networkHint(err)); }), (res) => `Uploaded ${res.rows} day/model rows`)
    .catch(() => process.exit(1));

  if (!flags['no-install'] && scheduleSupported) {
    await task('Turning on background sync', async () => installSchedule({ node: process.execPath, entry: copyCli(), configDir: CONFIG_DIR }),
      (r) => `Background sync on ${c.gray(`(${r.method}, ${r.detail}, no admin needed)`)}`)
      .catch(() => line(`    ${c.gray('Run tokentrack install later to retry.')}`));
  }

  // 5. Done
  const profile = new URL(`/u/${handle}`, server).toString();
  line();
  box([
    `${sym.ok} ${c.bold("You're all set")}`,
    '',
    `${c.gray('profile ')} ${c.blue(c.under(profile))}`,
    `${c.gray('api     ')} ${new URL(`/api/activity?handle=${handle}`, server)}`,
    `${c.gray('config  ')} ${tildify(CONFIG_PATH)} ${c.gray('(keep private)')}`,
  ], { pad: 2 });
  line();
  line(`  ${c.bold('Next')}`);
  line(`  ${sym.dot} Add another machine: run ${c.blue('npx github:bicrick/tokentracker init')} there and`);
  line(`    choose ${c.italic('Connect an existing account')} with the key from your config`);
  line(`  ${sym.dot} Add or change tools: ${c.blue('tokentrack connect')}`);
  line(`  ${sym.dot} See exactly what gets sent: ${c.blue('tokentrack sync --dry')}`);
  line();
}

// ─── account ───────────────────────────────────────────────────────────────────

async function deleteAccount(flags) {
  const { server, key, handle } = readConfig();
  if (!server || !key) {
    line(`  ${sym.fail} Not set up.`);
    process.exit(1);
  }
  if (!flags.yes) {
    line(`  ${c.red('This deletes')} ${c.bold(`@${handle}`)} ${c.red('and all its data from')} ${new URL(server).host}.`);
    const answer = await input('Type your handle to confirm');
    if (answer !== handle) {
      line(`  ${sym.skip} Cancelled.`);
      return;
    }
  }
  const res = await task('Deleting account', () => api(server, '/api/account', { method: 'DELETE', key }), 'Account deleted');
  if (res.ok) {
    removeSchedule(CONFIG_DIR);
    fs.rmSync(CONFIG_PATH, { force: true });
  } else {
    line(`  ${sym.fail} ${res.json.error || res.status}`);
  }
}

function login(flags) {
  if (!flags.server || !flags.key) {
    line('Usage: tokentrack login --server <url> --key <key> [--device <name>]');
    process.exit(1);
  }
  const config = { ...readConfig(), server: flags.server, key: flags.key };
  if (flags.device) config.device = flags.device;
  writeConfig(config);
  line(`  ${sym.ok} Saved ${tildify(CONFIG_PATH)}`);
}

// ─── background sync ───────────────────────────────────────────────────────────

function copyCli() {
  const src = path.dirname(SELF);
  const dest = path.join(INSTALL_DIR, 'cli');
  if (src === dest) return path.join(dest, 'tokentrack.js');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  // node needs to know these are ES modules
  fs.writeFileSync(path.join(INSTALL_DIR, 'package.json'), '{ "type": "module" }\n');
  return path.join(dest, 'tokentrack.js');
}

function install() {
  const config = readConfig();
  if (!config.server || !config.key) {
    line(`  ${sym.fail} Run ${c.blue('tokentrack init')} first.`);
    process.exit(1);
  }
  const r = installSchedule({ node: process.execPath, entry: copyCli(), configDir: CONFIG_DIR });
  line(`  ${sym.ok} Background sync on ${c.gray(`(${r.method}, ${r.detail}) · logs: ${tildify(LOG_PATH)}`)}`);
}

function uninstall() {
  line(removeSchedule() ? `  ${sym.ok} Background sync off` : `  ${sym.skip} Background sync was not on`);
}

// ─── connect ───────────────────────────────────────────────────────────────────

async function connect(flags) {
  let config = readConfig();
  line();

  if (flags.add) {
    // tokentrack connect --add <tool> <path>
    const id = flags.add;
    const target = rest.find((a) => !a.startsWith('--') && a !== id);
    if (!CONNECTORS.some((conn) => conn.id === id) || !target) {
      line(`  Usage: tokentrack connect --add <${CONNECTORS.map((conn) => conn.id).join('|')}> <path>`);
      process.exit(1);
    }
    const s = config.connections?.[id] || {};
    config.connections = { ...config.connections, [id]: { ...s, enabled: true, paths: [...new Set([...(s.paths || []), target])] } };
    writeConfig(config);
    line(`  ${sym.ok} Added ${target} to ${id}`);
    return;
  }

  if (!isTTY) {
    for (const conn of resolveConnections(config)) {
      line(`  ${conn.enabled ? sym.ok : sym.skip} ${conn.name.padEnd(12)} ${c.gray(conn.paths.length ? `${conn.mode} · ${conn.displayPaths.join(', ')}` : 'not found')}`);
    }
    return;
  }

  const action = await select('Connections', [
    { value: 'tools', label: 'Choose which tools to track', hint: 'auto-detected on this machine' },
    { value: 'path', label: 'Add a custom folder', hint: 'for tools installed somewhere unusual' },
    { value: 'cursor', label: 'Connect Cursor', hint: config.cursorHandle ? `@${config.cursorHandle}` : 'via your public cursor.com profile' },
  ]);
  line();

  if (action === 'tools') {
    config = await chooseConnections(config);
  } else if (action === 'path') {
    const id = await select('Which tool?', CONNECTORS.map((conn) => ({ value: conn.id, label: conn.name })));
    const target = await input('Folder path', { validate: (v) => (fs.existsSync(v.replace(/^~/, os.homedir())) ? null : 'That path does not exist') });
    const s = config.connections?.[id] || {};
    config.connections = { ...config.connections, [id]: { ...s, enabled: true, paths: [...new Set([...(s.paths || []), target])] } };
  } else if (action === 'cursor') {
    if (!config.server || !config.key) {
      line(`  ${sym.fail} Run ${c.blue('tokentrack init')} first.`);
      return;
    }
    const cursorHandle = await input('Cursor handle', { placeholder: 'from cursor.com/@handle · enter to disconnect' });
    const res = await task('Saving', () => api(config.server, '/api/account', { method: 'POST', key: config.key, body: { cursorHandle: cursorHandle || null } }),
      (r) => (r.ok ? (cursorHandle ? `Cursor connected as @${cursorHandle}` : 'Cursor disconnected') : 'Could not save'));
    if (!res.ok) line(`    ${c.red(res.json.error || res.status)}`);
    else config.cursorHandle = cursorHandle || undefined;
  }

  writeConfig(config);
  if (config.server && config.key && action !== 'cursor') {
    line();
    const data = await collect(config);
    printReport(data.report, { hideMissing: true });
    await task('Syncing', () => upload(config, data, { full: true }), (r) => `Synced ${r.rows} day/model rows`);
  }
  line();
}

function status() {
  const config = readConfig();
  const row = (k, v) => line(`  ${c.gray(k.padEnd(9))}${v}`);
  line();
  row('account', config.handle ? c.blue(`@${config.handle}`) : c.gray('not set up'));
  row('server', config.server || c.gray('-'));
  row('machine', config.device || defaultDevice());
  row('sync', scheduleInstalled() ? `${sym.ok} background, hourly` : `${sym.skip} not scheduled ${c.gray('(tokentrack install)')}`);
  row('config', tildify(CONFIG_PATH));
  if (config.server && config.handle) row('profile', c.blue(new URL(`/u/${config.handle}`, config.server).toString()));
  line(`\n  ${c.gray('tools')}`);
  for (const conn of resolveConnections(config)) {
    if (!conn.paths.length) continue;
    line(`  ${conn.enabled ? sym.ok : sym.skip} ${conn.name.padEnd(12)} ${c.gray(`${conn.mode === 'auto' ? 'Auto' : conn.enabled ? 'On' : 'Off'} · ${conn.displayPaths.join(', ')}`)}`);
  }
  if (fs.existsSync(LOG_PATH)) {
    const lines = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n').slice(-3);
    line(`\n  ${c.gray('recent syncs')}`);
    for (const l of lines) line(`  ${c.gray(l)}`);
  }
  line();
}

const HELP = `
  ${c.bold('tokentrack')} ${c.gray('· every AI token you spend, in one place')}

  ${c.bold('Usage')}
    tokentrack init              guided setup
    tokentrack connect           choose tools, add folders, connect Cursor
    tokentrack sync [--dry]      upload daily totals (--dry prints the payload, --full resends history)
    tokentrack status            account, machine and recent syncs
    tokentrack install           sync hourly in the background (macOS, Linux, Windows)
    tokentrack uninstall         stop background sync
    tokentrack delete-account    delete your account and all data

  ${c.bold('init flags')}
    --hosted --handle <h> [--cursor <h>]   create a cloud account without prompts
    --server <url> --key <key>             connect an existing account
    --device <name>  --reset  --no-install  --yes (accept detected tools)
`;

const [command, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);

switch (command) {
  case 'init': await init(flags); break;
  case 'login': login(flags); break;
  case 'connect':
  case 'connections': await connect(flags); break;
  case 'delete-account': await deleteAccount(flags); break;
  case 'sync': await sync(flags); break;
  case 'install': install(); break;
  case 'uninstall': uninstall(); break;
  case 'status': status(); break;
  default: line(HELP);
}

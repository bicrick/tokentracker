#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectOpencode } from './sources/opencode.js';
import { collectClaude } from './sources/claude.js';
import { box, c, formatTokens, input, isTTY, line, logo, select, spinner, sym, task } from './ui.js';

const CONFIG_DIR = process.env.TOKENTRACK_CONFIG_DIR || path.join(os.homedir(), '.config', 'tokentrack');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const LABEL = 'com.tokentrack.sync';
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG_PATH = path.join(os.homedir(), 'Library', 'Logs', 'tokentrack.log');
const SELF = fileURLToPath(import.meta.url);
const HOSTED = process.env.TOKENTRACK_HOSTED || 'https://tokentracker-nu.vercel.app';
// Stable copy of the CLI for the background job, so it survives npx cache cleanup
const INSTALL_DIR = path.join(os.homedir(), '.local', 'share', 'tokentrack');
const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;
const SOURCE_NAMES = { opencode: 'opencode', 'claude-code': 'claude code', cursor: 'cursor' };

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

async function collect() {
  const rows = new Map();
  const report = [await collectOpencode(rows), collectClaude(rows)];
  const totals = {};
  for (const r of rows.values()) {
    totals[r.source] = (totals[r.source] || 0) + r.input + r.output + r.reasoning + r.cacheRead + r.cacheWrite;
  }
  return {
    report: report.map((r) => ({ ...r, tokens: totals[r.source] || 0 })),
    sources: report.filter((r) => !r.skipped).map((r) => r.source),
    rows: [...rows.values()],
  };
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

async function upload(config, { sources, rows }) {
  const res = await api(config.server, '/api/ingest', {
    method: 'POST',
    key: config.key,
    body: { device: config.device || defaultDevice(), sources, rows },
  });
  if (!res.ok) throw new Error(res.json.error || `upload failed (${res.status})`);
  return res.json;
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

// ─── sync ──────────────────────────────────────────────────────────────────────

async function sync(flags) {
  const config = readConfig();
  const data = await collect();

  if (flags.dry) {
    for (const r of data.report) {
      line(r.skipped
        ? `  ${sym.skip} ${c.gray(`${SOURCE_NAMES[r.source]}: ${r.skipped}`)}`
        : `  ${sym.ok} ${SOURCE_NAMES[r.source]} ${c.gray(`${r.messages} responses · ${formatTokens(r.tokens)} tokens`)}`);
    }
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
    const summary = data.report.map((r) => `${r.source}=${r.skipped ? 'skipped' : formatTokens(r.tokens)}`).join(' ');
    try {
      const res = await upload(config, data);
      line(`[${new Date().toISOString()}] sync ok ${summary} rows=${res.rows}`);
    } catch (err) {
      line(`[${new Date().toISOString()}] sync failed ${summary}: ${networkHint(err)}`);
      process.exit(1);
    }
    return;
  }

  for (const r of data.report) {
    if (!r.skipped) line(`  ${sym.ok} ${SOURCE_NAMES[r.source]} ${c.gray(`${formatTokens(r.tokens)} tokens`)}`);
  }
  await task('Uploading daily totals', () => upload(config, data), (res) => `Synced ${res.rows} day/model rows to ${c.gray(new URL(config.server).host)}`)
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
  line(`  ${c.bold('Looking for usage on this machine')}`);
  const scan = spinner('Reading local logs…');
  const data = await collect();
  scan.succeed(`Found ${data.rows.length} day/model rows`);
  for (const r of data.report) {
    line(r.skipped
      ? `    ${sym.skip} ${c.gray(`${SOURCE_NAMES[r.source]}  not found`)}`
      : `    ${sym.dot} ${SOURCE_NAMES[r.source].padEnd(12)} ${c.blue(formatTokens(r.tokens).padStart(7))} ${c.gray(`tokens · ${r.messages.toLocaleString()} responses`)}`);
  }
  line();

  // 2. Account
  const existing = readConfig();
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

  // 3. Machine
  line();
  const device = flags.device && flags.device !== true ? flags.device
    : existing.device && !flags.reset ? existing.device
      : await input('Name this machine', {
        initial: defaultDevice(),
        validate: (v) => (/^[\w.-]{1,40}$/.test(v) ? null : 'Use up to 40 letters, numbers, dots or dashes'),
      });

  const config = { server, key, handle, device };
  writeConfig(config);

  // 4. Sync + background
  line();
  await task('Uploading your history', () => upload(config, data)
    .catch((err) => { throw new Error(networkHint(err)); }), (res) => `Uploaded ${res.rows} day/model rows`)
    .catch(() => process.exit(1));

  if (process.platform === 'darwin' && !flags['no-install']) {
    await task('Installing hourly sync', async () => installLaunchd(), 'Hourly sync installed');
  } else if (process.platform !== 'darwin') {
    const entry = copyCli();
    line(`  ${sym.skip} ${c.gray('Hourly sync: add this to your crontab')}`);
    line(`    ${c.blue(`0 * * * * ${process.execPath} ${entry} sync`)}`);
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
    removeLaunchd({ onlyOwn: true });
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

function plist(entry) {
  const args = [process.execPath, entry, 'sync'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${a}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_USE_SYSTEM_CA</key><string>1</string>
    <key>NODE_NO_WARNINGS</key><string>1</string>
    <key>TOKENTRACK_CONFIG_DIR</key><string>${CONFIG_DIR}</string>
  </dict>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${LOG_PATH}</string>
  <key>StandardErrorPath</key><string>${LOG_PATH}</string>
</dict>
</plist>
`;
}

function installLaunchd() {
  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  try {
    execFileSync('launchctl', ['unload', PLIST_PATH], { stdio: 'ignore' });
  } catch {
    // not loaded yet
  }
  fs.writeFileSync(PLIST_PATH, plist(copyCli()));
  execFileSync('launchctl', ['load', PLIST_PATH]);
}

function removeLaunchd({ onlyOwn = false } = {}) {
  if (!fs.existsSync(PLIST_PATH)) return false;
  // Don't remove a job that syncs a different config (e.g. another account on this machine)
  if (onlyOwn && !fs.readFileSync(PLIST_PATH, 'utf8').includes(`<string>${CONFIG_DIR}</string>`)) return false;
  try {
    execFileSync('launchctl', ['unload', PLIST_PATH], { stdio: 'ignore' });
  } catch {
    // already unloaded
  }
  fs.unlinkSync(PLIST_PATH);
  return true;
}

function install() {
  if (process.platform !== 'darwin') {
    line(`  ${sym.skip} install supports macOS. On Linux, run ${c.blue('tokentrack sync')} hourly from cron.`);
    process.exit(1);
  }
  const config = readConfig();
  if (!config.server || !config.key) {
    line(`  ${sym.fail} Run ${c.blue('tokentrack init')} first.`);
    process.exit(1);
  }
  installLaunchd();
  line(`  ${sym.ok} Hourly sync installed ${c.gray(`· logs: ${tildify(LOG_PATH)}`)}`);
}

function uninstall() {
  line(removeLaunchd() ? `  ${sym.ok} Hourly sync removed` : `  ${sym.skip} Hourly sync was not installed`);
}

function status() {
  const config = readConfig();
  const row = (k, v) => line(`  ${c.gray(k.padEnd(9))}${v}`);
  line();
  row('account', config.handle ? c.blue(`@${config.handle}`) : c.gray('not set up'));
  row('server', config.server || c.gray('-'));
  row('machine', config.device || defaultDevice());
  row('hourly', fs.existsSync(PLIST_PATH) ? `${sym.ok} installed` : `${sym.skip} not installed`);
  row('config', tildify(CONFIG_PATH));
  if (config.server && config.handle) row('profile', c.blue(new URL(`/u/${config.handle}`, config.server).toString()));
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
    tokentrack sync [--dry]      upload daily totals (--dry prints the payload)
    tokentrack status            account, machine and recent syncs
    tokentrack install           run sync hourly in the background (macOS)
    tokentrack uninstall         stop the hourly sync
    tokentrack delete-account    delete your account and all data

  ${c.bold('init flags')}
    --hosted --handle <h> [--cursor <h>]   create a cloud account without prompts
    --server <url> --key <key>             connect an existing account
    --device <name>  --reset  --no-install
`;

const [command, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);

switch (command) {
  case 'init': await init(flags); break;
  case 'login': login(flags); break;
  case 'delete-account': await deleteAccount(flags); break;
  case 'sync': await sync(flags); break;
  case 'install': install(); break;
  case 'uninstall': uninstall(); break;
  case 'status': status(); break;
  default: line(HELP);
}

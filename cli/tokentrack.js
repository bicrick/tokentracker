#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import readline from 'node:readline/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectOpencode } from './sources/opencode.js';
import { collectClaude } from './sources/claude.js';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'tokentrack');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const LABEL = 'com.tokentrack.sync';
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG_PATH = path.join(os.homedir(), 'Library', 'Logs', 'tokentrack.log');
const SELF = fileURLToPath(import.meta.url);
const HOSTED = process.env.TOKENTRACK_HOSTED || 'https://tokentracker-nu.vercel.app';
// Stable copy of the CLI for the background job, so it survives npx cache cleanup
const INSTALL_DIR = path.join(os.homedir(), '.local', 'share', 'tokentrack');

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
    if (next && !next.startsWith('--')) {
      flags[name] = next;
      i += 1;
    } else {
      flags[name] = true;
    }
  }
  return flags;
}

function formatTokens(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

async function collect() {
  const rows = new Map();
  const report = [await collectOpencode(rows), collectClaude(rows)];
  return {
    report,
    sources: report.filter((r) => !r.skipped).map((r) => r.source),
    rows: [...rows.values()],
  };
}

async function sync(flags) {
  const config = readConfig();
  const { report, sources, rows } = await collect();

  const totals = {};
  for (const r of rows) {
    totals[r.source] = (totals[r.source] || 0)
      + r.input + r.output + r.reasoning + r.cacheRead + r.cacheWrite;
  }

  console.log(`[${new Date().toISOString()}] tokentrack sync`);
  for (const r of report) {
    if (r.skipped) console.log(`  ${r.source}: skipped (${r.skipped})`);
    else console.log(`  ${r.source}: ${r.messages} messages, ${formatTokens(totals[r.source] || 0)} tokens`);
  }

  const payload = { device: config.device || os.hostname(), sources, rows };

  if (flags.dry) {
    console.log('\nDry run. This is exactly what would be uploaded:\n');
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (!config.server || !config.key) {
    console.error('\nNot logged in. Run: tokentrack login --server <url> --key <key>');
    process.exit(1);
  }

  const res = await fetch(new URL('/api/ingest', config.server), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.key}` },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  console.log(`  upload: ${res.status} ${text}`);
  if (!res.ok) process.exit(1);
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

function defaultDevice() {
  return os.hostname().replace(/\.local$/, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40);
}

async function init(flags) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, fallback = '') => {
    const answer = (await rl.question(fallback ? `${q} (${fallback}): ` : `${q}: `)).trim();
    return answer || fallback;
  };

  console.log('\ntokentrack: one heatmap for every AI token you spend.');
  console.log('Only daily token counts leave this machine. Never prompts, code, or keys.\n');

  // Preview what this machine would contribute before asking anything else
  const { report, rows } = await collect();
  for (const r of report) {
    console.log(r.skipped ? `  ${r.source}: not found` : `  ${r.source}: ${r.messages} messages found`);
  }
  console.log(`  ${rows.length} day/model rows ready to upload\n`);

  const existing = readConfig();
  let { server, key } = existing;
  let handle = existing.handle;

  if (server && key && !flags.reset) {
    console.log(`Already connected to ${server} as ${handle || 'unknown'}. Use --reset to start over.\n`);
  } else {
    let mode = flags.server ? 'self' : flags.hosted ? 'hosted' : '';
    while (!['hosted', 'self'].includes(mode)) {
      console.log('Where should your usage be stored?');
      console.log(`  1) new free account on tokentracker cloud (${HOSTED})`);
      console.log('  2) existing account: another machine, or your own self-hosted server');
      const choice = await ask('Choose 1 or 2', '1');
      mode = choice === '2' ? 'self' : choice === '1' ? 'hosted' : '';
    }

    if (mode === 'hosted') {
      server = HOSTED;
      for (;;) {
        handle = (flags.handle || await ask('Pick a public handle (letters, numbers, dashes)')).toLowerCase();
        const cursorHandle = flags.cursor ?? await ask('Your Cursor handle from cursor.com/@handle (blank to skip)', '');
        const res = await api(server, '/api/signup', {
          method: 'POST',
          body: { handle, cursorHandle: cursorHandle || null },
        });
        if (res.ok) {
          key = res.json.key;
          break;
        }
        console.log(`  ${res.json.error || `signup failed (${res.status})`}`);
        flags.handle = undefined;
        flags.cursor = undefined;
      }
    } else {
      server = flags.server || await ask('Server URL', HOSTED);
      key = flags.key || await ask('Ingest key');
      const me = await api(server, '/api/account', { key });
      if (!me.ok) {
        console.error(`Could not authenticate with ${server} (${me.status}).`);
        rl.close();
        process.exit(1);
      }
      handle = me.json.handle;
    }
  }

  const device = flags.device || existing.device || await ask('Name this machine', defaultDevice());
  rl.close();

  writeConfig({ server, key, handle, device });
  console.log(`\nSaved ${CONFIG_PATH} (keep it private, it holds your key)`);

  await sync({});

  if (process.platform === 'darwin' && !flags['no-install']) {
    install();
  } else if (process.platform !== 'darwin') {
    console.log('\nTo sync hourly, add this to your crontab:');
    console.log(`  0 * * * * ${process.execPath} ${copyCli()} sync`);
  }

  console.log(`\nDone. Your profile: ${new URL(`/u/${handle}`, server)}`);
  console.log(`On another machine: run init, choose "existing account", and paste your key`);
  console.log(`(it's in ${CONFIG_PATH}). Give each machine a different name.`);
}

async function deleteAccount() {
  const { server, key, handle } = readConfig();
  if (!server || !key) {
    console.error('Not logged in.');
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Delete ${handle} and all its data from ${server}? Type the handle to confirm: `)).trim();
  rl.close();
  if (answer !== handle) {
    console.log('Cancelled.');
    return;
  }
  const res = await api(server, '/api/account', { method: 'DELETE', key });
  console.log(res.ok ? 'Account deleted.' : `Failed: ${res.json.error || res.status}`);
  if (res.ok) {
    uninstall();
    fs.rmSync(CONFIG_PATH, { force: true });
  }
}

function login(flags) {
  if (!flags.server || !flags.key) {
    console.error('Usage: tokentrack login --server <url> --key <key> [--device <name>]');
    process.exit(1);
  }
  const config = { ...readConfig(), server: flags.server, key: flags.key };
  if (flags.device) config.device = flags.device;
  writeConfig(config);
  console.log(`Saved ${CONFIG_PATH}`);
}

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
  </dict>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${LOG_PATH}</string>
  <key>StandardErrorPath</key><string>${LOG_PATH}</string>
</dict>
</plist>
`;
}

function install() {
  if (process.platform !== 'darwin') {
    console.error('install currently supports macOS (launchd). On Linux, add `tokentrack sync` to cron hourly.');
    process.exit(1);
  }
  const config = readConfig();
  if (!config.server || !config.key) {
    console.error('Run `tokentrack login` first.');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  try {
    execFileSync('launchctl', ['unload', PLIST_PATH], { stdio: 'ignore' });
  } catch {
    // not loaded yet
  }
  fs.writeFileSync(PLIST_PATH, plist(copyCli()));
  execFileSync('launchctl', ['load', PLIST_PATH]);
  console.log(`Installed hourly sync (${PLIST_PATH})\nLogs: ${LOG_PATH}`);
}

function uninstall() {
  if (fs.existsSync(PLIST_PATH)) {
    try {
      execFileSync('launchctl', ['unload', PLIST_PATH], { stdio: 'ignore' });
    } catch {
      // already unloaded
    }
    fs.unlinkSync(PLIST_PATH);
  }
  console.log('Removed hourly sync.');
}

function status() {
  const config = readConfig();
  console.log(`config:  ${CONFIG_PATH}`);
  console.log(`server:  ${config.server || '(not set)'}`);
  console.log(`handle:  ${config.handle || '(unknown)'}`);
  console.log(`device:  ${config.device || os.hostname()}`);
  console.log(`key:     ${config.key ? `${config.key.slice(0, 4)}…` : '(not set)'}`);
  console.log(`hourly:  ${fs.existsSync(PLIST_PATH) ? 'installed' : 'not installed'}`);
  if (fs.existsSync(LOG_PATH)) {
    const lines = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n');
    console.log(`\nlast log lines:\n${lines.slice(-5).join('\n')}`);
  }
}

const HELP = `tokentrack - track AI token usage across tools and devices

Usage:
  tokentrack init             guided setup: sign up (free) or connect your own server
  tokentrack login --server <url> --key <key> [--device <name>]
  tokentrack sync [--dry]     collect local usage and upload daily totals
  tokentrack install          run sync hourly in the background (macOS)
  tokentrack uninstall        stop the hourly sync
  tokentrack status           show config and recent sync logs
  tokentrack delete-account   delete your account and all data on the server

Only daily token counts per tool and model are uploaded.
Run \`tokentrack sync --dry\` to see the exact payload.`;

const [command, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);

switch (command) {
  case 'init': await init(flags); break;
  case 'login': login(flags); break;
  case 'delete-account': await deleteAccount(); break;
  case 'sync': await sync(flags); break;
  case 'install': install(); break;
  case 'uninstall': uninstall(); break;
  case 'status': status(); break;
  default: console.log(HELP);
}

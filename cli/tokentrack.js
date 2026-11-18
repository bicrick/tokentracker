#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
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

function collect() {
  const rows = new Map();
  const report = [collectOpencode(rows), collectClaude(rows)];
  return {
    report,
    sources: report.filter((r) => !r.skipped).map((r) => r.source),
    rows: [...rows.values()],
  };
}

async function sync(flags) {
  const config = readConfig();
  const { report, sources, rows } = collect();

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

function plist() {
  const args = [process.execPath, SELF, 'sync'];
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
  fs.writeFileSync(PLIST_PATH, plist());
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
  tokentrack login --server <url> --key <key> [--device <name>]
  tokentrack sync [--dry]     collect local usage and upload daily totals
  tokentrack install          run sync hourly in the background (macOS)
  tokentrack uninstall        stop the hourly sync
  tokentrack status           show config and recent sync logs

Only daily token counts per tool and model are uploaded.
Run \`tokentrack sync --dry\` to see the exact payload.`;

const [command, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);

switch (command) {
  case 'login': login(flags); break;
  case 'sync': await sync(flags); break;
  case 'install': install(); break;
  case 'uninstall': uninstall(); break;
  case 'status': status(); break;
  default: console.log(HELP);
}

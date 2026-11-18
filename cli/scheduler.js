// Per-user hourly background sync on macOS, Linux and Windows. No admin rights.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME, xdgConfig } from './fs-util.js';

const LABEL = 'com.tokentrack.sync';
const PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const SYSTEMD_DIR = path.join(xdgConfig(), 'systemd', 'user');
const WIN_TASK = 'tokentrack sync';

export const LOG_PATH = process.platform === 'darwin'
  ? path.join(HOME, 'Library', 'Logs', 'tokentrack.log')
  : process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'tokentrack', 'sync.log')
    : path.join(HOME, '.local', 'state', 'tokentrack', 'sync.log');

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' }).toString();
const tryRun = (cmd, args) => {
  try {
    return run(cmd, args);
  } catch {
    return null;
  }
};

function xml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

// ─── macOS: launchd LaunchAgent ───────────────────────────────────────────────

function macInstall({ node, entry, configDir }) {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(entry)}</string>
    <string>sync</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_USE_SYSTEM_CA</key><string>1</string>
    <key>NODE_NO_WARNINGS</key><string>1</string>
    <key>TOKENTRACK_CONFIG_DIR</key><string>${xml(configDir)}</string>
  </dict>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(LOG_PATH)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG_PATH)}</string>
</dict>
</plist>
`;
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  tryRun('launchctl', ['unload', PLIST]);
  fs.writeFileSync(PLIST, plist);
  run('launchctl', ['load', PLIST]);
  return { method: 'launchd', detail: 'runs hourly and at login' };
}

function macOwnedBy(configDir) {
  return fs.existsSync(PLIST) && fs.readFileSync(PLIST, 'utf8').includes(`<string>${xml(configDir)}</string>`);
}

function macRemove() {
  if (!fs.existsSync(PLIST)) return false;
  tryRun('launchctl', ['unload', PLIST]);
  fs.unlinkSync(PLIST);
  return true;
}

// ─── Linux: systemd user timer, cron fallback ─────────────────────────────────

const CRON_TAG = '# tokentrack';

function linuxInstall({ node, entry, configDir }) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  const env = `NODE_USE_SYSTEM_CA=1 NODE_NO_WARNINGS=1 TOKENTRACK_CONFIG_DIR=${configDir}`;

  if (tryRun('systemctl', ['--user', 'show-environment']) !== null) {
    fs.mkdirSync(SYSTEMD_DIR, { recursive: true });
    fs.writeFileSync(path.join(SYSTEMD_DIR, 'tokentrack.service'), `[Unit]
Description=tokentrack sync

[Service]
Type=oneshot
Environment=${env.split(' ').join('\nEnvironment=')}
ExecStart="${node}" "${entry}" sync
StandardOutput=append:${LOG_PATH}
StandardError=append:${LOG_PATH}
`);
    fs.writeFileSync(path.join(SYSTEMD_DIR, 'tokentrack.timer'), `[Unit]
Description=tokentrack hourly sync

[Timer]
OnBootSec=2min
OnUnitActiveSec=1h
Persistent=true

[Install]
WantedBy=timers.target
`);
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', 'tokentrack.timer']);
    return { method: 'systemd', detail: 'user timer, hourly' };
  }

  const current = (tryRun('crontab', ['-l']) || '').split('\n').filter((l) => l && !l.includes(CRON_TAG));
  current.push(`0 * * * * ${env} "${node}" "${entry}" sync >> "${LOG_PATH}" 2>&1 ${CRON_TAG}`);
  execFileSync('crontab', ['-'], { input: `${current.join('\n')}\n` });
  return { method: 'cron', detail: 'hourly' };
}

function linuxOwnedBy(configDir) {
  const unit = path.join(SYSTEMD_DIR, 'tokentrack.service');
  if (fs.existsSync(unit)) return fs.readFileSync(unit, 'utf8').includes(`TOKENTRACK_CONFIG_DIR=${configDir}`);
  return (tryRun('crontab', ['-l']) || '').includes(`TOKENTRACK_CONFIG_DIR=${configDir}`);
}

function linuxRemove() {
  let removed = false;
  if (fs.existsSync(path.join(SYSTEMD_DIR, 'tokentrack.timer'))) {
    tryRun('systemctl', ['--user', 'disable', '--now', 'tokentrack.timer']);
    for (const f of ['tokentrack.timer', 'tokentrack.service']) fs.rmSync(path.join(SYSTEMD_DIR, f), { force: true });
    tryRun('systemctl', ['--user', 'daemon-reload']);
    removed = true;
  }
  const cron = tryRun('crontab', ['-l']);
  if (cron?.includes(CRON_TAG)) {
    const kept = cron.split('\n').filter((l) => l && !l.includes(CRON_TAG));
    execFileSync('crontab', ['-'], { input: kept.length ? `${kept.join('\n')}\n` : '' });
    removed = true;
  }
  return removed;
}

// ─── Windows: per-user Task Scheduler job ─────────────────────────────────────

function winScript() {
  return path.join(path.dirname(LOG_PATH), 'sync.cmd');
}

function winInstall({ node, entry, configDir }) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  // A .cmd wrapper carries env vars and log redirection; launched hidden via conhost-free wscript is overkill here.
  fs.writeFileSync(winScript(), [
    '@echo off',
    'set NODE_USE_SYSTEM_CA=1',
    'set NODE_NO_WARNINGS=1',
    `set TOKENTRACK_CONFIG_DIR=${configDir}`,
    `"${node}" "${entry}" sync >> "${LOG_PATH}" 2>&1`,
    '',
  ].join('\r\n'));
  run('schtasks', ['/Create', '/F', '/SC', 'HOURLY', '/TN', WIN_TASK, '/TR', `"${winScript()}"`]);
  return { method: 'Task Scheduler', detail: 'hourly while signed in' };
}

function winOwnedBy(configDir) {
  return fs.existsSync(winScript()) && fs.readFileSync(winScript(), 'utf8').includes(`TOKENTRACK_CONFIG_DIR=${configDir}`);
}

function winRemove() {
  const ok = tryRun('schtasks', ['/Delete', '/F', '/TN', WIN_TASK]) !== null;
  fs.rmSync(winScript(), { force: true });
  return ok;
}

// ─── public API ───────────────────────────────────────────────────────────────

const impl = {
  darwin: { install: macInstall, owned: macOwnedBy, remove: macRemove, installed: () => fs.existsSync(PLIST) },
  win32: { install: winInstall, owned: winOwnedBy, remove: winRemove, installed: () => tryRun('schtasks', ['/Query', '/TN', WIN_TASK]) !== null },
  linux: {
    install: linuxInstall,
    owned: linuxOwnedBy,
    remove: linuxRemove,
    installed: () => fs.existsSync(path.join(SYSTEMD_DIR, 'tokentrack.timer')) || !!tryRun('crontab', ['-l'])?.includes(CRON_TAG),
  },
}[process.platform] || null;

export const supported = !!impl;

export function installSchedule(opts) {
  if (!impl) throw new Error(`background sync is not supported on ${os.platform()}`);
  return impl.install(opts);
}

export function scheduleInstalled() {
  return impl ? impl.installed() : false;
}

/** Remove the job. With configDir, only remove it if it belongs to that config. */
export function removeSchedule(configDir) {
  if (!impl) return false;
  if (configDir && !impl.owned(configDir)) return false;
  return impl.remove();
}

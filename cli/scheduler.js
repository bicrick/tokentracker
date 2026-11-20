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

/**
 * A launcher the job runs instead of a fixed node binary: tries the node that
 * ran init, then whatever node it can find (PATH, nvm default, newest nvm,
 * Homebrew, Volta, fnm), using the first that is new enough. If none is, it
 * shows a desktop notification instead of failing silently every hour.
 */
export function writeLauncher({ node, entry, configDir }) {
  const dir = path.dirname(path.dirname(entry));
  if (process.platform === 'win32') {
    const file = path.join(dir, 'sync.cmd');
    fs.writeFileSync(file, [
      '@echo off',
      'set NODE_USE_SYSTEM_CA=1',
      'set NODE_NO_WARNINGS=1',
      `set TOKENTRACK_CONFIG_DIR=${configDir}`,
      `set NODE_BIN=${node}`,
      'if not exist "%NODE_BIN%" for /f "delims=" %%n in (\'where node 2^>nul\') do (set NODE_BIN=%%n& goto found)',
      ':found',
      'if not exist "%NODE_BIN%" (',
      `  echo [%date% %time%] sync failed: Node.js 22.13+ not found >> "${LOG_PATH}"`,
      `  powershell -NoProfile -Command "[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Warning;$n.Visible=$true;$n.ShowBalloonTip(10000,'tokentracker: uploads stopped','Node.js 22.13+ was not found. Reinstall Node, then run npx @bicrick/tokentracker init','Warning');Start-Sleep 11"`,
      '  exit /b 1',
      ')',
      `"%NODE_BIN%" "${entry}" sync >> "${LOG_PATH}" 2>&1`,
      '',
    ].join('\r\n'));
    return file;
  }
  const file = path.join(dir, 'run.sh');
  const sh = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
  fs.writeFileSync(file, `#!/bin/sh
# tokentracker background sync launcher (written by tokentrack install)
export NODE_USE_SYSTEM_CA=1 NODE_NO_WARNINGS=1 TOKENTRACK_CONFIG_DIR=${sh(configDir)}
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:/usr/bin:$HOME/.volta/bin:$HOME/.local/share/fnm/aliases/default/bin"
ENTRY=${sh(entry)}
LOG=${sh(LOG_PATH)}
ok() { [ -x "$1" ] && "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null; }
NVM="\${NVM_DIR:-$HOME/.nvm}"
DEFAULT=""
[ -f "$NVM/alias/default" ] && DEFAULT="$NVM/versions/node/v$(sed 's/^v//' "$NVM/alias/default")/bin/node"
for n in ${sh(node)} "$(command -v node 2>/dev/null)" "$DEFAULT" $(ls -d "$NVM"/versions/node/v*/bin/node 2>/dev/null | sort -rV 2>/dev/null || ls -dr "$NVM"/versions/node/v*/bin/node 2>/dev/null) /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if ok "$n"; then exec "$n" "$ENTRY" sync; fi
done
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] sync failed: Node.js 22.13+ not found" >> "$LOG"
MSG='Node.js 22.13+ was not found, so uploads stopped. Install Node, then run: npx @bicrick/tokentracker init'
STAMP=${sh(path.join(configDir, '.node-missing-notified'))}
if [ ! -f "$STAMP" ] || [ -n "$(find "$STAMP" -mmin +1440 2>/dev/null)" ]; then
  touch "$STAMP"
  if command -v osascript >/dev/null 2>&1; then osascript -e "display notification \"$MSG\" with title \"tokentracker: uploads stopped\"" >/dev/null 2>&1
  elif command -v notify-send >/dev/null 2>&1; then notify-send --app-name=tokentracker 'tokentracker: uploads stopped' "$MSG" >/dev/null 2>&1; fi
fi
exit 1
`, { mode: 0o755 });
  return file;
}

function xml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

// ─── macOS: launchd LaunchAgent ───────────────────────────────────────────────

function macInstall(opts) {
  const { configDir } = opts;
  const launcher = writeLauncher(opts);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${xml(launcher)}</string>
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

function linuxInstall(opts) {
  const { configDir } = opts;
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  const launcher = writeLauncher(opts);
  const env = `NODE_USE_SYSTEM_CA=1 NODE_NO_WARNINGS=1 TOKENTRACK_CONFIG_DIR=${configDir}`;

  if (tryRun('systemctl', ['--user', 'show-environment']) !== null) {
    fs.mkdirSync(SYSTEMD_DIR, { recursive: true });
    fs.writeFileSync(path.join(SYSTEMD_DIR, 'tokentrack.service'), `[Unit]
Description=tokentrack sync

[Service]
Type=oneshot
Environment=${env.split(' ').join('\nEnvironment=')}
ExecStart=/bin/sh "${launcher}"
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
  current.push(`0 * * * * ${env} /bin/sh "${launcher}" >> "${LOG_PATH}" 2>&1 ${CRON_TAG}`);
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

let winLauncher = null;
function winScript() {
  return winLauncher || path.join(os.homedir(), '.local', 'share', 'tokentrack', 'sync.cmd');
}

function winInstall(opts) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  winLauncher = writeLauncher(opts);
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

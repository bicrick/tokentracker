// Background sync health: remembers how the last uploads went, warns the user
// on their desktop when uploads stop, and keeps the installed copy up to date.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const DAY = 24 * 60 * 60 * 1000;
export const STALE_AFTER = 6 * 60 * 60 * 1000; // an hourly job this far behind is worth mentioning
const NOTIFY_AFTER = DAY; // only interrupt the user once uploads have been failing for a day
const PACKAGE = '@bicrick/tokentracker';

// ─── state ────────────────────────────────────────────────────────────────────

export function statePath(configDir) {
  return path.join(configDir, 'state.json');
}

export function readState(configDir) {
  try {
    return JSON.parse(fs.readFileSync(statePath(configDir), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(configDir, state) {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(statePath(configDir), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

/** Record a finished sync. Returns the new state. */
export function recordSync(configDir, { ok, error = null, signedOut = false }) {
  const prev = readState(configDir);
  const now = new Date().toISOString();
  const next = ok
    ? { ...prev, lastSuccess: now, lastAttempt: now, failures: 0, lastError: null, signedOut: false, notifiedAt: null }
    : { ...prev, lastAttempt: now, failures: (prev.failures || 0) + 1, lastError: error, signedOut };
  writeState(configDir, next);
  return next;
}

export function markWorkflowChecked(configDir) {
  writeState(configDir, { ...readState(configDir), workflowCheckedAt: new Date().toISOString() });
}

/** A human summary of upload health, or null when everything is fine. */
export function healthProblem(state, now = Date.now()) {
  if (state.signedOut) return 'This machine was signed out, so uploads stopped. Run init to sign in again.';
  const last = state.lastSuccess ? Date.parse(state.lastSuccess) : null;
  if (last && now - last < STALE_AFTER) return null;
  if (!last && !state.failures) return null;
  const since = last ? `since ${ago(now - last)}` : 'yet';
  return `No upload ${since}${state.lastError ? `: ${state.lastError}` : ''}`;
}

export function ago(ms) {
  const h = Math.round(ms / 3_600_000);
  if (h < 1) return 'under an hour ago';
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return `${Math.round(h / 24)} days ago`;
}

// ─── desktop notifications ────────────────────────────────────────────────────

/** Show a desktop notification. Best effort: silently does nothing if unavailable. */
export function notify(title, message) {
  try {
    if (process.platform === 'darwin') {
      const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      execFileSync('osascript', ['-e', `display notification ${q(message)} with title ${q(title)}`], { stdio: 'ignore', timeout: 5000 });
    } else if (process.platform === 'linux') {
      execFileSync('notify-send', ['--app-name=tokentracker', title, message], { stdio: 'ignore', timeout: 5000 });
    } else if (process.platform === 'win32') {
      const ps = `[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime];`
        + `$x=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(1);`
        + `$t=$x.GetElementsByTagName('text');$t.Item(0).AppendChild($x.CreateTextNode('${title.replace(/'/g, "''")}'))|Out-Null;`
        + `$t.Item(1).AppendChild($x.CreateTextNode('${message.replace(/'/g, "''")}'))|Out-Null;`
        + `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('tokentracker').Show([Windows.UI.Notifications.ToastNotification]::new($x))`;
      execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore', timeout: 10000 });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * After a failed background sync, tell the user once uploads have been
 * failing for a day (or straight away if the machine was signed out), and
 * then at most once a day.
 */
export function maybeNotify(configDir, state, fixCommand) {
  const now = Date.now();
  const last = state.lastSuccess ? Date.parse(state.lastSuccess) : null;
  const failingFor = last ? now - last : (state.failures || 0) * 3_600_000;
  if (!state.signedOut && failingFor < NOTIFY_AFTER) return false;
  if (state.notifiedAt && now - Date.parse(state.notifiedAt) < DAY) return false;
  const shown = notify('tokentracker: uploads stopped', `${healthProblem(state, now)}. Fix it with: ${fixCommand}`);
  if (shown) writeState(configDir, { ...state, notifiedAt: new Date(now).toISOString() });
  return shown;
}

// ─── self-update of the installed background copy ─────────────────────────────

const newer = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

/** Minimal tar reader: yields { name, data } for regular files. */
function* untar(buf) {
  for (let off = 0; off + 512 <= buf.length;) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) return;
    const str = (s, l) => header.subarray(s, s + l).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(str(124, 12).trim() || '0', 8);
    const type = str(156, 1) || '0';
    const prefix = str(345, 155);
    const name = prefix ? `${prefix}/${str(0, 100)}` : str(0, 100);
    off += 512;
    if (type === '0') yield { name, data: buf.subarray(off, off + size) };
    off += Math.ceil(size / 512) * 512;
  }
}

/**
 * If a newer version is on npm, swap it into installDir/cli. Checks at most
 * once a day, verifies the tarball's integrity hash, and replaces the folder
 * atomically so a failed download never leaves a broken install.
 */
export async function autoUpdate({ configDir, installDir, current }) {
  if (process.env.TOKENTRACK_NO_UPDATE) return null;
  const state = readState(configDir);
  if (state.updateCheckedAt && Date.now() - Date.parse(state.updateCheckedAt) < DAY) return null;
  writeState(configDir, { ...state, updateCheckedAt: new Date().toISOString() });

  const meta = await fetch(`https://registry.npmjs.org/${PACKAGE}/latest`, { signal: AbortSignal.timeout(10000) }).then((r) => (r.ok ? r.json() : null));
  if (!meta?.version || !meta.dist?.tarball || !newer(meta.version, current)) return null;

  const tgz = Buffer.from(await (await fetch(meta.dist.tarball, { signal: AbortSignal.timeout(30000) })).arrayBuffer());
  const [algo, expected] = String(meta.dist.integrity || '').split('-');
  if (algo !== 'sha512' || createHash('sha512').update(tgz).digest('base64') !== expected) throw new Error('update integrity check failed');

  const staging = path.join(installDir, 'cli.next');
  fs.rmSync(staging, { recursive: true, force: true });
  let files = 0;
  for (const { name, data } of untar(zlib.gunzipSync(tgz))) {
    if (!name.startsWith('package/cli/')) continue;
    const rel = name.slice('package/cli/'.length);
    if (!rel || rel.includes('..')) continue;
    const dest = path.join(staging, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    files += 1;
  }
  if (!files || !fs.existsSync(path.join(staging, 'tokentrack.js'))) throw new Error('update package looks incomplete');

  const live = path.join(installDir, 'cli');
  const old = path.join(installDir, 'cli.prev');
  fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(live)) fs.renameSync(live, old);
  fs.renameSync(staging, live);
  fs.rmSync(old, { recursive: true, force: true });
  fs.writeFileSync(path.join(installDir, 'package.json'), `${JSON.stringify({ type: 'module', version: meta.version })}\n`);
  return meta.version;
}

#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectAll, CONNECTORS, resolveConnections } from './sources/index.js';
import { installSchedule, LOG_PATH, removeSchedule, scheduleInstalled, supported as scheduleSupported } from './scheduler.js';
import { buildSite, checkMachines, DATA_REPO, shareSnippets, ensureDataRepo, githubToken, pagesUrl, pollDeviceLogin, refreshWorkflow, startDeviceLogin, uploadMachine } from './github.js';
import { ago, autoUpdate, healthProblem, markWorkflowChecked, maybeNotify, readState, recordSync } from './health.js';
import { box, c, formatTokens, input, isTTY, line, logo, multiselect, select, spinner, sym, task } from './ui.js';

const CONFIG_DIR = process.env.TOKENTRACK_CONFIG_DIR || path.join(os.homedir(), '.config', 'tokentrack');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const SELF = fileURLToPath(import.meta.url);
// Stable copy of the CLI for the background job, so it survives npx cache cleanup
const INSTALL_DIR = path.join(os.homedir(), '.local', 'share', 'tokentrack');
const RECENT_DAYS = 7;
const FIX = 'npx @bicrick/tokentracker status';
// This CLI's version, from its package.json (npm package or installed copy)
const VERSION = (() => {
  for (const p of [path.join(path.dirname(SELF), '..', 'package.json')]) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')).version || '0.0.0'; } catch {}
  }
  return '0.0.0';
})();

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


// The first upload sends full history; later ones send only recent days and
// ask the server to replace just that window, which keeps syncs small.
async function upload(config, { sources, rows }) {
  const token = githubToken(config);
  if (!token) throw Object.assign(new Error('no GitHub login found (run npx @bicrick/tokentracker init to sign in again)'), { status: 401 });
  const target = { owner: config.github.owner, repo: config.github.repo };
  const save = () => uploadMachine(token, { ...target, machineId: machineId().slice(0, 16), sources, rows });
  let res;
  try {
    res = await save();
  } catch (err) {
    // The repo was deleted: set it up again and save what this machine still has
    if (err.status !== 404) throw err;
    await ensureDataRepo(token, { owner: target.owner });
    res = await save();
  }
  // Keep the repo's workflow current with this CLI (checked at most once a day)
  const state = readState(CONFIG_DIR);
  if (!state.workflowCheckedAt || Date.now() - Date.parse(state.workflowCheckedAt) > 864e5) {
    await refreshWorkflow(token, target).catch(() => {});
    markWorkflowChecked(CONFIG_DIR);
  }
  return res;
}

/**
 * A stable, anonymous id for this computer: a SHA-256 of the OS hardware or
 * install id (never sent raw). Lets the server recognise a machine that runs
 * init again, so it reuses the same name instead of counting usage twice.
 */
function machineId() {
  // Once known, this computer's id never changes: it is saved in the config
  const saved = readConfig().machineId;
  if (saved && /^[a-f0-9]{64}$/.test(saved)) return saved;
  let raw = '';
  try {
    if (process.platform === 'darwin') {
      raw = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' }).match(/"IOPlatformUUID" = "([^"]+)"/)?.[1] || '';
    } else if (process.platform === 'win32') {
      raw = execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe'), ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8' }).match(/MachineGuid\s+REG_SZ\s+(\S+)/)?.[1] || '';
    } else {
      for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try { raw = fs.readFileSync(f, 'utf8').trim(); if (raw) break; } catch {}
      }
    }
  } catch {}
  if (!raw) raw = `${os.hostname()}|${os.userInfo().username}|${os.platform()}`;
  return createHash('sha256').update(`tokentracker:${raw}`).digest('hex');
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
    line(JSON.stringify({ machine: machineId().slice(0, 16), rows: data.rows }, null, 2));
    return;
  }

  if (config.storage !== 'github') {
    line(`  ${sym.fail} Not set up yet. Run ${c.blue('npx @bicrick/tokentracker init')}`);
    process.exit(1);
  }

  // Background runs log plain lines; interactive runs get spinners
  if (!isTTY) {
    const summary = data.report.filter((r) => !r.skipped).map((r) => `${r.id}=${r.error ? 'error' : formatTokens(r.tokens)}`).join(' ');
    let failed = false;
    try {
      const res = await upload(config, data);
      recordSync(CONFIG_DIR, { ok: true });
      line(`[${new Date().toISOString()}] sync ok v${VERSION} ${summary} rows=${res.rows}${res.changed ? ' saved' : ' unchanged'}`);
    } catch (err) {
      failed = true;
      const signedOut = err.status === 401;
      const reason = signedOut ? 'GitHub login missing or expired' : networkHint(err);
      const state = recordSync(CONFIG_DIR, { ok: false, error: reason, signedOut });
      line(`[${new Date().toISOString()}] sync failed v${VERSION} ${summary}: ${reason}`);
      if (maybeNotify(CONFIG_DIR, state, signedOut ? 'npx @bicrick/tokentracker init' : FIX)) line(`[${new Date().toISOString()}] notified the user`);
    }
    // The background copy keeps itself current (at most one check a day)
    if (path.dirname(SELF) === path.join(INSTALL_DIR, 'cli')) {
      try {
        const v = await autoUpdate({ configDir: CONFIG_DIR, installDir: INSTALL_DIR, current: VERSION });
        if (v) line(`[${new Date().toISOString()}] updated ${VERSION} -> ${v}`);
      } catch (err) {
        line(`[${new Date().toISOString()}] update skipped: ${err.message}`);
      }
    }
    if (failed) process.exit(1);
    return;
  }

  printReport(data.report, { hideMissing: true });
  await task('Saving daily totals', () => upload(config, data),
    (res) => `${res.changed ? 'Saved' : 'Up to date:'} ${res.rows} day/model rows ${c.gray(`→ ${config.github.owner}/${config.github.repo}`)}`)
    .catch((err) => {
      line(`    ${c.gray(networkHint(err))}`);
      process.exit(1);
    });
}

// ─── sign in ───────────────────────────────────────────────────────────────────

const PENDING = path.join(CONFIG_DIR, 'signin.json');

function openBrowser(url) {
  try {
    if (process.platform === 'darwin') execFileSync('/usr/bin/open', [url], { stdio: 'ignore' });
    else if (process.platform === 'win32') execFileSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
    else execFileSync('xdg-open', [url], { stdio: 'ignore' });
  } catch {}
}

/**
 * Sign in with GitHub by code. In a terminal: show the code, open the
 * browser, wait. For agents and scripts (no terminal): print the code, save
 * the pending sign-in and exit, so the agent can show the user; running init
 * again finishes it.
 */
async function signInWithGitHub() {
  let pending = null;
  try {
    pending = JSON.parse(fs.readFileSync(PENDING, 'utf8'));
    if (Date.now() > pending.startedAt + (pending.expires_in || 900) * 1000 - 30_000) pending = null;
  } catch {}

  const show = (p) => {
    line(`  ${c.bold('Sign in to GitHub')} ${c.gray('(creates and updates your tokentracker-data repo, nothing else)')}`);
    line(`  ${sym.arrow} Open ${c.blue(c.under(p.verification_uri))} and enter ${c.bold(p.user_code)}`);
  };

  if (!pending) {
    pending = await startDeviceLogin().catch((err) => { line(`  ${sym.fail} ${networkHint(err)}`); process.exit(1); });
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(PENDING, JSON.stringify(pending), { mode: 0o600 });
  }
  show(pending);

  if (!isTTY) {
    // Give a quick chance in case the code was already entered, then hand over
    const token = await pollDeviceLogin(pending, { maxWaitMs: 20_000 }).catch(() => null);
    if (token) {
      fs.rmSync(PENDING, { force: true });
      line(`  ${sym.ok} Signed in`);
      return token;
    }
    line();
    line(`  ${c.bold('Waiting for GitHub sign-in.')} Ask the user to open ${pending.verification_uri} and enter ${pending.user_code},`);
    line(`  then run this same command again to finish. The code is valid for ${Math.round((pending.expires_in || 900) / 60)} minutes.`);
    process.exit(2);
  }

  openBrowser(pending.verification_uri);
  const wait = spinner(`Waiting for you to enter the code ${c.gray('(ctrl+c to cancel)')}`);
  try {
    const token = await pollDeviceLogin(pending);
    fs.rmSync(PENDING, { force: true });
    wait.succeed('Signed in to GitHub');
    return token;
  } catch (err) {
    fs.rmSync(PENDING, { force: true });
    wait.fail(`${err.message}. Run init again.`);
    process.exit(1);
  }
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
  const scan = spinner('Checking Claude Code, Codex, OpenCode, Gemini CLI, Copilot CLI, DeepSeek Harness, Cline, Roo, Kilo…');
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

  // 3. Machine name (the file in your repo is keyed by this computer, so renaming never duplicates)
  const device = flags.device && flags.device !== true ? flags.device
    : existing.device && !flags.reset ? existing.device
      : !isTTY || flags.yes ? defaultDevice() // agents and scripts: no prompts
      : await input('Name this machine', {
        initial: defaultDevice(),
        validate: (v) => (/^[\w.-]{1,40}$/.test(v) ? null : 'Use up to 40 letters, numbers, dots or dashes'),
      });

  // 4. Your GitHub: the data repo is the account
  line();
  let token = githubToken(existing);
  let signedIn = false;
  if (!token) {
    token = await signInWithGitHub();
    signedIn = true;
  }
  const prevRepo = existing.storage === 'github' && !flags.reset ? existing.github : null;
  const cursorHandle = flags.cursor !== undefined ? (flags.cursor === true ? '' : flags.cursor)
    : prevRepo || !isTTY || flags.yes ? null
      : await input('Cursor handle', { placeholder: 'from cursor.com/@handle · enter to skip' });
  const repo = await task(`Setting up ${DATA_REPO} on your GitHub`, () => ensureDataRepo(token, { cursorHandle }),
    (r) => `${r.created ? 'Created' : 'Using'} ${c.blue(`${r.owner}/${r.repo}`)} ${c.gray('· GitHub Pages on')}`)
    .catch((err) => { line(`    ${c.red(err.message)}`); process.exit(1); });

  // Only a token you pasted is saved; a gh login is looked up fresh each run
  writeConfig({
    storage: 'github',
    github: { owner: repo.owner, repo: repo.repo },
    handle: repo.owner.toLowerCase(),
    device,
    machineId: machineId(),
    connections: connectionSettings,
    // A sign-in token is saved for the hourly job; gh and env logins are looked up fresh each run
    ...(signedIn ? { token } : existing.token ? { token: existing.token } : {}),
  });
  const config = readConfig();

  // 5. Upload + background
  line();
  await task('Saving your history', () => upload(config, data)
    .catch((err) => { throw new Error(networkHint(err)); }), (res) => (res.rows ? `Saved ${res.rows} day/model rows to ${c.blue(`${repo.owner}/${repo.repo}`)}` : `No AI tool usage on this machine yet ${c.gray('(nothing saved; the hourly sync picks it up once there is)')}`))
    .catch(() => process.exit(1));
  recordSync(CONFIG_DIR, { ok: true });

  if (!flags['no-install'] && scheduleSupported) {
    await task('Turning on background sync', async () => installSchedule({ node: process.execPath, entry: copyCli(), configDir: CONFIG_DIR }),
      (r) => `Background sync on ${c.gray(`(${r.method}, ${r.detail}, no admin needed)`)}`)
      .catch((err) => {
        // Minimal Linux and containers often have neither systemd nor cron
        if (/ENOENT/.test(err.message)) line(`    ${c.gray('No scheduler on this machine (systemd or cron). Run')} ${c.blue('npx @bicrick/tokentracker sync')} ${c.gray('from your own scheduler, e.g. hourly.')}`);
        else line(`    ${c.gray('Run npx @bicrick/tokentracker install later to retry.')}`);
      });
  }

  // 6. Done
  const share = shareSnippets(repo.owner, repo.repo);
  line();
  box([
    `${sym.ok} ${c.bold("You're all set")}`,
    '',
    `${c.gray('page    ')} ${c.blue(c.under(share.page))}`,
    `${c.gray('api     ')} ${share.api}`,
    `${c.gray('data    ')} https://github.com/${repo.owner}/${repo.repo}`,
  ], { pad: 2 });
  line();
  line(`  ${c.bold('Next')}`);
  line(`  ${sym.dot} Your page and API go live in about a minute, once the repo's ${c.italic('tokentracker')} Action finishes`);
  line(`  ${sym.dot} Share it: ${c.blue('npx @bicrick/tokentracker share')} ${c.gray('(your link and a live README badge)')}`);
  line(`  ${sym.dot} Another machine: run ${c.blue('npx @bicrick/tokentracker init')} there, signed into the same GitHub`);
  line(`  ${sym.dot} See exactly what gets saved: ${c.blue('npx @bicrick/tokentracker sync --dry')}`);
  if (!cursorHandle && !repo.cursorHandle) {
    // Agents run init without a terminal, so the Cursor question is theirs to ask
    line(`  ${sym.dot} Cursor not connected. If you use Cursor (an agent should ask the user), run:`);
    line(`    ${c.blue('npx @bicrick/tokentracker@latest connect --cursor <cursor.com username>')}`);
  }
  line();
}

function share() {
  const config = readConfig();
  if (!config.github?.owner) {
    line(`\n  Not set up yet. Run ${c.blue('npx @bicrick/tokentracker init')} first.\n`);
    process.exitCode = 1;
    return;
  }
  const s = shareSnippets(config.github.owner, config.github.repo);
  line();
  line(`  ${c.bold('Your page')}      ${c.blue(s.page)}`);
  line(`  ${c.bold('Your API')}       ${s.api}`);
  line();
  line(`  ${c.bold('README badge')} ${c.gray('(live: shows your tokens this year)')}`);
  line(`  ${s.markdown}`);
  line();
  line(`  ${c.bold('HTML badge')}`);
  line(`  ${s.html}`);
  line();
  line(`  ${c.gray(`Every number is in a public repo, and every change is in its history: ${s.history}`)}`);
  line();
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
  fs.writeFileSync(path.join(INSTALL_DIR, 'package.json'), `${JSON.stringify({ type: 'module', version: VERSION })}\n`);
  return path.join(dest, 'tokentrack.js');
}

function install() {
  const config = readConfig();
  if (config.storage !== 'github') {
    line(`  ${sym.fail} Run ${c.blue('npx @bicrick/tokentracker init')} first.`);
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

  if (flags.cursor !== undefined) {
    // tokentrack connect --cursor <handle>   (no prompts; --cursor alone disconnects)
    if (config.storage !== 'github') {
      line(`  ${sym.fail} Run ${c.blue('npx @bicrick/tokentracker init')} first.`);
      process.exit(1);
    }
    const handle = flags.cursor === true ? '' : String(flags.cursor).replace(/^@/, '').replace(/^https?:\/\/(www\.)?cursor\.com\/@?/, '');
    await task('Saving', () => ensureDataRepo(githubToken(config), { cursorHandle: handle, owner: config.github.owner }),
      () => (handle ? `Cursor connected as @${handle} ${c.gray('(your repo fetches cursor.com/@' + handle + ' every 6 hours)')}` : 'Cursor disconnected'))
      .catch((err) => { line(`    ${c.red(err.message)}`); process.exit(1); });
    return;
  }

  if (flags.add) {
    // tokentrack connect --add <tool> <path>
    const id = flags.add;
    const target = rest.find((a) => !a.startsWith('--') && a !== id);
    if (!CONNECTORS.some((conn) => conn.id === id) || !target) {
      line(`  Usage: npx @bicrick/tokentracker connect --add <${CONNECTORS.map((conn) => conn.id).join('|')}> <path>`);
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
    if (config.storage !== 'github') {
      line(`  ${sym.fail} Run ${c.blue('npx @bicrick/tokentracker init')} first.`);
      return;
    }
    const cursorHandle = await input('Cursor handle', { placeholder: 'from cursor.com/@handle · enter to disconnect' });
    // The data repo's Action fetches Cursor's public profile; it only needs the handle
    await task('Saving', () => ensureDataRepo(githubToken(config), { cursorHandle: cursorHandle || '' }),
      () => (cursorHandle ? `Cursor connected as @${cursorHandle}` : 'Cursor disconnected'))
      .catch((err) => line(`    ${c.red(err.message)}`));
  }

  writeConfig(config);
  if (config.storage === 'github' && action !== 'cursor') {
    line();
    const data = await collect(config);
    printReport(data.report, { hideMissing: true });
    await task('Saving', () => upload(config, data), (r) => `Saved ${r.rows} day/model rows`);
  }
  line();
}

function status() {
  const config = readConfig();
  const row = (k, v) => line(`  ${c.gray(k.padEnd(9))}${v}`);
  line();
  row('account', config.handle ? c.blue(`@${config.handle}`) : c.gray('not set up'));
  if (config.storage === 'github') row('data', `${c.blue(`github.com/${config.github.owner}/${config.github.repo}`)}`);
  else if (config.server) row('data', `${c.red('old hosted account')} ${c.gray('· run init to move to your GitHub')}`);
  row('machine', `${config.device || defaultDevice()} ${c.gray(`(id ${machineId().slice(0, 6)}; the name stays on this computer)`)}`);
  row('sync', scheduleInstalled() ? `${sym.ok} background, hourly` : `${sym.skip} not scheduled ${c.gray('(npx @bicrick/tokentracker install)')}`);
  const state = readState(CONFIG_DIR);
  const problem = healthProblem(state);
  if (problem) row('uploads', `${sym.fail} ${c.red(problem)}`);
  else if (state.lastSuccess) row('uploads', `${sym.ok} last upload ${ago(Date.now() - Date.parse(state.lastSuccess))}`);
  row('version', VERSION);
  row('config', tildify(CONFIG_PATH));
  if (config.storage === 'github') {
    const sh = shareSnippets(config.github.owner, config.github.repo);
    row('page', c.blue(sh.page));
    row('api', c.gray(sh.api));
  }
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
  ${c.bold('tokentracker')} ${c.gray('· every AI token you spend, as an API, stored in your GitHub')}

  ${c.bold('Usage')}  ${c.gray('npx @bicrick/tokentracker <command>')}
    init                       guided setup (creates your ${DATA_REPO} repo)
    connect                    choose tools, add folders, connect Cursor
    sync [--dry]               save daily totals now (--dry prints exactly what is saved)
    status                     machine, repo, last upload and recent syncs
    share                      your page link and a live README badge
    install                    sync hourly in the background (macOS, Linux, Windows)
    uninstall                  stop background sync
    build                      build the static API in a ${DATA_REPO} checkout (its Action runs this)
    check                      open or close a "machine stopped syncing" issue (its Action runs this)

  ${c.bold('init flags')}
    --cursor <handle>   --device <name>   --reset   --no-install   --yes (accept detected tools)

  ${c.bold('GitHub login')}
    init signs you in with a code (github.com/login/device), or uses the gh CLI login
    or TOKENTRACK_GITHUB_TOKEN. Without a terminal it prints the code and exits 2; run init again to finish.
    To delete everything, delete your ${DATA_REPO} repo and run uninstall.
`;

const [command, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);

switch (command) {
  case 'init': await init(flags); break;
  case 'connect':
  case 'connections': await connect(flags); break;
  case 'sync': await sync(flags); break;
  case 'install': install(); break;
  case 'uninstall': uninstall(); break;
  case 'status': status(); break;
  case 'share': share(); break;
  case 'check': await checkMachines({ repoDir: flags.repo && flags.repo !== true ? flags.repo : '.', log: (m) => line(`  ${m}`) }); break;
  case 'build': await buildSite({ repoDir: flags.repo && flags.repo !== true ? flags.repo : '.', outDir: flags.out && flags.out !== true ? flags.out : '_site', owner: flags.owner && flags.owner !== true ? flags.owner : undefined, log: (m) => line(`  ${m}`) }); break;
  default: line(HELP);
}

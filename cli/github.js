// "Store in my GitHub": each user's usage lives in their own repo
// (<owner>/tokentracker-data). Every machine writes its own files under
// machines/<id>/<year>.json; a GitHub Action in that repo runs
// `tokentrack build` and publishes the static API to GitHub Pages.
//
// These repos are meant to last for years without anyone touching them, so:
// - the repo holds only data (plus a small workflow); all logic is in npm
// - every file carries `format`; readers accept every format ever written
// - writes merge, never replace: tools prune old logs, stored days survive
// - one file per machine per year keeps every file small and past years frozen
// - the CLI refreshes the workflow file when a newer one ships
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fetchCursorDaily } from './core/cursor-profile.js';
import { buildStaticApi, toQueryRows } from './core/site.js';

export const DATA_REPO = 'tokentracker-data';
export const FORMAT = 1;
export const WORKFLOW_VERSION = 1;
const API = 'https://api.github.com';
const STALE_DAYS = 3;
const RETIRED_DAYS = 30;
const iso = (d) => d.toISOString().slice(0, 10);
const today = () => iso(new Date());

/** A GitHub token: env, a token saved by init, then the GitHub CLI's login. */
export function githubToken(config = {}) {
  if (process.env.TOKENTRACK_GITHUB_TOKEN) return process.env.TOKENTRACK_GITHUB_TOKEN;
  if (config.token) return config.token;
  for (const gh of ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']) {
    try {
      const t = execFileSync(gh, ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim();
      if (t) return t;
    } catch {}
  }
  return process.env.GITHUB_TOKEN || null;
}

async function gh(token, method, route, body) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(route.startsWith('http') ? route : `${API}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'tokentracker',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }).catch((err) => ({ ok: false, status: 0, err }));
    // Retry network blips and GitHub's transient 5xx a couple of times
    if ((res.status === 0 || res.status >= 500) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    if (res.status === 0) throw res.err;
    const json = res.status === 204 ? {} : await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
  }
}

const fail = (what, r) => Object.assign(new Error(`${what} (${r.status}${r.json?.message ? `: ${r.json.message}` : ''})`), { status: r.status });

export async function githubUser(token) {
  const r = await gh(token, 'GET', '/user');
  if (!r.ok) throw fail(r.status === 401 ? 'GitHub rejected the login' : 'could not read your GitHub user', r);
  return r.json.login;
}

const contentsRoute = (owner, repo, file) => `/repos/${owner}/${repo}/contents/${file.split('/').map(encodeURIComponent).join('/')}`;

/** Read a file from the repo ({ sha, text, json }), or null if it doesn't exist. */
async function getJson(token, owner, repo, file) {
  const r = await gh(token, 'GET', contentsRoute(owner, repo, file));
  if (r.status === 404) return null;
  if (!r.ok) throw fail(`could not read ${file}`, r);
  // Files over 1 MB come back without content: fetch the raw blob instead
  const text = r.json.content
    ? Buffer.from(r.json.content, 'base64').toString('utf8')
    : await fetch(r.json.download_url).then((x) => x.text());
  let json = null;
  try { json = JSON.parse(text); } catch {} // README.md, workflow YAML etc. aren't JSON
  return { sha: r.json.sha, text, json };
}

/** Create or update a file. Skips unchanged content; retries if another write raced us. */
export async function putFile(token, owner, repo, file, content, message, { merge = null } = {}) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    // A brand-new repo answers reads with 409 for a few seconds: back off and retry
    if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
    const cur = await getJson(token, owner, repo, file).catch(() => null);
    const body = merge ? merge(cur?.json ?? null) : content;
    if (body === null) return { changed: false };
    if (cur && cur.text === body) return { changed: false };
    const r = await gh(token, 'PUT', contentsRoute(owner, repo, file), {
      message,
      content: Buffer.from(body).toString('base64'),
      ...(cur ? { sha: cur.sha } : {}),
    });
    if (r.ok) return { changed: true };
    if (r.status !== 409 && r.status !== 422) throw fail(`could not write ${file}`, r);
  }
  throw new Error(`could not write ${file}: it kept changing underneath us`);
}

export const pagesUrl = (owner, repo = DATA_REPO) => `https://${owner.toLowerCase()}.github.io/${repo}`;

// ─── repo setup ───────────────────────────────────────────────────────────────

export const WORKFLOW = `# tokentracker workflow v${WORKFLOW_VERSION}. Managed by the tokentracker CLI, which
# updates this file when a newer version ships; edits here may be replaced.
# Turns machines/**/*.json into a static API on GitHub Pages.
name: tokentracker
on:
  push:
    paths: ['machines/**', 'tokentracker.json', '.github/workflows/tokentracker.yml']
  schedule:
    - cron: '23 */6 * * *' # refresh Cursor and check for machines that stopped syncing
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
  issues: write
concurrency:
  group: pages
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deploy.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - run: npx -y @bicrick/tokentracker@latest build --repo . --out _site
      - run: npx -y @bicrick/tokentracker@latest check --repo .
        env:
          GITHUB_TOKEN: \${{ github.token }}
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: _site
      - id: deploy
        uses: actions/deploy-pages@v4
`;

const README = (owner, repo) => {
  const h = owner.toLowerCase();
  const pages = pagesUrl(owner, repo);
  // Live numbers drawn by shields.io from this repo's own Pages JSON (no server)
  const badge = (label, path, field, color) => `<img alt="${label}" src="https://img.shields.io/badge/dynamic/json?url=${encodeURIComponent(`${pages}/api/v1/${path}`)}&query=${encodeURIComponent(`$.display.${field}`)}&label=${encodeURIComponent(label)}&color=${color}&style=flat-square&cacheSeconds=3600">`;
  return `<p align="center">
  <a href="https://tokentracker.patrickbrown.dev/u/${h}"><img src="https://raw.githubusercontent.com/bicrick/tokentracker/main/docs/assets/banner.png" alt="tokentracker" width="100%"></a>
</p>

<p align="center">
  ${badge('tokens this year', 'ytd/stats.json', 'tokens', 'f0c463')}
  ${badge('active days', 'ytd/stats.json', 'activeDays', '6b9eff')}
  ${badge('current streak', 'stats.json', 'currentStreak', '6b9eff')}
</p>

<p align="center">
  <a href="https://tokentracker.patrickbrown.dev/u/${h}">Profile</a> ·
  <a href="https://tokentracker.patrickbrown.dev/api/v1/users/${h}">API</a> ·
  <a href="AGENTS.md">For agents</a>
</p>

@${h}'s AI coding token usage, tracked by [tokentracker](https://github.com/bicrick/tokentracker). This repo is the database.

Ask your agent:

> Using github.com/${owner}/${repo}, how many tokens did I use this week, and on which models?
`;
};

/** The agent guide that lives in each data repo, with this user's URLs filled in. */
export const AGENTS_DOC = (owner, repo) => {
  const h = owner.toLowerCase();
  const api = `https://tokentracker.patrickbrown.dev/api/v1/users/${h}`;
  const pages = `${pagesUrl(owner, repo)}/api/v1`;
  return `# Agent guide: @${h}'s token usage

This repo holds @${h}'s AI coding token usage: daily totals per tool and model, per machine,
written by the tokentracker CLI. Do not edit files in \`machines/\` by hand.

## Answer questions with the API (no auth, GET, JSON)

    ${api}                  profile and links
    ${api}/stats            totals, active days, busiest day, streaks, today, this month, top tool and model
    ${api}/usage            time series: group=day|week|month|year|total, split=tool|model
    ${api}/models           per model: tokens, responses, share, first/last used
    ${api}/tools            per tool
    ${api}/heatmap          calendar grid (range=year|365d|90d)
    ${api}/devices          per machine, last sync

Filters on all: range=all|ytd|Nd|YYYY, from=YYYY-MM-DD, to=YYYY-MM-DD, tools=a,b, models=x,y,
format=csv (usage, models, tools, devices). Example: \`${api}/usage?range=30d&group=week&split=tool\`

The same data as static files, with no tokentracker server involved:

    ${pages}/stats.json  usage.json  usage-week.json  usage-month.json  models.json  tools.json
    ${pages}/devices.json  heatmap.json  profile.json  rows.json (every row)  index.json
    ${pages}/{ytd,30d,90d,365d}/<same>.json

Semantics: tokens = input + output + reasoning + cacheRead + cacheWrite. responses = model calls.
Dates are local days. Cursor has totals only (model "cursor/all"). Full reference:
https://tokentracker.patrickbrown.dev/llms.txt

## Keep it working

- A machine stopped syncing (an issue says so, or stats look stale): on that computer run
  \`npx @bicrick/tokentracker@latest init --yes\`. Safe to repeat; nothing is counted twice.
- Add another computer: run the same command there, signed into the same GitHub.
- Change the Cursor profile: \`npx @bicrick/tokentracker connect\` (or edit cursorHandle in tokentracker.json).
- Data format: FORMAT.md. Stop syncing: \`npx @bicrick/tokentracker uninstall\`. Delete everything: delete this repo.
`;
};

export const FORMAT_DOC = `# tokentracker data format

Written by the tokentracker CLI. Plain JSON, safe to read with anything.

## Layout

    tokentracker.json                 settings: { "format": 1, "cursorHandle": "name" | null }
    machines/<machine-id>/<year>.json  one file per computer per calendar year
    .github/workflows/tokentracker.yml builds the static API on GitHub Pages

\`<machine-id>\` is a one-way hash of the computer's hardware id, so the same computer
always writes the same files even if it is renamed or set up again.

## Machine file (format 1)

    {
      "format": 1,
      "machine": "<machine-id>",
      "device": "my-laptop",            // display name, may change
      "year": 2026,
      "syncedOn": "2026-11-19",         // last day this machine synced (written at least daily)
      "updatedAt": "2026-11-19T18:00:00Z", // last time any number changed
      "rows": [
        { "date": "2026-11-19", "source": "claude-code", "model": "anthropic/claude-opus-5-5",
          "input": 0, "output": 0, "reasoning": 0, "cacheRead": 0, "cacheWrite": 0, "messages": 0 }
      ]
    }

- \`date\` is a local calendar day on that machine. One row per (date, source, model).
- \`tokens\` = input + output + reasoning + cacheRead + cacheWrite. \`messages\` counts model responses.
- Rows are only ever added or updated, never removed: tools delete old logs, history stays here.

## Compatibility promise

Future versions only add fields or new format numbers. Every tokentracker release reads every
format ever written. If tokentracker disappears, this data and this description still work.
`;

/**
 * Create <owner>/tokentracker-data if needed, add the workflow, README,
 * format spec and settings, and turn on Pages. Safe to run again.
 */
export async function ensureDataRepo(token, { cursorHandle = null, owner: knownOwner = null } = {}) {
  const owner = knownOwner || await githubUser(token);
  const repo = DATA_REPO;
  let r = await gh(token, 'GET', `/repos/${owner}/${repo}`);
  let created = false;
  if (r.status === 404) {
    r = await gh(token, 'POST', '/user/repos', {
      name: repo,
      description: 'My AI coding token usage, as an API (tokentracker)',
      private: false,
      auto_init: true,
      has_issues: true,
      has_wiki: false,
      has_projects: false,
      homepage: `${pagesUrl(owner)}/api/v1/`,
    });
    if (!r.ok) throw fail(`could not create ${owner}/${repo}`, r);
    created = true;
  } else if (!r.ok) {
    throw fail(`could not read ${owner}/${repo}`, r);
  } else if (!r.json.has_issues) {
    await gh(token, 'PATCH', `/repos/${owner}/${repo}`, { has_issues: true }); // the stale-machine alert uses issues
  }

  // Repo page details: description, profile link and topics (tags)
  await gh(token, 'PATCH', `/repos/${owner}/${repo}`, {
    description: `@${owner.toLowerCase()}'s AI coding token usage, as an API · tokentracker`,
    homepage: `https://tokentracker.patrickbrown.dev/u/${owner.toLowerCase()}`,
  });
  await gh(token, 'PUT', `/repos/${owner}/${repo}/topics`, { names: ['tokentracker', 'tokentracker-data', 'ai-usage', 'token-usage', 'llm', 'claude-code'] });

  await putFile(token, owner, repo, 'tokentracker.json', null, 'tokentracker: settings', {
    merge: (cur) => {
      const settings = { format: FORMAT, ...(cur || {}) };
      if (cursorHandle !== null) settings.cursorHandle = cursorHandle || null;
      return `${JSON.stringify(settings, null, 2)}\n`;
    },
  });
  await putFile(token, owner, repo, 'README.md', README(owner, repo), 'tokentracker: readme');
  await putFile(token, owner, repo, 'FORMAT.md', FORMAT_DOC, 'tokentracker: data format');
  await putFile(token, owner, repo, 'AGENTS.md', AGENTS_DOC(owner, repo), 'tokentracker: agent guide');
  await putFile(token, owner, repo, '.github/workflows/tokentracker.yml', WORKFLOW, `tokentracker: workflow v${WORKFLOW_VERSION}`);

  const pages = await gh(token, 'POST', `/repos/${owner}/${repo}/pages`, { build_type: 'workflow' });
  if (!pages.ok && pages.status !== 409) throw fail('could not turn on GitHub Pages', pages);
  if (pages.status === 409) await gh(token, 'PUT', `/repos/${owner}/${repo}/pages`, { build_type: 'workflow' });
  return { owner, repo, created, url: pagesUrl(owner, repo) };
}

/** Refresh the workflow file if this CLI ships a newer one (at most once a day, by the caller). */
export async function refreshWorkflow(token, { owner, repo = DATA_REPO }) {
  const cur = await getJson(token, owner, repo, '.github/workflows/tokentracker.yml').catch(() => null);
  const version = Number(cur?.text.match(/tokentracker workflow v(\d+)/)?.[1] || 0);
  if (cur && version >= WORKFLOW_VERSION) return false;
  await putFile(token, owner, repo, '.github/workflows/tokentracker.yml', WORKFLOW, `tokentracker: workflow v${WORKFLOW_VERSION}`);
  return true;
}

// ─── writing a machine's rows ─────────────────────────────────────────────────

const key = (r) => `${r.date}\u0000${r.source}\u0000${r.model}`;
const NUM = ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'messages'];
const clean = (r) => ({ date: r.date, source: r.source, model: r.model, ...Object.fromEntries(NUM.map((n) => [n, r[n] || 0])) });
const sortRows = (rows) => rows.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

/**
 * Merge what this machine sees now into what is stored. Local logs win for
 * any day they still cover (per tool), so a day's numbers can grow; days the
 * logs no longer cover (pruned by the tool) keep their stored values forever.
 */
export function mergeRows(stored, local) {
  const oldest = {};
  for (const r of local) if (!oldest[r.source] || r.date < oldest[r.source]) oldest[r.source] = r.date;
  const out = new Map();
  for (const r of stored) {
    const coveredLocally = oldest[r.source] && r.date >= oldest[r.source];
    if (!coveredLocally) out.set(key(r), clean(r));
  }
  for (const r of local) out.set(key(r), clean(r));
  return sortRows([...out.values()]);
}

/**
 * Save this machine's rows into machines/<id>/<year>.json, one file per year
 * touched. Unchanged years make no commit, except a once-a-day heartbeat
 * (`syncedOn`) on the current year so an idle machine isn't mistaken for a broken one.
 */
export async function uploadMachine(token, { owner, repo = DATA_REPO, machineId, device, rows }) {
  const byYear = new Map();
  for (const r of rows) {
    const y = r.date.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(r);
  }
  const thisYear = today().slice(0, 4);
  if (!byYear.has(thisYear)) byYear.set(thisYear, []);

  let changed = false;
  let total = 0;
  for (const [year, local] of [...byYear.entries()].sort()) {
    const file = `machines/${machineId}/${year}.json`;
    let count = 0;
    const res = await putFile(token, owner, repo, file, null, `tokentracker: ${device} ${year}`, {
      merge: (cur) => {
        // Every machine file for that year written by any tokentracker version
        const merged = mergeRows(cur?.rows || [], local);
        count = merged.length;
        const sameRows = cur && JSON.stringify(cur.rows) === JSON.stringify(merged);
        const heartbeat = year === thisYear && cur?.syncedOn !== today();
        if (sameRows && cur.device === device && !heartbeat) return null;
        if (!merged.length && !cur && year !== thisYear) return null;
        return `${JSON.stringify({
          format: FORMAT,
          machine: machineId,
          device,
          year: Number(year),
          syncedOn: year === thisYear ? today() : (cur?.syncedOn || today()),
          updatedAt: sameRows ? cur.updatedAt : new Date().toISOString(),
          rows: merged,
        })}\n`;
      },
    });
    total += count;
    changed ||= res.changed;
  }
  return { rows: total, changed };
}

// ─── reading a checkout (runs inside the data repo's Action) ─────────────────

/**
 * Read every machine file in a checkout, any format version, any layout this
 * project has used. Returns [{ id, device, syncedOn, updatedAt, rows }].
 */
export function readMachines(repoDir) {
  const dir = path.join(repoDir, 'machines');
  if (!fs.existsSync(dir)) return [];
  const byId = new Map();
  const add = (id, m) => {
    const cur = byId.get(id) || { id, device: id, syncedOn: null, updatedAt: null, rows: [] };
    if (m.rows) cur.rows.push(...m.rows);
    const newer = (m.syncedOn || m.updatedAt || '') >= (cur.syncedOn || cur.updatedAt || '');
    if (m.device && newer) cur.device = m.device;
    if (m.syncedOn && (!cur.syncedOn || m.syncedOn > cur.syncedOn)) cur.syncedOn = m.syncedOn;
    if (m.updatedAt && (!cur.updatedAt || m.updatedAt > cur.updatedAt)) cur.updatedAt = m.updatedAt;
    byId.set(id, cur);
  };
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const f of fs.readdirSync(full).filter((x) => x.endsWith('.json'))) add(entry.name, JSON.parse(fs.readFileSync(path.join(full, f), 'utf8')));
    } else if (entry.name.endsWith('.json')) {
      // 0.2.0 layout: one file per machine (machines/<id>.json), no format field
      add(entry.name.replace(/\.json$/, ''), JSON.parse(fs.readFileSync(full, 'utf8')));
    }
  }
  return [...byId.values()].map((m) => ({ ...m, rows: mergeRows([], m.rows) })).sort((a, b) => (a.id < b.id ? -1 : 1));
}

// ─── build ────────────────────────────────────────────────────────────────────

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

const PAGE = (owner, repo) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>@${esc(owner)} · tokentracker</title>
<style>body{margin:0;padding:48px 24px;background:#121317;color:#ecece8;font:14px/1.6 ui-monospace,Menlo,monospace}
main{max-width:640px;margin:0 auto}a{color:#6b9eff}h1{font-size:20px}b{color:#f0c463}</style>
</head><body><main><h1><b>●</b> @${esc(owner)}'s AI token usage</h1>
<p id="total">Loading…</p>
<p>Profile: <a href="https://tokentracker.patrickbrown.dev/u/${esc(owner)}">tokentracker.patrickbrown.dev/u/${esc(owner)}</a> ·
data: <a href="https://github.com/${esc(owner)}/${esc(repo)}">${esc(owner)}/${esc(repo)}</a></p>
<ul>${['index', 'stats', 'usage', '30d/usage', 'usage-month', 'models', 'tools', 'heatmap', 'devices', 'profile'].map((p) => `<li><a href="api/v1/${p}.json">api/v1/${p}.json</a></li>`).join('')}</ul>
<script>fetch('api/v1/stats.json').then(r=>r.json()).then(s=>{document.getElementById('total').textContent=s.tokens.toLocaleString()+' tokens across '+s.activeDays+' active days'})</script>
</main></body></html>
`;

function readSettings(repoDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoDir, 'tokentracker.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** Read a data repo checkout and write the static API into outDir. */
export async function buildSite({
  repoDir,
  outDir,
  owner = process.env.GITHUB_REPOSITORY_OWNER,
  repo = (process.env.GITHUB_REPOSITORY || '').split('/')[1] || DATA_REPO,
  cursor = fetchCursorDaily,
  log = () => {},
}) {
  const settings = readSettings(repoDir);
  const handle = (owner || 'me').toLowerCase();
  const found = readMachines(repoDir);
  // Two computers with the same display name stay distinct machines
  const names = new Map();
  const machines = found.map((m) => {
    const device = names.has(m.device) ? `${m.device}-${m.id.slice(0, 6)}` : m.device;
    names.set(m.device, true);
    // "last sync" is the later of the last change and the daily heartbeat
    const beat = m.syncedOn ? `${m.syncedOn}T00:00:00Z` : null;
    const lastSync = [m.updatedAt, beat].filter(Boolean).sort().at(-1) || null;
    return { device, updatedAt: lastSync, syncedOn: m.syncedOn, rows: toQueryRows(m.rows, device) };
  });
  let rows = machines.flatMap((m) => m.rows);
  if (settings.cursorHandle) {
    try {
      const daily = await cursor(settings.cursorHandle);
      const cursorRows = toQueryRows(daily.filter((d) => d.count > 0).map((d) => ({ date: d.date, source: 'cursor', model: 'cursor/all', input: d.count })), 'cursor.com');
      rows = rows.concat(cursorRows);
      log(`cursor: ${cursorRows.length} days`);
    } catch (err) {
      log(`cursor skipped: ${err.message}`);
    }
  }
  const base = owner ? pagesUrl(owner, repo) : '';
  const files = buildStaticApi({ handle, rows, machines, baseUrl: base });
  fs.rmSync(outDir, { recursive: true, force: true });
  for (const [p, body] of Object.entries(files)) {
    const dest = path.join(outDir, p);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, `${JSON.stringify(body)}\n`);
  }
  fs.writeFileSync(path.join(outDir, 'index.html'), PAGE(handle, repo));
  fs.writeFileSync(path.join(outDir, 'llms.txt'), AGENTS_DOC(owner || handle, repo));
  fs.writeFileSync(path.join(outDir, '.nojekyll'), '');
  log(`built ${Object.keys(files).length} files from ${machines.length} machine(s), ${rows.length} rows`);
  return { files: Object.keys(files).length, machines: machines.length, rows: rows.length };
}

// ─── check: "machine stopped syncing" issues ──────────────────────────────────

/**
 * Machines whose last sync is 3-30 days old get one open issue each (GitHub
 * emails the owner); the issue closes itself once the machine syncs again.
 * Runs in the data repo's Action with its GITHUB_TOKEN.
 */
export async function checkMachines({ repoDir, token = process.env.GITHUB_TOKEN, repository = process.env.GITHUB_REPOSITORY, now = new Date(), log = () => {} }) {
  const daysSince = (d) => Math.floor((now - new Date(`${d}T00:00:00Z`)) / 864e5);
  const machines = readMachines(repoDir).map((m) => ({ ...m, last: m.syncedOn || m.updatedAt?.slice(0, 10) || null }));
  const stale = machines.filter((m) => m.last && daysSince(m.last) >= STALE_DAYS && daysSince(m.last) <= RETIRED_DAYS);
  if (!token || !repository) {
    log(`stale machines: ${stale.map((m) => m.device).join(', ') || 'none'} (no GITHUB_TOKEN, not opening issues)`);
    return { stale: stale.map((m) => m.device), opened: [], closed: [] };
  }
  const marker = (id) => `<!-- tokentracker-stale:${id} -->`;
  const open = await gh(token, 'GET', `/repos/${repository}/issues?state=open&labels=tokentracker&per_page=100`);
  const issues = open.ok ? open.json : [];
  const opened = [];
  const closed = [];
  for (const m of stale) {
    if (issues.some((i) => i.body?.includes(marker(m.id)))) continue;
    const r = await gh(token, 'POST', `/repos/${repository}/issues`, {
      title: `${m.device} stopped syncing`,
      labels: ['tokentracker'],
      body: `${marker(m.id)}\n**${m.device}** hasn't saved token usage since **${m.last}** (${daysSince(m.last)} days).\n\nUsually Node.js was updated or removed, or the background job was turned off. On that computer, run:\n\n\`\`\`sh\nnpx @bicrick/tokentracker@latest init\n\`\`\`\n\nIt recognises the computer and carries on; nothing is counted twice. Not using it any more? Close this issue; after ${RETIRED_DAYS} days quiet it stops being checked.\n\n_This issue closes itself when the machine syncs again._`,
    });
    if (r.ok) opened.push(m.device);
  }
  for (const i of issues) {
    const id = i.body?.match(/tokentracker-stale:([^ ]+) -->/)?.[1];
    const m = machines.find((x) => x.id === id);
    if (m && m.last && daysSince(m.last) < STALE_DAYS) {
      await gh(token, 'POST', `/repos/${repository}/issues/${i.number}/comments`, { body: `Back: ${m.device} synced on ${m.last}.` });
      await gh(token, 'PATCH', `/repos/${repository}/issues/${i.number}`, { state: 'closed', state_reason: 'completed' });
      closed.push(m.device);
    }
  }
  log(`stale: ${stale.map((m) => m.device).join(', ') || 'none'} · opened ${opened.length} · closed ${closed.length}`);
  return { stale: stale.map((m) => m.device), opened, closed };
}

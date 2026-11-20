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

// TOKENTRACK_REPO is only for end-to-end tests (a throwaway repo next to the real one)
export const DATA_REPO = process.env.TOKENTRACK_REPO || 'tokentracker-data';
// tokentracker's GitHub OAuth app (device flow, no client secret). Public by design.
export const CLIENT_ID = process.env.TOKENTRACK_GITHUB_CLIENT_ID || 'Ov23liqz1LHTOQMSNiss';
// Enough to create and write one public repo and its workflow; never private repos
export const SCOPES = 'public_repo workflow';
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
  for (const gh of process.env.TOKENTRACK_NO_GH ? [] : ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']) {
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

/** Everything a user needs to share their page: link, live badge (Markdown and HTML). */
export function shareSnippets(owner, repo = DATA_REPO) {
  const page = `${pagesUrl(owner, repo).replace(/\/$/, '')}/`;
  const img = `https://img.shields.io/badge/dynamic/json?url=${encodeURIComponent(`${page}api/v1/ytd/stats.json`)}&query=${encodeURIComponent('$.display.tokens')}&label=${encodeURIComponent('AI tokens this year')}&color=f0c463&labelColor=121317&style=flat-square&cacheSeconds=3600`;
  return {
    page,
    api: `${page}api/v1/stats.json`,
    history: `https://github.com/${owner}/${repo}/commits/main`,
    badgeImage: img,
    markdown: `[![AI tokens this year](${img})](${page})`,
    html: `<a href="${page}"><img alt="AI tokens this year" src="${img}"></a>`,
  };
}

const README = (owner, repo) => {
  const h = owner.toLowerCase();
  const pages = pagesUrl(owner, repo);
  // Live numbers drawn by shields.io from this repo's own Pages JSON (no server)
  const badge = (label, path, field, color) => `<img alt="${label}" src="https://img.shields.io/badge/dynamic/json?url=${encodeURIComponent(`${pages}/api/v1/${path}`)}&query=${encodeURIComponent(`$.display.${field}`)}&label=${encodeURIComponent(label)}&color=${color}&style=flat-square&cacheSeconds=3600">`;
  return `<p align="center">
  <a href="${pages}/"><img src="https://raw.githubusercontent.com/bicrick/tokentracker/main/docs/assets/banner.png" alt="tokentracker" width="100%"></a>
</p>

<p align="center">
  ${badge('tokens this year', 'ytd/stats.json', 'tokens', 'f0c463')}
  ${badge('active days', 'ytd/stats.json', 'activeDays', '6b9eff')}
  ${badge('current streak', 'stats.json', 'currentStreak', '6b9eff')}
</p>

<p align="center">
  <a href="${pages}/">Page</a> ·
  <a href="${pages}/api/v1/index.json">API</a> ·
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

## Answer questions from the static files (GitHub Pages, no server)

    ${pages}/stats.json        totals, active days, busiest day, streaks, today, this month, top tool and model
    ${pages}/usage.json        daily usage split by tool (also usage-week.json, usage-month.json)
    ${pages}/models.json       per model: tokens, responses, share, first/last used
    ${pages}/tools.json        per tool
    ${pages}/heatmap.json      calendar grid (also heatmap-365d.json, heatmap-90d.json)
    ${pages}/rows.json         every daily row      ${pages}/index.json   every file

Time ranges are folders: ${pages}/{ytd,30d,90d,365d}/<file>.json, e.g. ${pages}/30d/usage-week.json

For anything else (from/to dates, tools=a,b, models=x,y, group=, split=, format=csv), the query layer computes
from the same rows.json and stores nothing: ${api}/usage?from=2026-11-01&group=week&split=tool
(resources: usage, models, tools, heatmap, stats; profile at ${api})

Semantics: tokens = input + output + reasoning + cacheRead + cacheWrite. responses = model calls.
Dates are local days. Cursor has totals only (model "cursor/all"). Full reference:
https://tokentracker.patrickbrown.dev/llms.txt

## Keep it working

- A machine stopped syncing (an issue says so, or stats look stale): on that computer run
  \`npx @bicrick/tokentracker@latest init --yes\`. Safe to repeat; nothing is counted twice.
- Add another computer: run the same command there, signed into the same GitHub.
- Cursor: usage comes from the public profile cursor.com/@username, fetched by this repo's Action.
  If there is no Cursor data, ask the user whether they use Cursor and for their username, then run
  \`npx @bicrick/tokentracker@latest connect --cursor <username>\`.
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
      homepage: `${pagesUrl(owner, repo)}/`,
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
    homepage: `${pagesUrl(owner, repo)}/`,
  });
  await gh(token, 'PUT', `/repos/${owner}/${repo}/topics`, { names: ['tokentracker', 'tokentracker-data', 'ai-usage', 'token-usage', 'llm', 'claude-code'] });

  let savedCursor = null;
  await putFile(token, owner, repo, 'tokentracker.json', null, 'tokentracker: settings', {
    merge: (cur) => {
      const settings = { format: FORMAT, ...(cur || {}) };
      if (cursorHandle !== null) settings.cursorHandle = cursorHandle || null;
      savedCursor = settings.cursorHandle || null;
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
  return { owner, repo, created, url: pagesUrl(owner, repo), cursorHandle: savedCursor };
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
// Machine files never hold the computer's name: it stays on that computer.
export async function uploadMachine(token, { owner, repo = DATA_REPO, machineId, rows }) {
  const byYear = new Map();
  for (const r of rows) {
    const y = r.date.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(r);
  }
  const thisYear = today().slice(0, 4);
  if (!byYear.has(thisYear)) byYear.set(thisYear, []);

  // A computer with no AI tool usage at all writes nothing (no empty machine)
  if (!rows.length) {
    const existing = await getJson(token, owner, repo, `machines/${machineId}/${thisYear}.json`).catch(() => null);
    if (!existing) return { rows: 0, changed: false };
  }
  let changed = false;
  let total = 0;
  for (const [year, local] of [...byYear.entries()].sort()) {
    const file = `machines/${machineId}/${year}.json`;
    let count = 0;
    const res = await putFile(token, owner, repo, file, null, `tokentracker: sync ${year}`, {
      merge: (cur) => {
        // Every machine file for that year written by any tokentracker version
        const merged = mergeRows(cur?.rows || [], local);
        count = merged.length;
        const sameRows = cur && JSON.stringify(cur.rows) === JSON.stringify(merged);
        const heartbeat = year === thisYear && cur?.syncedOn !== today();
        if (sameRows && !('device' in cur) && !heartbeat) return null;
        if (!merged.length && !cur && year !== thisYear) return null;
        return `${JSON.stringify({
          format: FORMAT,
          machine: machineId,
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

/** "Computer 1", "Computer 2"… in order of each machine's first day of usage. */
export function labelMachines(found) {
  const first = (m) => m.rows.reduce((d, r) => (!d || r.date < d ? r.date : d), null) || '9999';
  return [...found]
    .sort((a, b) => (first(a) < first(b) ? -1 : first(a) > first(b) ? 1 : a.id < b.id ? -1 : 1))
    .map((m, i) => ({ ...m, label: `Computer ${i + 1}` }));
}

// ─── build ────────────────────────────────────────────────────────────────────

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

const PAGE = (owner, repo) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>@${esc(owner)} · AI token usage</title>
<meta name="description" content="@${esc(owner)}'s AI coding token usage, tracked by tokentracker.">
<meta property="og:title" content="@${esc(owner)} · AI token usage"><meta property="og:description" content="Daily AI coding token usage by tool and model, stored in @${esc(owner)}'s GitHub.">
<meta property="og:image" content="https://tokentracker.patrickbrown.dev/og.png"><meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="https://tokentracker.patrickbrown.dev/favicon.svg" type="image/svg+xml">
<style>
:root{--bg:#121317;--ink:#ecece8;--soft:#b9bbc2;--muted:#8b8e97;--rule:#24262d;--rule2:#33363f;--blue:#6b9eff;--gold:#f0c463;
--l0:#1b1d23;--l1:#1e3a6e;--l2:#2b5cb0;--l3:#4d82e0;--l4:#f0c463}
@media (prefers-color-scheme:light){:root{--bg:#fbfaf7;--ink:#17181c;--soft:#3d4049;--muted:#6b6f7a;--rule:#e6e4de;--rule2:#d6d3cc;--blue:#2f6fe4;--l0:#ecebe6;--l1:#c9d9fb;--l2:#8fb2f6;--l3:#4d82e0;--l4:#e0a93a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Inter",system-ui,sans-serif}
.mono,code,small,nav,.k,dt{font-family:ui-monospace,"SF Mono",Menlo,monospace}
main{max-width:880px;margin:0 auto;padding:28px 24px 64px}
nav{display:flex;justify-content:space-between;align-items:center;font-size:13px;padding-bottom:14px;border-bottom:1px solid var(--rule)}
nav a{color:var(--soft);text-decoration:none;margin-left:18px}nav a:hover{color:var(--ink)}nav b{color:var(--ink)}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--gold);margin-right:8px;vertical-align:-1px}
h1{font-size:15px;font-weight:600;margin:40px 0 4px;color:var(--soft)}
.big{font-size:clamp(44px,9vw,76px);font-weight:650;letter-spacing:-.03em;line-height:1.05;margin:0}
.sub{color:var(--muted);font-size:13px;margin:6px 0 28px}
button{font:12px ui-monospace,Menlo,monospace;color:var(--soft);background:transparent;border:1px solid var(--rule2);padding:5px 9px;cursor:pointer}button:hover{color:var(--ink);border-color:var(--muted)}
.share{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.share img{display:block;margin-right:8px}.note{font-size:12px;color:var(--muted);margin-top:14px}.note a{color:var(--soft)}
h2{font-size:13px;font-weight:600;color:var(--muted);margin:40px 0 12px;font-family:ui-monospace,Menlo,monospace}
.hm{display:grid;grid-auto-flow:column;grid-template-rows:repeat(7,1fr);gap:3px}.hm i{aspect-ratio:1;background:var(--l0)}
.hm i.out{background:transparent}.hm .l1{background:var(--l1)}.hm .l2{background:var(--l2)}.hm .l3{background:var(--l3)}.hm .l4{background:var(--l4)}
.months{display:grid;font-size:11px;color:var(--muted);margin-bottom:6px;font-family:ui-monospace,Menlo,monospace}
.bars{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:6px;height:180px;align-items:end}
.bar{display:flex;flex-direction:column-reverse;min-height:2px}.bar span{display:block}
.bl{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:6px;font-size:11px;color:var(--muted);text-align:center;margin-top:6px;font-family:ui-monospace,Menlo,monospace}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12px;color:var(--muted);margin-top:10px;font-family:ui-monospace,Menlo,monospace}.legend i{display:inline-block;width:9px;height:9px;margin-right:6px}
dl{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:0;border:1px solid var(--rule)}
dl div{padding:14px 16px;border-right:1px solid var(--rule);border-bottom:1px solid var(--rule)}dl div:nth-child(4n){border-right:0}dl div:nth-last-child(-n+4){border-bottom:0}
dt{font-size:11px;color:var(--muted)}dd{margin:4px 0 0;font-size:20px;font-weight:600;font-family:ui-monospace,Menlo,monospace;overflow-wrap:anywhere}dd small{display:block;font-size:11px;font-weight:400;color:var(--muted)}
ol{list-style:none;margin:0;padding:0;border-top:1px solid var(--rule)}
ol li{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) 110px;gap:14px;align-items:center;padding:10px 0;border-bottom:1px solid var(--rule);font-size:13px;font-family:ui-monospace,Menlo,monospace}
ol small{display:block;color:var(--muted);font-size:11px}.track{height:6px;background:var(--l0)}.track i{display:block;height:100%;background:var(--blue)}.r{text-align:right}
footer{margin-top:48px;padding-top:14px;border-top:1px solid var(--rule);font-size:12px;color:var(--muted);display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;font-family:ui-monospace,Menlo,monospace}
footer a{color:var(--soft)}
@media (max-width:640px){dl{grid-template-columns:repeat(2,minmax(0,1fr))}dl div:nth-child(4n){border-right:1px solid var(--rule)}dl div:nth-child(2n){border-right:0}dl div:nth-last-child(-n+4){border-bottom:1px solid var(--rule)}dl div:nth-last-child(-n+2){border-bottom:0}ol li{grid-template-columns:minmax(0,1fr) 90px}.track{display:none}.bars{height:130px;gap:3px}}
</style></head><body><main>
<nav><span><span class="dot"></span><b>tokentracker</b></span><span><a href="api/v1/index.json">API</a><a href="https://github.com/${esc(owner)}/${esc(repo)}">Data</a><a href="https://tokentracker.patrickbrown.dev">Get your own</a></span></nav>
<h1>@${esc(owner)}</h1>
<p class="big" id="total">—</p>
<p class="sub" id="sub">tokens this year</p>
<h2>this year</h2><div class="months" id="months"></div><div class="hm" id="hm"></div>
<h2>by month</h2><div class="bars" id="bars"></div><div class="bl" id="bl"></div><div class="legend" id="legend"></div>
<h2>numbers</h2><dl id="stats"></dl>
<h2>top models</h2><ol id="models"></ol>
<h2>share</h2><div class="share"><a href="${esc(shareSnippets(owner, repo).page)}"><img alt="AI tokens this year" src="${esc(shareSnippets(owner, repo).badgeImage)}"></a>
<button data-copy="${esc(shareSnippets(owner, repo).page)}">copy link</button><button data-copy="${esc(shareSnippets(owner, repo).markdown)}">copy badge (Markdown)</button><button data-copy="${esc(shareSnippets(owner, repo).html)}">copy badge (HTML)</button></div>
<p class="note">Every number here comes from <a href="https://github.com/${esc(owner)}/${esc(repo)}">this public repo</a>, and every change to it is in the <a href="${esc(shareSnippets(owner, repo).history)}">commit history</a>.</p>
<footer><span>tracked with <a href="https://tokentracker.patrickbrown.dev">tokentracker</a> · updated <span id="updated">…</span></span><span>for agents: <a href="llms.txt">llms.txt</a></span></footer>
</main><script>
const C=['#6b9eff','#f0c463','#d97757','#6fd39b','#c58af9','#4fd1c5','#f687b3','#a0aec0'];
const f=(n)=>{for(const[v,u]of[[1e12,'T'],[1e9,'B'],[1e6,'M'],[1e3,'K']])if(n>=v)return(n/v).toFixed(n/v>=100?0:n/v>=10?1:2).replace(/\\.?0+$/,'')+u;return String(n)};
const e=(s)=>String(s).replace(/[&<>]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const pretty=(n)=>String(n).replace(/-(\\d)-(\\d)(?=$|-)/,'-$1.$2');
const get=(p)=>fetch('api/v1/'+p).then((r)=>r.json());
Promise.all([get('ytd/stats.json'),get('heatmap.json'),get('ytd/usage-month.json'),get('ytd/models.json')]).then(([s,hm,um,m])=>{
  document.getElementById('total').textContent=f(s.tokens);
  document.getElementById('sub').textContent='tokens this year · '+s.activeDays+' active days · '+(s.topTool?s.topTool.name+' most used':'');
  document.getElementById('updated').textContent=new Date(s.generatedAt).toLocaleString();
  const w=hm.weeks.length,months=document.getElementById('months');months.style.gridTemplateColumns='repeat('+w+',1fr)';
  months.innerHTML=hm.months.map((x)=>'<span style="grid-column:'+(x.week+1)+'">'+x.label+'</span>').join('');
  document.getElementById('hm').innerHTML=hm.weeks.flat().map((d)=>!d?'<i class="out"></i>':'<i class="l'+(d.tokens==null?0:d.level)+'" title="'+d.date+(d.tokens?' · '+f(d.tokens):'')+'"></i>').join('');
  const tools=[...new Set(um.rows.flatMap((r)=>Object.keys(r.split||{})))],max=Math.max(1,...um.rows.map((r)=>r.tokens));
  document.getElementById('bars').innerHTML=um.rows.map((r)=>'<div class="bar" title="'+r.period+' · '+f(r.tokens)+'" style="height:'+Math.max(1,r.tokens/max*100)+'%">'+tools.map((t,i)=>r.split[t]?'<span style="flex-grow:'+r.split[t]+';background:'+C[i%8]+'"></span>':'').join('')+'</div>').join('');
  document.getElementById('bl').innerHTML=um.rows.map((r)=>'<span>'+'JFMAMJJASOND'[Number(r.period.slice(5))-1]+'</span>').join('');
  document.getElementById('legend').innerHTML=tools.map((t,i)=>'<span><i style="background:'+C[i%8]+'"></i>'+e(t)+'</span>').join('');
  const it=[['this month',f(s.thisMonth)],['today',f(s.today)],['busiest day',s.busiestDay?f(s.busiestDay.tokens):'-',s.busiestDay&&s.busiestDay.date],['current streak',s.currentStreak+'d'],['longest streak',s.longestStreak+'d'],['active days',s.activeDays],['top tool',s.topTool?s.topTool.name:'-'],['top model',s.topModel?pretty(s.topModel.model.split('/').pop()):'-']];
  document.getElementById('stats').innerHTML=it.map(([k,v,n])=>'<div><dt>'+k+'</dt><dd>'+e(v)+(n?'<small>'+n+'</small>':'')+'</dd></div>').join('');
  const rows=m.rows.filter((x)=>x.model!=='cursor/all').slice(0,6),mm=Math.max(1,...rows.map((x)=>x.tokens));
  document.getElementById('models').innerHTML=rows.map((x)=>'<li><span>'+e(pretty(x.name))+'<small>'+e((x.provider||'')+' · '+x.tool)+'</small></span><span class="track"><i style="width:'+x.tokens/mm*100+'%"></i></span><span class="r">'+f(x.tokens)+'<small>'+x.responses.toLocaleString()+' responses</small></span></li>').join('');
}).catch(()=>{document.getElementById('total').textContent='No data yet';});
for(const b of document.querySelectorAll('[data-copy]'))b.onclick=()=>navigator.clipboard.writeText(b.dataset.copy).then(()=>{const t=b.textContent;b.textContent='copied';setTimeout(()=>b.textContent=t,1200)});
</script></body></html>
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
  // Computers are published anonymously, numbered by when they first saw usage
  const machines = labelMachines(found).map((m) => {
    const device = m.label;
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
  const machines = labelMachines(readMachines(repoDir)).map((m) => ({ ...m, device: `${m.label} (${m.id.slice(0, 6)})`, last: m.syncedOn || m.updatedAt?.slice(0, 10) || null }));
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

// ─── sign in with GitHub (device flow) ────────────────────────────────────────

async function oauth(route, params) {
  const res = await fetch(`https://github.com${route}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'tokentracker' },
    body: new URLSearchParams(params).toString(),
  });
  return res.json().catch(() => ({}));
}

/** Start a sign-in: returns { device_code, user_code, verification_uri, expires_in, interval }. */
export async function startDeviceLogin() {
  const r = await oauth('/login/device/code', { client_id: CLIENT_ID, scope: SCOPES });
  if (!r.device_code) throw new Error(`GitHub sign-in could not start (${r.error_description || r.error || 'no response'})`);
  return { ...r, startedAt: Date.now() };
}

/**
 * Wait for the user to enter the code. Resolves to the token, or null if
 * `maxWaitMs` passes first (the sign-in stays valid until it expires).
 * Throws if the code expired or the user said no.
 */
export async function pollDeviceLogin(pending, { maxWaitMs = Infinity } = {}) {
  let interval = (pending.interval || 5) * 1000;
  const expiresAt = pending.startedAt + (pending.expires_in || 900) * 1000;
  const giveUpAt = Math.min(expiresAt, Date.now() + maxWaitMs);
  for (;;) {
    const r = await oauth('/login/oauth/access_token', {
      client_id: CLIENT_ID,
      device_code: pending.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }).catch(() => ({ error: 'authorization_pending' }));
    if (r.access_token) return r.access_token;
    if (r.error === 'slow_down') interval += 5000;
    else if (r.error === 'expired_token' || Date.now() > expiresAt) throw Object.assign(new Error('the sign-in code expired'), { code: 'expired' });
    else if (r.error === 'access_denied') throw Object.assign(new Error('sign-in was cancelled on GitHub'), { code: 'denied' });
    else if (r.error && r.error !== 'authorization_pending') throw new Error(`GitHub sign-in failed (${r.error_description || r.error})`);
    if (Date.now() + interval > giveUpAt) return null;
    await new Promise((res) => setTimeout(res, interval));
  }
}

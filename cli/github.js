// "Store in my GitHub": each user's usage lives in their own repo
// (<owner>/tokentracker-data). Every machine writes machines/<id>.json; a
// GitHub Action in that repo runs `tokentrack build` and publishes the static
// API to GitHub Pages. No tokentracker account or server involved.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fetchCursorDaily } from './core/cursor-profile.js';
import { buildStaticApi, toQueryRows } from './core/site.js';

export const DATA_REPO = 'tokentracker-data';
const API = 'https://api.github.com';

/** A GitHub token: env, then the GitHub CLI's login. Never stored by us. */
export function githubToken() {
  if (process.env.TOKENTRACK_GITHUB_TOKEN) return process.env.TOKENTRACK_GITHUB_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  for (const gh of ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']) {
    try {
      const t = execFileSync(gh, ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim();
      if (t) return t;
    } catch {}
  }
  return null;
}

async function gh(token, method, route, body) {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'tokentracker',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = res.status === 204 ? {} : await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

export async function githubUser(token) {
  const r = await gh(token, 'GET', '/user');
  if (!r.ok) throw new Error(r.status === 401 ? 'GitHub rejected the token' : `GitHub /user failed (${r.status})`);
  return r.json.login;
}

/** Create or update one file; skips the commit when the content is unchanged. */
export async function putFile(token, owner, repo, file, content, message) {
  const route = `/repos/${owner}/${repo}/contents/${file.split('/').map(encodeURIComponent).join('/')}`;
  const cur = await gh(token, 'GET', route);
  const b64 = Buffer.from(content).toString('base64');
  if (cur.ok && cur.json.content && cur.json.content.replace(/\n/g, '') === b64) return { changed: false };
  const r = await gh(token, 'PUT', route, { message, content: b64, ...(cur.ok ? { sha: cur.json.sha } : {}) });
  if (!r.ok) throw new Error(`could not write ${file} (${r.status}${r.json.message ? `: ${r.json.message}` : ''})`);
  return { changed: true };
}

export const pagesUrl = (owner, repo = DATA_REPO) => `https://${owner.toLowerCase()}.github.io/${repo}`;

const WORKFLOW = `# Built by tokentracker. Turns machines/*.json into a static API on GitHub Pages.
name: tokentracker
on:
  push:
    paths: ['machines/**', 'tokentracker.json', '.github/workflows/tokentracker.yml']
  schedule:
    - cron: '23 */6 * * *' # refresh Cursor (fetched from its public profile) every 6 hours
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
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
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: _site
      - id: deploy
        uses: actions/deploy-pages@v4
`;

const README = (owner) => `# tokentracker data

My AI coding token usage, collected by [tokentracker](https://github.com/bicrick/tokentracker)
and stored here instead of on a tokentracker server.

- \`machines/*.json\`: daily token totals per tool and model, one file per computer (no prompts, code or keys)
- Every push rebuilds a static API on GitHub Pages: ${pagesUrl(owner)}/api/v1/

| | |
|---|---|
| Stats | ${pagesUrl(owner)}/api/v1/stats.json |
| Usage by day | ${pagesUrl(owner)}/api/v1/usage.json |
| Last 30 days | ${pagesUrl(owner)}/api/v1/30d/usage.json |
| Models | ${pagesUrl(owner)}/api/v1/models.json |
| Heatmap | ${pagesUrl(owner)}/api/v1/heatmap.json |
| Everything | ${pagesUrl(owner)}/api/v1/index.json |

Any filter (tools, models, from/to, CSV) works through the hosted bridge:
https://tokentracker.patrickbrown.dev/api/v1/github/${owner}/usage?range=30d&group=week
`;

/**
 * Create <owner>/tokentracker-data if needed, add the workflow, README and
 * settings file, and turn on Pages. Safe to run again.
 */
export async function ensureDataRepo(token, { cursorHandle = null } = {}) {
  const owner = await githubUser(token);
  const repo = DATA_REPO;
  let r = await gh(token, 'GET', `/repos/${owner}/${repo}`);
  let created = false;
  if (r.status === 404) {
    r = await gh(token, 'POST', '/user/repos', {
      name: repo,
      description: 'My AI coding token usage, as a static API (tokentracker)',
      private: false,
      auto_init: true,
      has_issues: false,
      has_wiki: false,
      has_projects: false,
      homepage: `${pagesUrl(owner)}/api/v1/`,
    });
    if (!r.ok) throw new Error(`could not create ${owner}/${repo} (${r.status}${r.json.message ? `: ${r.json.message}` : ''})`);
    created = true;
  } else if (!r.ok) {
    throw new Error(`could not read ${owner}/${repo} (${r.status})`);
  }

  const settingsRoute = `/repos/${owner}/${repo}/contents/tokentracker.json`;
  const existing = await gh(token, 'GET', settingsRoute);
  const settings = existing.ok ? JSON.parse(Buffer.from(existing.json.content, 'base64').toString('utf8')) : { version: 1 };
  if (cursorHandle !== null) settings.cursorHandle = cursorHandle || null;
  await putFile(token, owner, repo, 'tokentracker.json', `${JSON.stringify(settings, null, 2)}\n`, 'tokentracker: settings');
  await putFile(token, owner, repo, 'README.md', README(owner), 'tokentracker: readme');
  await putFile(token, owner, repo, '.github/workflows/tokentracker.yml', WORKFLOW, 'tokentracker: build workflow');

  // Pages built by Actions (409 = already on)
  const pages = await gh(token, 'POST', `/repos/${owner}/${repo}/pages`, { build_type: 'workflow' });
  if (!pages.ok && pages.status !== 409) throw new Error(`could not turn on GitHub Pages (${pages.status}${pages.json.message ? `: ${pages.json.message}` : ''})`);
  return { owner, repo, created, url: pagesUrl(owner, repo) };
}

/** Upload this machine's rows as machines/<machineId>.json. */
export async function uploadMachine(token, { owner, repo = DATA_REPO, machineId, device, sources, rows }) {
  const sorted = [...rows].sort((a, b) => (a.date + a.source + a.model < b.date + b.source + b.model ? -1 : 1));
  const file = `machines/${machineId}.json`;
  // updatedAt only moves when the numbers do, so unchanged hours make no commits
  const route = `/repos/${owner}/${repo}/contents/${file}`;
  const cur = await gh(token, 'GET', route);
  const prev = cur.ok ? JSON.parse(Buffer.from(cur.json.content, 'base64').toString('utf8')) : null;
  const same = prev && prev.device === device && JSON.stringify(prev.rows) === JSON.stringify(sorted);
  if (same) return { rows: sorted.length, changed: false };
  const body = { version: 1, device, updatedAt: new Date().toISOString(), sources, rows: sorted };
  await putFile(token, owner, repo, file, `${JSON.stringify(body)}\n`, `tokentracker: ${device}`);
  return { rows: sorted.length, changed: true };
}

// ─── build (runs inside the data repo's GitHub Action) ────────────────────────

const PAGE = (owner, base) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>@${owner} · tokentracker</title>
<style>body{margin:0;padding:48px 24px;background:#121317;color:#ecece8;font:14px/1.6 ui-monospace,Menlo,monospace}
main{max-width:640px;margin:0 auto}a{color:#6b9eff}h1{font-size:20px}b{color:#f0c463}code{background:#1c1e24;padding:2px 6px}</style>
</head><body><main><h1><b>●</b> @${owner}'s AI token usage</h1>
<p id="total">Loading…</p>
<p>A static API built by <a href="https://github.com/bicrick/tokentracker">tokentracker</a> from <a href="https://github.com/${owner}/${DATA_REPO}">${owner}/${DATA_REPO}</a>.</p>
<ul>${['stats', 'usage', '30d/usage', 'usage-month', 'models', 'tools', 'heatmap', 'devices', 'profile', 'index'].map((p) => `<li><a href="api/v1/${p}.json">api/v1/${p}.json</a></li>`).join('')}</ul>
<script>fetch('api/v1/stats.json').then(r=>r.json()).then(s=>{document.getElementById('total').textContent=s.tokens.toLocaleString()+' tokens across '+s.activeDays+' active days'})</script>
</main></body></html>
`;

/** Read a data repo checkout and write the static API into outDir. */
export async function buildSite({ repoDir, outDir, owner = process.env.GITHUB_REPOSITORY_OWNER, repo = (process.env.GITHUB_REPOSITORY || '').split('/')[1] || DATA_REPO, log = () => {} }) {
  const settings = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(repoDir, 'tokentracker.json'), 'utf8')); } catch { return {}; }
  })();
  const handle = (owner || settings.handle || 'me').toLowerCase();
  const dir = path.join(repoDir, 'machines');
  const machines = [];
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort() : []) {
    const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    // Two files claiming one name (e.g. a reinstall) stay distinct machines
    const device = machines.some((x) => x.device === m.device) ? `${m.device}-${f.replace(/\.json$/, "").slice(0, 6)}` : m.device;
    machines.push({ device, updatedAt: m.updatedAt, rows: toQueryRows(m.rows || [], device) });
  }
  let rows = machines.flatMap((m) => m.rows);
  if (settings.cursorHandle) {
    try {
      const daily = await fetchCursorDaily(settings.cursorHandle);
      const cursor = toQueryRows(daily.filter((d) => d.count > 0).map((d) => ({ date: d.date, source: 'cursor', model: 'cursor/all', input: d.count })), 'cursor.com');
      rows = rows.concat(cursor);
      log(`cursor: ${cursor.length} days`);
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
  fs.writeFileSync(path.join(outDir, 'index.html'), PAGE(handle, base));
  fs.writeFileSync(path.join(outDir, '.nojekyll'), '');
  log(`built ${Object.keys(files).length} files from ${machines.length} machine(s), ${rows.length} rows`);
  return { files: Object.keys(files).length, machines: machines.length, rows: rows.length };
}

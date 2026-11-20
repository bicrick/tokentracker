# tokentracker: guide for agents

tokentracker records a user's AI coding token usage (daily totals per tool and model, on every
machine) into a repo on their own GitHub, and serves it as a public, keyless HTTP API.
This file tells an agent how to install it, query it, and fix it. Humans: see README.md.

## Install for the user

Requirements: Node 22.13+ and a GitHub account. Nothing else to install.

GitHub sign-in: if the GitHub CLI is signed in, that login is used. Otherwise `init` signs in
by code: it prints `Open https://github.com/login/device and enter XXXX-XXXX`, saves the pending
sign-in and exits with status 2. **Show the user that link and code**, wait for them to approve,
then run the same `init` command again to finish. The sign-in only allows public repos and
workflows, does not expire, and is saved for the hourly sync. (`TOKENTRACK_GITHUB_TOKEN` also works.)

```sh
npx @bicrick/tokentracker init
```

**Ask the user first** (the CLI can't prompt when an agent runs it):

1. "Do you use Cursor? If so, what's your cursor.com username?" (Cursor usage comes from the
   public profile at cursor.com/@username; other tools are read from this computer.)
2. Optionally: "What should this computer be called?" (default: its hostname).

Then run it non-interactively. Without a terminal, `init` accepts every detected tool, names the
machine after its hostname, and skips Cursor unless given:

```sh
npx @bicrick/tokentracker@latest init --yes                 # defaults
npx @bicrick/tokentracker@latest init --yes --cursor <cursor-handle> --device <name>
```

What it does: scans local AI tool logs, creates (or reuses) a public repo
`github.com/<user>/tokentracker-data`, saves daily totals there, turns on GitHub Pages, and
installs an hourly per-user background job (launchd / systemd / Task Scheduler, no admin).
Running it again on the same computer is safe: the machine is recognised by a hashed hardware
id, so nothing is counted twice. On another computer, run the same command with the same GitHub login.

Connect or change Cursor later: `npx @bicrick/tokentracker@latest connect --cursor <username>`
(`connect --cursor` with no name disconnects it).

Verify: `npx @bicrick/tokentracker@latest status` (shows repo, last upload, version), then after
about a minute `curl https://<github-user>.github.io/tokentracker-data/api/v1/stats.json`.

## Read the data

The data is static JSON on the user's GitHub Pages; no tokentracker server is involved:

```
https://{handle}.github.io/tokentracker-data/api/v1/{stats|usage|usage-week|usage-month|models|tools|devices|heatmap|profile|rows|index}.json
https://{handle}.github.io/tokentracker-data/api/v1/{ytd|30d|90d|365d}/{stats|usage|usage-week|usage-month|models|tools|devices}.json
https://{handle}.github.io/tokentracker-data/api/v1/heatmap-{365d|90d}.json
https://{handle}.github.io/tokentracker-data/llms.txt             this user's own agent guide
```

`{handle}` is the user's GitHub username, lowercase. Rebuilt about a minute after each hourly sync; cached up to 10 minutes.
Field-by-field shapes: https://tokentracker.patrickbrown.dev/llms.txt

### Custom queries

For any other range, tool/model filter, grouping or CSV, the query layer computes from the same `rows.json`
(GET, no auth, CORS `*`, stores nothing):

| Endpoint | Returns |
|---|---|
| `/api/v1/users/{handle}` | profile and links |
| `/api/v1/users/{handle}/usage` | `group=day\|week\|month\|year\|total`, `split=tool\|model`, `fill=false` |
| `/api/v1/users/{handle}/models` | per model and tool |
| `/api/v1/users/{handle}/tools` | per tool |
| `/api/v1/users/{handle}/heatmap` | `range=year\|365d\|90d\|Nd\|YYYY`, `levels=2..10`, `weekStart=sun\|mon` |
| `/api/v1/users/{handle}/stats` | totals, streaks, busiest day, top tool and model |
| `/api/v1/users/{handle}/devices` | per machine, last sync |

Base `https://tokentracker.patrickbrown.dev`. Filters on all: `range=all|ytd|Nd|YYYY`, `from`, `to`, `tools=a,b`,
`models=x,y`; `format=csv` on usage, models, tools, devices. Errors: `{ "error": { "code", "message" } }`.

Semantics: `tokens = input + output + reasoning + cacheRead + cacheWrite` (input excludes cached input). `responses`
counts model calls. Dates are local calendar days. Cursor has totals only (model `cursor/all`).

## Data layout (in the user's repo)

```
tokentracker.json                  { "format": 1, "cursorHandle": "name" | null }
machines/<machine-id>/<year>.json  one file per computer per year (see FORMAT.md in the repo)
.github/workflows/tokentracker.yml rebuilds the static API, refreshes Cursor, flags quiet machines
```

Rows are `{ date, source, model, input, output, reasoning, cacheRead, cacheWrite, messages }`.
Writes merge and never delete, so history survives tools pruning their logs.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `status` shows "No upload since…" | run `npx @bicrick/tokentracker@latest init --yes` on that machine |
| `init` exited with status 2 and a code | show the user the link and code, then run `init` again |
| GitHub login expired or was revoked | run `init --yes` again to sign in by code |
| API returns `user_not_found` | the repo's first Action run hasn't finished; check `github.com/<user>/tokentracker-data/actions` |
| An issue "X stopped syncing" appeared in the data repo | run `init --yes` on machine X; the issue closes itself |
| Wrong or missing tool | `npx @bicrick/tokentracker connect`, or `connect --add <tool> <path>` |
| No Cursor data | ask for their cursor.com username, then `connect --cursor <username>` |
| See exactly what is saved | `npx @bicrick/tokentracker sync --dry` |

Logs: `~/Library/Logs/tokentrack.log` (macOS), `~/.local/state/tokentrack/sync.log` (Linux),
`%LOCALAPPDATA%\tokentrack\sync.log` (Windows). Config: `~/.config/tokentrack/config.json`.
Stop syncing: `npx @bicrick/tokentracker uninstall`. Delete everything: delete the data repo.

## Commands

`init`, `connect`, `sync [--dry]`, `status`, `install`, `uninstall`, and (run by the data repo's
Action) `build --repo . --out _site` and `check --repo .`.

## Working on this repo

- `cli/` is the npm package (zero dependencies). `cli/core/` holds the query logic shared by the CLI,
  the data repo's Action and the hosted API. `cli/sources/` has one collector per tool.
- `api/v1.js` is the only server code: stateless, reads users' `rows.json` from GitHub Pages.
- `public/` is the static website, docs, `llms.txt` and `openapi.json`.
- `npm test` runs everything; CI runs it on macOS, Linux and Windows with Node 22.13 and 24.
- Releases: bump `package.json`, then `gh release create vX.Y.Z` publishes to npm with provenance.
- Data compatibility is a promise: never remove fields or stop reading an old `format`.

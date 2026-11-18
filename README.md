# tokentracker

One heatmap for every AI token you spend, across every coding tool and every machine.

<p>
  <b>Cursor</b> · <b>Claude Code</b> · <b>OpenCode</b> (GitHub Copilot, Anthropic, OpenAI, OpenRouter, any provider)
</p>

Live example: [bicrick.com/tokens](https://bicrick.com/tokens)

---

## Why

Usage is scattered. Cursor has a profile page, Claude Code writes logs to disk, Copilot shows nothing per-token at all. tokentracker pulls all of it into one place you own, so you can see your real total and put it on your site.

## Privacy, up front

- The collector runs **on your machine** and reads local log files.
- It uploads **only daily token counts per tool and model**. Never prompts, code, file paths, or API keys.
- The server **rejects** any upload containing other fields.
- You can see the exact payload before anything is sent: `tokentrack sync --dry`.
- It's open source and self-hosted. Your data lives in your own database.

What gets uploaded, in full:

```json
{
  "device": "laptop",
  "sources": ["opencode", "claude-code"],
  "rows": [
    { "date": "2026-11-17", "source": "opencode", "model": "github-copilot/claude-opus-5.5",
      "input": 381, "output": 138, "reasoning": 63, "cacheRead": 8448, "cacheWrite": 0, "messages": 1 }
  ]
}
```

## Supported sources

| Source | How it's collected | Where from |
|---|---|---|
| **OpenCode** (incl. GitHub Copilot) | Local collector | `~/.local/share/opencode/opencode.db` |
| **Claude Code** | Local collector | `~/.claude/projects/**/*.jsonl` |
| **Cursor** | Server pulls your public profile | `cursor.com/@<handle>` |

Coming soon: Codex CLI, Gemini CLI, API usage via local admin keys.

---

## Getting started

Setup has two parts: a **server** (once) and the **collector** (on each machine you code on). About 10 minutes total.

### Part 1: Deploy your server (once)

You need a free [Vercel](https://vercel.com) account.

1. **Fork or import this repo into Vercel.**
   [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/bicrick/tokentracker&env=TOKENTRACK_INGEST_KEYS,TOKENTRACK_ACCOUNT,CURSOR_HANDLE,CRON_SECRET&envDescription=See%20.env.example&project-name=tokentracker&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%7D%5D)

2. **Add a database.** The button above provisions a free Neon Postgres database. If you imported manually: Project → Storage → Neon → Create, and connect it to the project.

3. **Set environment variables** (Project → Settings → Environment Variables):

   | Variable | Value |
   |---|---|
   | `TOKENTRACK_INGEST_KEYS` | One random key per device, comma-separated. Generate with `openssl rand -hex 24` |
   | `TOKENTRACK_ACCOUNT` | Your name or handle, e.g. `bicrick` |
   | `CURSOR_HANDLE` | Your Cursor profile handle (from `cursor.com/@handle`). Leave blank to skip Cursor |
   | `CRON_SECRET` | Any random string (`openssl rand -hex 24`) |

4. **Deploy**, then check it's alive:

   ```sh
   curl https://<your-project>.vercel.app/api/activity
   ```

   Tables are created automatically on the first request. If you set `CURSOR_HANDLE`, you'll already see Cursor data.

### Part 2: Install the collector (each machine)

Requires **Node 22.13+** (`node -v`). macOS is fully supported; Linux works with cron (see below).

```sh
git clone https://github.com/bicrick/tokentracker
cd tokentracker
npm link                # installs the `tokentrack` command
```

Connect it to your server, giving this machine a name:

```sh
tokentrack login \
  --server https://<your-project>.vercel.app \
  --key <one of your TOKENTRACK_INGEST_KEYS> \
  --device laptop
```

Preview what will be sent, then upload:

```sh
tokentrack sync --dry   # look before you leap
tokentrack sync         # first upload, includes all local history
```

Keep it syncing hourly in the background:

```sh
tokentrack install      # macOS launchd job, runs hourly and at login
tokentrack status       # shows config and the last sync log
```

That's it. Repeat Part 2 on every machine you code on. Use a different `--device` name for each. Totals across machines add up automatically.

**Linux:** instead of `tokentrack install`, add a cron entry:

```sh
(crontab -l; echo "0 * * * * $(which node) $(which tokentrack) sync >> ~/.tokentrack.log 2>&1") | crontab -
```

**Corporate network / TLS proxy?** If sync fails with `unable to get local issuer certificate`, run with `NODE_USE_SYSTEM_CA=1 tokentrack sync`. The hourly job sets this automatically.

### Part 3: Show it off

Fetch `/api/activity` from your site. `activityCounts` has the same shape as Cursor's profile data, so most heatmap components work as-is:

```js
const res = await fetch('https://<your-project>.vercel.app/api/activity');
const { activityCounts, totals, models } = await res.json();
// activityCounts: [{ date: "2026-11-17", count: 259485947, sources: { cursor: 3853940, opencode: 255632007 } }]
```

The endpoint allows cross-origin requests and is cached at the edge for 5 minutes.

---

## Commands

| Command | What it does |
|---|---|
| `tokentrack login --server <url> --key <key> [--device <name>]` | Save server, key and device name to `~/.config/tokentrack/config.json` |
| `tokentrack sync [--dry]` | Collect local usage and upload daily totals (`--dry` prints the payload instead) |
| `tokentrack install` | Run sync hourly in the background (macOS) |
| `tokentrack uninstall` | Stop the background sync |
| `tokentrack status` | Show config and recent sync logs |

## API

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/activity` | public | Daily totals by source, totals, per-model breakdown, devices and last sync times |
| `POST` | `/api/ingest` | device key | Upload daily aggregates |
| `GET` | `/api/cron/cursor` | `CRON_SECRET` | Refresh Cursor profile data (run by Vercel cron) |

## How it works

```
laptop ───────┐
work machine ─┼── tokentrack sync (hourly) ──▶ POST /api/ingest ──▶ Postgres ──▶ GET /api/activity
desktop ──────┘                                                        ▲
                                         cursor.com/@handle ── cron ───┘
```

Each sync re-reads the full local history and replaces that device's rows, so syncs are safe to repeat and never double count. Claude Code logs the same response several times while streaming; the collector dedupes by message and request ID.

## FAQ

**Do you need my API keys?** No. Nothing here reads, stores, or uploads API keys.

**What about Copilot in VS Code or JetBrains?** GitHub doesn't expose per-token usage for individuals. Copilot usage is tracked when it goes through OpenCode, which records tokens locally.

**Why is cache so much of my total?** Agents reread their context every turn, and providers count those reads as tokens. It's normal for 95%+ of agentic token usage to be cache reads.

**Can I delete my data?** It's your database. Drop the rows, or run `tokentrack uninstall` and remove the device's key.

## Roadmap

- Hosted service: sign up in the browser, connect devices with `tokentrack login` (no server to deploy)
- Public profile pages and an embeddable SVG heatmap
- Real-time updates via an OpenCode plugin and Claude Code OpenTelemetry export
- More sources: Codex CLI, Gemini CLI, Windsurf, API usage via local admin keys

## License

MIT

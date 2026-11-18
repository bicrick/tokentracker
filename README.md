<p align="center">
  <a href="https://tokentracker-nu.vercel.app"><img src="docs/assets/banner.png" alt="tokentracker: every AI token, every tool, every machine" width="100%"></a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-2563eb?style=flat-square"></a>
  <img alt="open source" src="https://img.shields.io/badge/open%20source-%E2%9C%93-2563eb?style=flat-square">
  <img alt="Node 22.13+" src="https://img.shields.io/badge/node-22.13%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white">
  <img alt="zero dependencies CLI" src="https://img.shields.io/badge/cli-zero%20dependencies-555?style=flat-square">
  <img alt="Vercel" src="https://img.shields.io/badge/Vercel-functions-000?style=flat-square&logo=vercel&logoColor=white">
  <img alt="Neon Postgres" src="https://img.shields.io/badge/Neon-Postgres-00E599?style=flat-square&logo=postgresql&logoColor=white">
  <img alt="macOS, Linux, Windows" src="https://img.shields.io/badge/macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-supported-555?style=flat-square">
</p>

<p align="center">
  <a href="https://tokentracker-nu.vercel.app">Website</a> ·
  <a href="https://tokentracker-nu.vercel.app/u/bicrick">Live example</a> ·
  <a href="#getting-started">Get started</a> ·
  <a href="#privacy">Privacy</a>
</p>

---

**tokentracker** adds up every AI token you spend across your coding tools and every computer you use, into one public profile and heatmap you can put on your site.

```sh
npx github:bicrick/tokentracker init
```

That one command finds the tools on your machine, shows you what it found, creates your free profile (or connects to your own server), uploads your history, and turns on an hourly background sync.

## Supported tools

| Tool | How | Read from |
|---|---|---|
| **Claude Code** | local | `~/.claude/projects` (also `~/.config/claude`, `$CLAUDE_CONFIG_DIR`) |
| **Codex** (CLI, IDE extension, app) | local | `~/.codex/sessions`, `archived_sessions` (`$CODEX_HOME`) |
| **OpenCode** (incl. GitHub Copilot, any provider) | local | `~/.local/share/opencode/opencode*.db` |
| **Gemini CLI** | local | `~/.gemini/tmp/*/chats` |
| **Copilot CLI** | local | `~/.copilot/session-state` |
| **Cline**, **Roo Code**, **Kilo Code** | local | extension storage in VS Code, Insiders, Cursor, Windsurf, VSCodium, Kiro |
| **Cursor** | server | your public `cursor.com/@handle` profile |

Tools are detected automatically on macOS, Linux and Windows. Planned next: Qwen Code, Factory Droid, Goose, Amp, Zed. See [docs/research/harnesses.md](docs/research/harnesses.md) for formats and paths of every tool we looked at.

## Getting started

Needs **Node 22.13+**.

```sh
npx github:bicrick/tokentracker init
```

```
╭──────────────────────────────────────────────────────╮
│  ▪ ▪ ▪ ■ ▪   ✻ Welcome to tokentracker               │
│  ▪ ■ ▪ ▪ ▪   every AI token you spend, every tool,   │
│  ■ ▪ ▪ ■ ▪   every machine, in one place             │
╰──────────────────────────────────────────────────────╯

  ✓ Found 2 tools with usage
    · Claude Code    1.39B tokens · 3,727 responses
    · OpenCode       365M tokens · 1,251 responses

  ✓ Which tools should be tracked? Claude Code, OpenCode
  ✓ Where should your usage live? Create a free account
  ✓ Pick a public handle you
  ✓ Uploaded 18 day/model rows
  ✓ Background sync on (launchd, runs hourly and at login, no admin needed)
```

**More computers:** run the same command on each one, choose *Connect an existing account*, and paste the key from `~/.config/tokentrack/config.json`. Give each computer its own name; totals add up.

### Background sync

`init` installs a per-user hourly job. No admin rights, no permission prompts.

| OS | Mechanism | Logs |
|---|---|---|
| macOS | launchd LaunchAgent (hourly and at login) | `~/Library/Logs/tokentrack.log` |
| Linux | systemd user timer, cron fallback | `~/.local/state/tokentrack/sync.log` |
| Windows | Task Scheduler, per user | `%LOCALAPPDATA%\tokentrack\sync.log` |

The first sync uploads your full history; later syncs send only the last 7 days. Claude Code deletes transcripts after 30 days by default, so the hourly sync also keeps that history safe.

### Commands

| Command | |
|---|---|
| `tokentrack init` | guided setup |
| `tokentrack connect` | choose tools (detected ones are marked *Auto*), add custom folders, connect Cursor |
| `tokentrack sync [--dry] [--full]` | upload daily totals. `--dry` prints the exact payload |
| `tokentrack status` | account, machine, tools and recent syncs |
| `tokentrack install` / `uninstall` | turn background sync on or off |
| `tokentrack delete-account` | delete your account and all data |

Connections live in `~/.config/tokentrack/config.json`:

```json
{
  "connections": {
    "claude-code": { "enabled": "auto" },
    "codex": { "enabled": true, "paths": ["~/work/.codex/sessions"] },
    "cline": { "enabled": false }
  }
}
```

`auto` (the default) means on whenever the tool is found on this machine.

## Privacy

- The collector runs on your machine and uploads **only daily token counts per tool and model**. Never prompts, code, file paths or API keys.
- The server **rejects** any upload containing other fields.
- `tokentrack sync --dry` prints exactly what would be sent:

```json
{ "date": "2026-11-17", "source": "opencode", "model": "github-copilot/claude-opus-5.5",
  "input": 381, "output": 138, "reasoning": 63, "cacheRead": 8448, "cacheWrite": 0, "messages": 1 }
```

- Keys are stored hashed. `tokentrack delete-account` removes everything.

## Put it on your site

```js
const res = await fetch('https://tokentracker-nu.vercel.app/api/activity?handle=you');
const { activityCounts, totals } = await res.json();
// activityCounts: [{ date: "2026-11-17", count: 259485947, sources: { cursor: 3853940, opencode: 255632007 } }]
```

CORS-open and cached at the edge for 5 minutes.

## Self-hosting

Prefer to keep your data in your own database? Deploy your own server and point `init` at it.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/bicrick/tokentracker&env=TOKENTRACK_INGEST_KEYS,TOKENTRACK_ACCOUNT,CURSOR_HANDLE,CRON_SECRET&envDescription=See%20.env.example&project-name=tokentracker&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%7D%5D)

1. Deploy (the button provisions a free Neon Postgres database).
2. Set `TOKENTRACK_INGEST_KEYS` (comma-separated, `openssl rand -hex 24`), `TOKENTRACK_ACCOUNT`, `CURSOR_HANDLE` and `CRON_SECRET`. See `.env.example`.
3. Run `init`, choose *Connect an existing account*, and enter your server URL and one of your keys.

## API

| Method | Path | Auth | |
|---|---|---|---|
| `GET` | `/api/activity?handle=` | public | daily totals by tool, per-model totals, machines and last sync |
| `POST` | `/api/signup` | public | create a hosted account, returns a key once |
| `GET` `POST` `DELETE` | `/api/account` | key | who am I, set Cursor handle, delete account |
| `POST` | `/api/ingest` | key | upload daily aggregates (optional `since` replaces only recent days) |
| `GET` | `/api/cron/cursor` | cron secret | refresh Cursor profiles |

## Development

```sh
npm install
npm test          # connector tests with synthetic fixtures for every tool
npm run dev       # vercel dev
```

## License

MIT. Tool names and logos belong to their owners.

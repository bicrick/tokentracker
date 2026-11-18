# tokentracker

Track AI token usage across every tool and device you code on, and show it as one heatmap.

- **OpenCode** (GitHub Copilot, Anthropic, OpenAI, any provider): read from the local OpenCode database
- **Claude Code**: read from `~/.claude/projects/**/*.jsonl`
- **Cursor**: pulled from your public `cursor.com/@handle` profile

## Privacy

The collector runs on your machine and uploads **only daily token counts per tool and model**. No prompts, code, file paths, or API keys ever leave your machine. The server rejects any payload with extra fields.

See exactly what would be sent:

```sh
tokentrack sync --dry
```

## How it works

```
your laptop ──┐
work machine ─┼─ tokentrack sync (hourly) ─▶ POST /api/ingest ─▶ Postgres ─▶ GET /api/activity ─▶ heatmap
other device ─┘                                                     ▲
                                        cursor.com/@handle ─ cron ──┘
```

Each sync sends a full recomputation of that device's history, so syncs are idempotent and totals across devices add up correctly.

## Collector setup

Requires Node 22.13+.

```sh
git clone https://github.com/bicrick/tokentracker && cd tokentracker
npm link                                   # installs the `tokentrack` command
tokentrack login --server https://<your-deployment> --key <ingest-key> --device my-laptop
tokentrack sync                            # first upload
tokentrack install                         # hourly background sync (macOS launchd)
tokentrack status
```

Behind a corporate TLS proxy? Run with `NODE_USE_SYSTEM_CA=1` (the hourly job sets this automatically).

## Server setup (Vercel)

1. Import this repo into Vercel.
2. Add a Postgres database (Neon) from the Vercel Marketplace. This sets `DATABASE_URL`.
3. Set environment variables (see `.env.example`):
   - `TOKENTRACK_INGEST_KEYS`: comma-separated device keys (`openssl rand -hex 24`)
   - `TOKENTRACK_ACCOUNT`, `CURSOR_HANDLE`
   - `CRON_SECRET`
4. Deploy. Tables are created on first request.

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/activity` | Combined daily totals: `activityCounts[{date, count, sources}]`, `totals`, `models`, `devices` |
| `POST` | `/api/ingest` | Upload daily aggregates (bearer device key) |
| `GET` | `/api/cron/cursor` | Refresh Cursor profile data (Vercel cron) |

`activityCounts` matches the shape of Cursor's profile data, so existing Cursor heatmaps can switch over directly.

## Roadmap

- Accounts, sign-in, and per-device keys issued from the browser (`tokentrack login` device flow)
- Public profile pages and an embeddable SVG heatmap
- Real-time push: OpenCode plugin, Claude Code OpenTelemetry export
- More sources: Codex CLI, Gemini CLI, API usage via local admin keys

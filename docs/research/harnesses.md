# Harness research: local token-usage data (Nov 2026)

Research date: 2026-11-18. Main evidence comes from the source and docs of trackers that already parse these formats: **tokscale** (junhoyeo/tokscale, 5.9k★, more than 60 clients) and **ccusage** (ryoppippi/ccusage, 19.5k★). I also used GitHub API star counts and VS Code Marketplace install counts that I queried live today.

Confidence labels:
- **H**: verified in a current tracker README/docs or in official docs.
- **M**: one secondary source, or partly verified.
- **L**: from memory or inference. Verify against a real file before shipping.

> Caveat: I took the field names for most tools from tokscale's and ccusage's documentation. I did not read the parser source line by line. Before you write each parser, check it against a sample file on a real machine.

---

## 1. Summary table

| Rank | Harness | Local token data? | Primary path (macOS/Linux) | Format | Conf. | Effort |
|---|---|---|---|---|---|---|
| 1 | Claude Code | **Y** (already supported) | `~/.claude/projects/**/*.jsonl` (+ `~/.config/claude/projects`) | JSONL | H | done |
| 2 | Cursor (IDE + agent) | **N** locally. API with the local session token | token in `state.vscdb` → cursor.com usage-events API | SQLite (auth only) + HTTPS | H | M |
| 3 | GitHub Copilot – VS Code | **N** (no reliable local token ledger) | — | — | M | not feasible locally |
| 3b | GitHub Copilot CLI | **Y** | `~/.copilot/session-state/*/events.jsonl`, `~/.copilot/session-store.db`, opt-in OTEL | JSONL / SQLite | H | M |
| 4 | OpenAI Codex (CLI + IDE ext + app) | **Y** | `~/.codex/sessions/**/rollout-*.jsonl` (+ `archived_sessions`, `.jsonl.zst`) | JSONL (cumulative) | H | M |
| 5 | Gemini CLI | **Y** | `~/.gemini/tmp/<hash>/chats/*.json(l)` | JSON | H | S |
| 6 | OpenCode | **Y** (already supported) | `~/.local/share/opencode/opencode*.db` | SQLite | H | done |
| 7 | Cline (VS Code ext + CLI) | **Y** | `<VSCode>/User/globalStorage/saoudrizwan.claude-dev/tasks/*/ui_messages.json` | JSON | H | M |
| 8 | Roo Code | **Y** | `.../globalStorage/rooveterinaryinc.roo-cline/tasks/*/ui_messages.json` | JSON | H | S (shares the Cline parser) |
| 9 | Kilo Code (ext + CLI) | **Y** | `.../globalStorage/kilocode.kilo-code/tasks/...`, CLI: `~/.local/share/kilo/kilo.db` | JSON / SQLite | H | S |
| 10 | Windsurf (now Cognition/Devin) | **N** | — | — | M | not feasible (team analytics API only) |
| 11 | Zed Agent | **Y** (hosted Zed models only) | macOS `~/Library/Application Support/Zed/threads/threads.db` | SQLite | H(path)/L(fields) | M |
| 12 | Amp | **Partial** (local threads) | `~/.local/share/amp/threads/**/*.json` | JSON | H | M |
| 13 | Goose | **Y** (per-session totals) | `~/.local/share/goose/sessions/sessions.db` | SQLite | H | S |
| 14 | Qwen Code | **Y** | `~/.qwen/projects/*/chats/*.jsonl` | JSONL | H | S |
| 15 | Factory Droid | **Y** (per-session) | `~/.factory/sessions/**/*.settings.json` | JSON | H | S |
| 16 | Kiro (IDE + CLI) | **Y** (partial) | `~/.kiro/sessions/cli/*.json`, `kiro-cli/data.sqlite3`, IDE globalStorage | JSON/SQLite | M | L |
| 17 | Crush | **Partial** (session cost only) | `~/.local/share/crush/projects.json` → per-project `crush.db` | SQLite | H | M |
| 18 | Aider | **Weak** (markdown history only) | `.aider.chat.history.md` per repo | Markdown | L | skip |
| 19 | Continue | **Maybe** (dev data) | `~/.continue/dev_data/...` | JSONL | L | skip/verify |
| 20 | Warp | **N** (requests + spend via API, no tokens) | — | GraphQL API | M | skip |
| 21 | Augment (Auggie CLI) | **Y** | `~/.augment/sessions/*.json` | JSON | H | S |
| 22 | Jules (Google) | **N** (cloud agent) | — | — | M | not feasible |

Effort: S = under 1 day, M = 1–3 days, L = more than 3 days or fragile.

---

## 2. Popularity ranking (Part 1)

GitHub stars and Marketplace installs below are **live values from 2026-11-18** (GitHub REST API and VS Code Marketplace gallery API).

| Harness | Evidence |
|---|---|
| GitHub Copilot | VS Code `GitHub.copilot-chat` has **79.3M installs**, the largest by far. `github/copilot-cli` has 11.4k★. |
| Claude Code | `anthropics/claude-code` has **156k★**. It is the default CLI agent in most 2025–26 surveys and is the top client on the tokscale and ccusage leaderboards. |
| Cursor | Closed source. It is the most-used AI IDE by revenue and seat count (public reporting, M confidence). |
| OpenAI Codex | `openai/codex` has **136k★**. The VS Code `openai.chatgpt` extension has **16.9M installs**. |
| OpenCode | `anomalyco/opencode` (formerly sst/opencode) has **228k★**. |
| Gemini CLI | `google-gemini/gemini-cli` has **109k★**. |
| Cline | 71.8k★ and 5.97M VS Code installs. |
| Zed | 95k★. This counts the whole editor, so agent usage is a subset. |
| Warp | 66k★ (repo is mainly the issue tracker). |
| Goose | 56.8k★. |
| Aider | 50.2k★, but declining relative to the agentic CLIs. |
| Continue | 36.5k★ and 4.58M installs. |
| Qwen Code | 30.8k★. |
| Crush | 29.1k★. |
| Kilo Code | 28k★ and 1.74M installs. |
| Roo Code | 24.2k★ and 2.12M installs. |
| Windsurf | Closed source. Large user base, now under Cognition. |
| Kiro, Amp, Factory Droid, Augment, Jules | Smaller or closed source. Kiro has 4.5k★ (issues repo only). |

**Recommended top-15 for tokentracker:** Claude Code, Cursor, Copilot, Codex, OpenCode, Gemini CLI, Cline, Windsurf, Roo Code, Kilo Code, Zed, Amp, Goose, Qwen Code, Factory Droid.

---

## 3. Per-harness details (Part 2)

### Shared: VS Code-family `globalStorage` roots (Cline, Roo, Kilo, Kiro IDE, Copilot)

Replace `<App>` with one of the following editor folder names:

| Editor | `<App>` |
|---|---|
| VS Code | `Code` |
| VS Code Insiders | `Code - Insiders` |
| Cursor | `Cursor` |
| Windsurf | `Windsurf` |
| VSCodium | `VSCodium` |
| Kiro | `Kiro` |

| OS | Root |
|---|---|
| macOS | `~/Library/Application Support/<App>/User/globalStorage/<ext-id>/` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/<App>/User/globalStorage/<ext-id>/` |
| Windows | `%APPDATA%\<App>\User\globalStorage\<ext-id>\` |
| Remote/WSL server | `~/.vscode-server/data/User/globalStorage/<ext-id>/` (also `~/.cursor-server/...`, `~/.windsurf-server/...`, L) |

Confidence: H for VS Code. The Electron `userData` convention is the same for all forks (H for the convention, M for each fork's folder name). The `<ext-id>` folder is lowercase (for example `rooveterinaryinc.roo-cline`).

The Cline/Roo/Kilo storage location can also be changed by the user with a custom storage path setting (L). Workspace-level state is in `.../User/workspaceStorage/<hash>/state.vscdb`.

---

### 3.1 Claude Code (rank 1): supported. Hardening notes

- **Paths (H, ccusage/tokscale):**
  - `~/.claude/projects/<encoded-cwd>/*.jsonl`
  - Newer installs: `~/.config/claude/projects/` (ccusage reads both).
  - `CLAUDE_CONFIG_DIR` overrides the root. ccusage accepts a comma-separated list.
  - Also `~/.claude/transcripts/*.jsonl`, counted only when it has a `usage` block.
  - Windows: `%USERPROFILE%\.claude\projects\`.
- **Record:** `type:"assistant"`. Fields:
  - `message.model`
  - `message.id`
  - `requestId`
  - `timestamp` (ISO)
  - `message.usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`
  - Optional `cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`
- **Per-message deltas.** Streaming writes several lines per message, so dedupe by `message.id + requestId` (H, ccusage).
- **Skip** `model == "<synthetic>"` and empty models (H, tokscale).
- **Reasoning:** thinking tokens are already included in `output_tokens`. Do not add them again (H, tokscale).
- **Sidechains/subagents** are in the same project tree as separate JSONL files. Include them.
- **Retention:** `cleanupPeriodDays` defaults to **30 days** in `~/.claude/settings.json`. Recommend users raise it (H, tokscale and Claude docs). A daily collector protects against this deletion because it uploads before the cleanup runs.
- **Also, optional:** Claude Desktop "Code/Cowork" transcripts under `~/Library/Application Support/Claude/{local-agent-mode-sessions,claude-code-sessions}/**/.claude/projects` (H, tokscale). Note that this folder is under Application Support.
- **Detect installed:** `~/.claude/` exists, or `claude` is on PATH.

### 3.2 Cursor (rank 2): no local token ledger. Use the API with the local session

- **Local data (H, tokscale):**
  - `state.vscdb` (SQLite, table `ItemTable`) does **not** contain a usable usage ledger.
  - It does contain the auth key `cursorAuth/accessToken` (a JWT). Path: `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` (Linux `~/.config/Cursor/...`, Windows `%APPDATA%\Cursor\...`).
  - macOS also stores the token in the Keychain item `cursor-access-token`.
  - `~/.cursor` (agent CLI state) does not contain usable token usage.
- **Best option (H that tokscale does this):**
  1. Read `cursorAuth/accessToken` from `state.vscdb`.
  2. Call Cursor's **usage-events** dashboard API (`cursor.com/api/dashboard/...`). This is the same API the web dashboard and CSV export use. It is undocumented and private, and can change at any time.
  3. Fallback: the user pastes their `WorkosCursorSessionToken` cookie.
  - The usage events include per-request model and input/output/cache tokens (M; I did not verify the exact endpoint name or schema).
  - **Read tokscale's `crates/**/cursor*` source** before you implement this.
- **Risk:**
  - Private API.
  - Reading another app's credentials can look like credential theft to users and EDR tools. Make this opt-in with clear consent text.
  - Your current public-profile scrape (`cursor.com/@handle`) is lower fidelity but needs no credentials. Keep it as the default and offer the token sync as an opt-in.
- **Official alternative:** the Cursor **Admin API** (`/teams/daily-usage-data`, `/teams/filtered-usage-events`) exists for Team/Enterprise admins only (M).
- **Detect installed:** the `Cursor` app folder exists, or `state.vscdb` exists.

### 3.3 GitHub Copilot

- **VS Code Copilot Chat/agent (M):** chat sessions are stored as JSON in `workspaceStorage/<hash>/chatSessions/*.json`. Neither tokscale nor ccusage parses them for tokens, which suggests there is no reliable per-request token count there (L). Inline completions are not logged with tokens.
  - Alternative: the org/enterprise **Copilot Metrics / usage API** (admin only, no per-user token counts) or premium-request billing reports. **Not feasible for individuals.**
- **Copilot CLI (H, ccusage + tokscale):**
  - **Source A:** `${COPILOT_HOME:-~/.copilot}/session-state/*/events.jsonl`.
    - Current versions write a `session.usage_record` event for **every model call**, using `data.usage.model` and `data.usage` token fields. These are per-call deltas.
    - Older versions only write `session.shutdown` snapshots, which are **cumulative per session/model** and repeated when a session resumes. To handle them: use the first snapshot as-is, and for each later snapshot use the difference from the previous one.
  - **Source B:** `~/.copilot/session-store.db` (SQLite, tokscale).
  - **Source C:** opt-in OTEL file export, enabled with `COPILOT_OTEL_ENABLED=true`, `COPILOT_OTEL_EXPORTER_TYPE=file`, `COPILOT_OTEL_FILE_EXPORTER_PATH`. Use `chat` spans with these attributes:
    - `gen_ai.response.model`
    - `gen_ai.usage.input_tokens`
    - `gen_ai.usage.output_tokens`
    - `gen_ai.usage.cache_read.input_tokens`
    - `gen_ai.usage.reasoning.output_tokens`
  - **Dedupe:** by trace+span ID. When both sources exist, prefer session-state.
- **Detect installed:** `~/.copilot/` exists, or the extension folder `github.copilot-chat` exists.

### 3.4 OpenAI Codex (CLI, IDE extension, desktop app share `CODEX_HOME`)

- **Paths (H):**
  - `${CODEX_HOME:-~/.codex}/sessions/YYYY/MM/DD/rollout-*.jsonl`
  - `${CODEX_HOME}/archived_sessions/`
  - Zstd-compressed `*.jsonl.zst` copies also exist.
  - Windows: `%USERPROFILE%\.codex\`.
- **Records (H):**
  - `{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{...},"last_token_usage":{...}}}}`
  - Each usage object has `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`, `total_tokens`. The field names are H in ccusage, but I am quoting them from memory of its schema, so treat them as M.
  - The model comes from the most recent `{"type":"turn_context","payload":{"model":...}}` line.
  - The timestamp is the line's top-level `timestamp`.
- **Avoid double counting:**
  - `total_token_usage` is **cumulative** for the session. `last_token_usage` is the delta for the latest request.
  - Preferred delta: `total[i] − total[i−1]`, with `last_token_usage` as a fallback. Do not sum `total_token_usage`.
  - Repeated `token_count` events with an unchanged total must contribute 0.
  - `cached_input_tokens` is a **subset** of `input_tokens`. Record `input − cached` as input, and `cached` as cacheRead.
  - `reasoning_output_tokens` is a subset of `output_tokens`, billed as output.
  - Subagent rollouts replay the parent's history prefix. Use the last inherited snapshot as the baseline (H, ccusage).
  - Remote compaction `token_usage_record` entries count only when they match a `compacted` record (H, ccusage).
- **Dedupe across copies:** the same rollout can exist in both `sessions/` and `archived_sessions/`, and as both `.jsonl` and `.jsonl.zst`. Key on the relative rollout path or the session id. Prefer the active, plain copy (H).
- **Retention:** no automatic cleanup (H, tokscale and openai/codex#6015).
- **Hook:** the `notify = [...]` program in `config.toml` runs after each turn (M). There is also an OTEL exporter in config (M).
- Early Sept-2025 logs have no `turn_context`. ccusage assumes `gpt-5` for those.

### 3.5 Gemini CLI

- **Paths (H):**
  - `${GEMINI_CLI_HOME:-~}/.gemini/tmp/<projectHash>/chats/*.json` (and `*.jsonl` in newer versions).
  - Windows: `%USERPROFILE%\.gemini\tmp\...`.
- **Record:** `{sessionId, messages:[{type:"gemini", id, timestamp, model, tokens:{input, output, cached, thoughts, tool, total}}]}`.
- **Cached tokens:** `cached` is **included in** `input`. Subtract it from input and store it as cacheRead (H, ccusage).
- `thoughts` maps to reasoning.
- **Dedupe:** by `sessionId + message id`. The files are rewritten as whole snapshots, so re-parsing must be idempotent.
- **Retention:** `general.sessionRetention` in settings. Disabled by default (H).
- **Also, optional:** Antigravity CLI/IDE at `~/.gemini/antigravity*/conversations/*.db` (H, tokscale).

### 3.6 OpenCode: supported. Hardening notes

- **Database files:** read every `opencode*.db` file, not only `opencode.db`. Channel builds write `opencode-stable.db`, `opencode-nightly.db`, and so on.
- **Environment overrides:** respect the `OPENCODE_DB` override and `XDG_DATA_HOME`.
- **Legacy storage:** older versions store messages as JSON under `storage/message/<session>/*.json`.
- **Message fields:** `modelID`, `providerID`, `tokens.{input, output, reasoning, cache.read, cache.write}`, and `time.created` (in ms).

(Sources: tokscale data sources (H); the OpenCode retention issue sst/opencode#4980.)

- **Retention:** none.
- **Real-time option:** OpenCode plugins can subscribe to `message.updated` / session events for a push model (M).
- **Forks:** Kilo CLI (`~/.local/share/kilo/kilo.db`) and MiMo Code use the same schema (H), so the same parser covers them.

### 3.7 Cline / 3.8 Roo Code / 3.9 Kilo Code (shared parser)

- **Extension IDs:**
  - Cline: `saoudrizwan.claude-dev`
  - Roo Code: `rooveterinaryinc.roo-cline`
  - Kilo Code: `kilocode.kilo-code`
  - Apply these to every editor root in the VS Code-family table above.
- **Files:** `tasks/<taskId>/ui_messages.json` (array) plus `api_conversation_history.json`, which holds model and environment info.
- **Records (H, tokscale):**
  - Use entries with `type=="say" && say=="api_req_started"`, timestamp `ts` in ms.
  - The `text` field is a JSON string: `{tokensIn, tokensOut, cacheReads, cacheWrites, cost, apiProtocol}`.
  - These are **per-request deltas**.
  - The model is not in that line. Get it from `api_conversation_history.json` or the task metadata (`taskHistory` in globalState), M.
- **Dedupe:** `taskId + ts`.
- **Retention:** kept until the user deletes the task.
- **Cline CLI:** `$CLINE_DATA_DIR/sessions/<id>/<id>.messages.json` (default `~/.cline/data/sessions/`). Assistant messages have `metrics` (H, tokscale).

### 3.10 Windsurf

- No local token ledger is known. Neither tokscale nor ccusage supports Windsurf. Tokscale does support Devin CLI/Desktop, which is the Cognition successor tooling.
- **Alternative:** the Windsurf Teams analytics API for admins only (M). For individual users: **not feasible**.
- Windsurf also counts usage in credits rather than tokens.

### 3.11 Zed Agent

- **Paths (H, tokscale):**
  - macOS: `~/Library/Application Support/Zed/threads/threads.db`
  - Linux: `~/.local/share/zed/threads/threads.db`
  - Windows: `%LOCALAPPDATA%\Zed\threads\threads.db`
- Format is SQLite. Thread rows hold compressed (zstd) JSON with per-request `request_token_usage` and the model (L, check tokscale's source).
- Covers **hosted Zed models only**. External ACP agents such as Claude Code inside Zed are logged by those agents themselves.

### 3.12 Amp

- **Path (H, ccusage):** `${AMP_DATA_DIR:-~/.local/share/amp}/threads/**/*.json`.
- **Fields:** the usage-ledger events give input and output tokens. Assistant `message.usage` gives cache creation and cache read. Credits are also recorded (H).
- Tokscale requires `tokscale amp sync` to fetch threads, which suggests the local copies may be incomplete (M).
- **Dedupe:** by message or ledger event id.

### 3.13 Goose

- **Paths (H):**
  - `~/.local/share/goose/sessions/sessions.db`
  - macOS `~/Library/Application Support/Block/goose/...` (legacy)
  - Windows `%APPDATA%\Block\goose\data\sessions\sessions.db`
  - `GOOSE_PATH_ROOT` overrides the root.
- **Fields:** **cumulative per-session** input/output totals in the `sessions` table, with `model_config_json` and `provider_name`.
- Daily attribution needs snapshots: store the last-seen totals and upload the delta (H that totals are per session, M on column names).

### 3.14 Qwen Code

- **Path (H):** `~/.qwen/projects/<proj>/chats/<chatId>.jsonl`.
- **Fields:** each line has `type`, `model`, `timestamp`, `sessionId`, and `usageMetadata.{promptTokenCount, candidatesTokenCount, thoughtsTokenCount, cachedContentTokenCount}`.
- `cachedContentTokenCount` is likely a subset of `promptTokenCount`, as in the Gemini API (M).

### 3.15 Factory Droid

- **Path (H, ccusage):** `${DROID_SESSIONS_DIR:-~/.factory/sessions}/**/*.settings.json`.
- **Fields:** per-session input, output, cache creation, cache read, and thinking tokens. These are **cumulative per session**, so use the snapshot-delta approach. Use the file mtime as the timestamp (M).

### 3.16 Kiro

- **Paths (M, tokscale):**
  - `~/.kiro/sessions/cli/*.json(l)`
  - `kiro-cli/data.sqlite3` (macOS Application Support, Linux `~/.local/share`)
  - IDE globalStorage `kiro.kiroagent`
- Usage is billed in "credits", so token fields may be missing. Fragile.

### 3.17 Crush

- **Path (H):** `${XDG_DATA_HOME:-~/.local/share}/crush/projects.json` lists each project's `.crush/crush.db`.
- Only **session-level cost and totals** are reliable, with no per-model split (H, tokscale). Lower priority.

### 3.18 Aider (L)

- Aider writes `.aider.chat.history.md` per repo, with lines like `Tokens: 12k sent, 1.2k received. Cost: …`. It has no global store, so files must be found by scanning repos.
- Optional analytics are opt-in and remote. **Skip**, or only support it as a "scan these dirs" opt-in.

### 3.19 Continue (L)

- Continue writes "dev data" under `~/.continue/dev_data/<version>/` (for example `tokensGenerated.jsonl` with model and prompt/generated tokens). **Not verified.** Check a real install first.

### 3.20 Warp

- Tokscale syncs only aggregate requests and spend via Warp's authenticated GraphQL API. There are no tokens, and tokscale excludes Warp from token leaderboards (H). **Skip.**

### 3.21 Augment (Auggie CLI)

- **Path (H):** `~/.augment/sessions/<id>.json`.
- **Fields:** `chatHistory[].exchange.response_nodes[].token_usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}`, plus `exchange.model_id`.

### 3.22 Jules

- Cloud-only agent, so there is no local data. **Not feasible.**

---

## 4. Scheduling and permissions (Part 3)

### General recommendation

- Use a per-user scheduler that runs `tokentracker sync` **hourly**. The job is idempotent: recompute the full daily aggregate for the last N days and upsert it on the server.
- Never require admin rights.
- Hourly runs also guard against Claude Code's 30-day cleanup and laptops being asleep at a fixed time.
- **Prefer computing full days from source data over shipping deltas** wherever the source keeps history. Use local snapshot state only for cumulative-only sources (Goose, Droid, Copilot shutdown events).

### macOS: launchd LaunchAgent (H)

- **Location:** `~/Library/LaunchAgents/dev.tokentracker.sync.plist`.
- **Contents:** `ProgramArguments` = absolute path to the binary (not a shell alias), `StartInterval` 3600 (catches up after sleep better than `StartCalendarInterval`), `RunAtLoad` true, and log paths under `~/Library/Logs/tokentracker/`.
- **Commands:** load with `launchctl bootstrap gui/$(id -u) <plist>`; unload with `launchctl bootout`.
- **No admin rights needed.** macOS 13+ shows a "Background Items Added" notification. That is normal.
- **TCC (privacy permissions):**
  - `~/.claude`, `~/.codex`, `~/.gemini`, `~/.local/share/*`, `~/.config/*` are **not** TCC-protected.
  - `~/Library/Application Support/<App>/` (Cursor, Code, Zed, Claude Desktop) is generally **not** protected for reading another app's ordinary files (H-ish). However, macOS 14+/15 **"App Data" protection** can show a prompt like "<tool> would like to access data from other apps" when reading files of *another sandboxed/notarized app container* (M).
  - The real TCC-protected folders are Desktop, Documents, Downloads, iCloud Drive, Mail, Messages, Safari, removable volumes, and `~/Library/Containers` of other apps. **Avoid scanning repos under ~/Desktop or ~/Documents** (relevant for Aider, and for Codex/Claude project dirs only if you resolve `cwd`). You never need to open the project directories themselves, so don't.
  - **Full Disk Access is not needed** for the supported sources.
- **Keychain:** reading `cursor-access-token` from the Keychain triggers a user approval prompt. Prefer `state.vscdb`, which has no prompt.
- **Binary signing:** an unsigned Node binary launched by launchd works. A signed and notarized helper avoids Gatekeeper prompts.

### Linux: systemd user timer (H)

- **Files:** `~/.config/systemd/user/tokentracker.service` (Type=oneshot) and `tokentracker.timer` (`OnCalendar=hourly`, `Persistent=true` so missed runs fire after resume).
- **Enable:** `systemctl --user enable --now tokentracker.timer`.
- **Lingering:** without lingering, user timers only run while the user is logged in. That is fine for desktops. `loginctl enable-linger` may need polkit or admin rights on some distros, so don't require it.
- **Fallback:** `crontab -e` with `0 * * * *`. Cron has no catch-up after sleep and uses a minimal PATH, so use absolute paths.
- **WSL:** the data lives inside the WSL home. Run the collector inside WSL, or read `\\wsl$\<distro>\home\<user>` from Windows (M).

### Windows: Task Scheduler, per user (H)

- **Create:** `schtasks /Create /SC HOURLY /TN "TokenTracker\Sync" /TR "\"%LOCALAPPDATA%\tokentracker\tokentracker.exe\" sync" /F`. This runs only when the user is logged on and needs no admin rights.
- **Avoid a console window flashing:** use a `pwsh -WindowStyle Hidden` wrapper or a GUI-subsystem exe.
- **Alternative:** a shortcut in `shell:startup` plus an internal timer.
- **Paths:**
  - `%USERPROFILE%\.claude`, `\.codex`, `\.gemini`, `\.copilot`
  - `%APPDATA%\Code|Cursor|Windsurf\User\globalStorage`
  - `%LOCALAPPDATA%\Zed`
  - OpenCode on Windows uses `%USERPROFILE%\.local\share\opencode` (XDG-style; M)

### How existing tools handle scheduling

- **ccusage** has no daemon. It runs on demand and offers a statusline integration (Claude Code `statusLine` command; the Codex statusline is MCP-based).
- **tokscale** runs on demand with `submit`, and has an "Autosubmit" feature (see its README `#autosubmit`) that installs a scheduled job (M; check the details).
- **viberank** uses manual upload of ccusage JSON.

### Hooks: push in real time without a daemon

- **Claude Code hooks** in `settings.json`: a `Stop` / `SessionEnd` hook gets JSON on stdin with `transcript_path` and `session_id`. Run `tokentracker ingest --file $transcript_path` (H for hooks existing, M for the exact payload fields).
- **Codex:** `notify = ["tokentracker","codex-notify"]` in `~/.codex/config.toml` is called after each agent turn with a JSON argument (M).
- **OpenCode:** a plugin in `~/.config/opencode/plugin/*.ts` subscribing to `session.idle` / `message.updated` events (M).
- **Gemini CLI:** hooks were added in 2025–26 (L, verify).
- **Copilot CLI:** OTEL exporter.
- **Trade-offs:** hooks are more fragile across versions, only cover CLI tools, and need config edits. **Recommendation:** use the scheduler as the source of truth. Offer optional hooks only to make the dashboard update faster, both triggering the same idempotent `sync`.

---

## 5. Logos (Simple Icons: slugs checked live against `https://cdn.simpleicons.org/<slug>` on 2026-11-18)

| Harness | Slug | Status |
|---|---|---|
| Claude Code | `claude` (also `anthropic`) | ✅ 200 |
| Cursor | `cursor` | ✅ 200 |
| GitHub Copilot | `githubcopilot` | ✅ 200 |
| Gemini CLI | `googlegemini` | ✅ 200 |
| OpenCode | `opencode` | ✅ 200 |
| Cline | `cline` | ✅ 200 |
| Windsurf | `windsurf` | ✅ 200 |
| Zed | `zedindustries` | ✅ 200 (`zed` is 404) |
| Warp | `warp` | ✅ 200 |
| Qwen Code | `qwen` (also `alibabacloud`) | ✅ 200 |
| Goose | — (`block` is 404) | ❌ use the official asset from the repo |
| **OpenAI / Codex** | `openai` | ❌ **404**, removed from Simple Icons. Use OpenAI's brand page assets (openai.com/brand) |
| Roo Code, Kilo Code, Kiro, Amp/Sourcegraph, Factory, Augment, Aider, Continue, Charm/Crush | — | ❌ 404. Use each project's GitHub org avatar or press kit |
| Other useful slugs | `vscodium`, `github`, `jetbrains`, `deepseek`, `mistralai`, `ollama` | ✅ 200 |

- **Alternative icon set:** `@lobehub/icons` (npm) has AI-brand icons for OpenAI, Claude, Cursor, Cline, Roo, Kilo, Windsurf, Copilot, Gemini, Qwen, Goose, and more. The unpkg static URL I tried returned 403, so install it from npm instead.
- **Brand guidelines:**
  - Use the marks unmodified, and only to refer to the product (nominative use).
  - No implied endorsement. Add a footer line such as "All trademarks belong to their owners".
  - Anthropic and OpenAI publish brand pages that restrict altering colors or combining marks.
  - Simple Icons states that its icons are brand assets subject to each owner's guidelines (simpleicons.org disclaimer).

---

## 6. Sources

- tokscale README and data-source docs: https://github.com/junhoyeo/tokscale. This covers paths and formats for OpenCode, Claude, Codex, Copilot CLI, Gemini, Cursor (API and `state.vscdb` token), Roo, Kilo, Cline, Zed, Kiro, Goose, Crush, Qwen, Droid, Amp, Augment, and Warp, plus the retention table.
- ccusage docs:
  - https://github.com/ryoppippi/ccusage/blob/main/docs/guide/codex/index.md (Codex cumulative and delta handling, `CODEX_HOME`, archived/zst)
  - `docs/guide/gemini/index.md` (`GEMINI_DATA_DIR`, cached included in input)
  - `docs/guide/copilot/index.md` (`COPILOT_HOME`, `session.usage_record`, shutdown snapshot deltas)
  - `docs/guide/amp/index.md` (`AMP_DATA_DIR`)
  - `docs/guide/droid/index.md` (`DROID_SESSIONS_DIR`, `*.settings.json`)
- Claude Code settings (`cleanupPeriodDays`, hooks): https://docs.anthropic.com/en/docs/claude-code/settings, https://docs.anthropic.com/en/docs/claude-code/hooks
- Codex retention issue: https://github.com/openai/codex/issues/6015
- OpenCode retention issue: https://github.com/sst/opencode/issues/4980
- Gemini session management: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md
- GitHub REST API `/repos/*` star counts and the VS Code Marketplace gallery `extensionquery` install counts (queried 2026-11-18).
- Simple Icons CDN status checks: https://cdn.simpleicons.org/<slug>

**Unverified items to check before implementation:**
- Cursor usage-events endpoint and schema (read tokscale's Rust source).
- Zed `threads.db` blob schema.
- Copilot VS Code chatSessions token fields.
- Continue dev_data.
- Codex `notify` payload.
- Gemini CLI hooks.
- macOS "App Data" TCC prompt behavior for `~/Library/Application Support/<OtherApp>`.

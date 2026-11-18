# DeepSeek coding harnesses — local token-usage research (Nov 2026)

Confidence levels: **H** (high) = I read the source or a fixture myself. **M** (medium) = several independent third-party docs agree. **L** (low) = a single secondary source.

## 1. DeepSeek Harness (`dsh`): official, recommended target

- **Repo:** https://github.com/deepseek-ai/deepseek-harness. It is MIT-licensed and maintained by DeepSeek AI. I checked HEAD `2e39e704` (2026-11-18), root version `0.2.2-rc.5`. **H**
- **Origin:** It is not a fork. It is a new TypeScript harness built on Cordis. **H**
- **Popularity:** It launched 2026-08-13 and passed 100k stars within 2 days. One review reports about 280k stars by Oct 2026 ([iadecider](https://iadecider.com/articles/deepseek-harness-review)). There are many community plugins and usage panels. It is still a preview with no stable tag. **M**
- **Install:** `npx @deepseek-ai/dsh web`. There are also CLI, desktop, headless, SDK and ACP surfaces, and they all share `$DSH_HOME`. **M**

### Storage
- **Root:** `$DSH_HOME`, or `~/.dsh` if it is unset. The same layout applies on macOS, Linux and Windows (`%USERPROFILE%\.dsh`).
  - Source: `packages/util/home-paths/src/index.ts:12` has `DSH_HOME_DIR_NAME = '.dsh'`, and `liveshare/src/host/share-host.ts:677` reads `process.env.DSH_HOME ?? join(homedir(),'.dsh')`. **H**
  - Windows is unverified ([chat-stasher](https://github.com/dimpurr/chat-stasher/blob/main/docs/sources/deepseek-harness.md)).
- **Session files:** `sessions/<encoded-cwd>/<session-id>/session.jsonl` (generation 0) or `session.vN.jsonl`. The current generation is v4. Files may also end in `.zstd`. **H**
  - Source: `packages/session/session-format/src/filename.ts`, which uses the regex `^session(?:\.v([1-9][0-9]*))?\.jsonl$`.
  - Older generations stay on disk after a migration. **Read only the highest generation in each directory.**
- **Profiles:** One guide reports per-profile homes at `~/.dsh/profiles/<profile>/sessions` ([dsh-plugin.org](https://dsh-plugin.org/tutorials/dsh-web-cli-shared-sessions)). **L**. Scan recursively under the root.
- **Compression:** By default each append is written as its own zstd frame. Decode every frame; Node's `zstdDecompressSync` stops after the first one. The last frame may be truncated while the session is being written. **M/H**

### Format: JSONL, one `{type, seq, time, data}` event per line (`time` is epoch milliseconds)
- **Line 1 (header):** `{"type":"session","version":4,"id":"session-<uuid>","createdAt":<ms>,"cwd":...,"isSeeded":bool,"parentSession"?:...}`
- **Model and provider:**
  - `request/header`: `data.header.config.{provider,model}`
  - `request/context`: `data.{provider,model}`
  - Each one applies to the usage events that come after it.
- **Usage carriers:**
  - `assistant/message` and `assistant/attempt` (failed or aborted calls): use `data.usage`. If it is missing, use the last `data.stream[]` item where `type=="chunk"` and `chunk.type=="usage"`, then read its `chunk.usage`.
  - `compaction/summary`: `data.usage`, with its own `data.provider` and `data.model`.
- **TokenUsage fields:** `inputTokens`, `outputTokens`, `totalTokens?`, `cacheReadTokens?`, `cacheWriteTokens?`, `reasoningTokens?`. **H**
  - Defined in `packages/llm/llm/src/types.ts:182-196`.
  - The values are **disjoint**: `inputTokens` is uncached input only.
  - The type's doc comment says that DeepSeek's `prompt_tokens` is reduced by the cache counts.
  - `reasoningTokens` is a subset of `outputTokens` (`token-meter/src/turn-usage.ts:88`).
  - The raw DeepSeek fields `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens` are **not stored**. They are normalized into `cacheReadTokens` and `inputTokens`. **H**
- **Granularity:** Usage is recorded per model call, not as a running total. **H**
- **Dedupe key:** `sessionId:seq` (this is what ccusage uses).
- **Forks:** A forked session (`isSeeded:true`) copies its parent's log. Drop every usage event before the last `session/end-seed` event whose `data.inherited` is true.
- **Title generation:** Usage for session-title generation is not logged.
- **Cost:** No cost is recorded.

Example from the ccusage fixture `rust/adapters/dsh/tests/fixtures/parent/session.v4.jsonl`:
```json
{"type":"assistant/message","seq":5,"time":1791972005000,"data":{"turn":2,"step":1,"message":{...},"stream":[],"usage":{"inputTokens":400,"outputTokens":120,"cacheReadTokens":9000,"cacheWriteTokens":600,"totalTokens":10120}}}
```

### Detection
Check that `$DSH_HOME/sessions` or `~/.dsh/sessions` exists.

### Existing support
- **ccusage:** Yes, as the experimental source `dsh`. See https://ccusage.com/guide/dsh/ and the Rust adapter `rust/adapters/dsh/src/{parser,paths}.rs`. **H**
- **tokscale:** Not verified.
- **Others that read it:** Token Telemetry, AgentMeter, AllSessions, and several dsh plugins (dsh-usage-panel, dsh-session-usage, dsh-token-usage).
- **Format stability:** The session format has no compatibility promise, and the log format already changed without backward compatibility during the preview. **M**. Gate the parser on the header `version` (formats 0–4 are known).

## 2. Deep Code (`deepcode-cli`): community, DeepSeek-endorsed

- **Repo:** https://github.com/lessweb/deepcode-cli. It is on npm as `@vegamo/deepcode-cli` (v0.7.0, last commit 2026-11-13) and has a VS Code extension. DeepSeek's API docs list it ([docs](https://api-docs.deepseek.com/quick_start/agent_integrations/deepcode/)). **H**. I did not check its popularity.
- **Origin:** It is not a fork of a known harness. **M**
- **Storage:** `~/.deepcode/projects/<projectCode>/sessions-index.json`, plus per-session message JSONL. Source: `packages/core/src/session.ts:3106-3107` and `:3302`. **H**
- **Usage fields:** Each session entry has a **cumulative** `usage` and `usagePerModel[model]`. These keep the raw DeepSeek fields: `prompt_tokens`, `completion_tokens`, `total_tokens`, `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`, `completion_tokens_details` (which holds reasoning), and `total_reqs`. Timestamps are `createTime` and `updateTime`. Source: `session.ts:280-289`, `:2117-2118`. **H**
- **Gap:** There is no per-call timestamp, so daily attribution only works by diffing snapshots or by assigning a session's totals to its `updateTime`.
- **Existing support:** I found none in ccusage. **M**

## 3. Not harnesses
- DeepSeek also publishes integration guides for Claude Code, Codex, OpenCode and Copilot CLI ([awesome-deepseek-agent](https://github.com/deepseek-ai/awesome-deepseek-agent)). That usage lands in those tools' own logs and is already covered by their connectors, with the model reported as `deepseek-*`.
- `pip install deepseek-harness-cli` is an unrelated third-party package. **L**

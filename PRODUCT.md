# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Static HTML/CSS/vanilla JS in `public/`, served by the same Vercel project as the API (one stateless Vercel Function, no database). No framework, no build step.

## Users

Developers who code heavily with several AI tools (Cursor, Claude Code, OpenCode with GitHub Copilot or other providers), often on more than one machine. They want a public, combined token-usage profile to show off: a heatmap and a big yearly number they can put on their personal site or share. They typically arrive from someone else's profile or heatmap and want their own.

## Product Purpose

tokentracker adds up every AI token a developer spends, across every tool and every machine, and exposes it as one public, queryable API (usage, models, tools, heatmap, stats, devices). The API is the product; there are no embeddable widgets. Success: a visitor runs one CLI command, picks where data lives, and has a live profile and embeddable data within a minute, kept current by an hourly background sync.

## Positioning

Every tool, every machine. Tool-specific profiles (like Cursor's) only show one tool; tokentracker combines Cursor, Claude Code and OpenCode/Copilot from all of a person's computers into one number. Secondary truths that support it: local-first collection (only daily counts per tool and model leave the machine), open source, and self-hostable.

## Operating Context

- Onboarding happens entirely in the terminal: `npx @bicrick/tokentracker init`. The web page's job is to get that command copied.
- `init` previews what it found locally, then stores everything in a `tokentracker-data` repo on the user's own GitHub. No accounts: the GitHub username is the handle.
- Each additional machine runs `init` again with the existing key and a different device name; totals combine.
- Public profiles live at `/u/<handle>`; data at `/api/activity?handle=<handle>` (CORS-open, edge cached).
- Cursor data comes from the user's public `cursor.com/@handle` profile; OpenCode and Claude Code from local files.

## Capabilities and Constraints

- Sources today: OpenCode (`~/.local/share/opencode/opencode.db`), Claude Code (`~/.claude/projects/**/*.jsonl`), Cursor (public profile). Planned, not built: Codex CLI, Gemini CLI, API admin-key usage.
- Hourly background sync on macOS (launchd); Linux via cron. Requires Node 22.13+.
- Users own their data: deleting the repo deletes everything.
- Uploads are validated to contain only date, tool, model and numeric token counts.
- Always free: no pricing exists and none is planned. Do not imply paid plans.
- Package not yet on npm (`tokentracker` name is available); install is via the GitHub npx form.

## Brand Commitments

- Name: tokentracker (lowercase). CLI command: `tokentrack`.
- Standalone product, not a bicrick personal-site page. bicrick's profile is used only as the live example.
- Open source, MIT.

## Evidence on Hand

- Real live data: bicrick's profile (~9.2B tokens this year across cursor, claude code, opencode) via `/api/activity?handle=bicrick`.
- No testimonials, user counts, logos, or press exist. Do not fabricate any.

## Business Model

- Always free. No paid plans, no Teams tier, no waitlist. tokentracker is a free, open-source community tool and a portfolio piece by bicrick. Do not imply pricing, upgrades, or future paid features.
- The CLI (collector) is the product and is MIT open source. It runs on users' machines and costs nothing to operate.
- Storage is the user's own GitHub repo (`tokentracker-data`); the hosted API is a stateless reader of it, and each repo also publishes a static API on GitHub Pages. There is no tokentracker database, account system or email.
- Landing page primary action: copy the `npx` command.

## Product Principles

1. The command is the product's front door; everything on the page should lead to copying it.
2. Show real data, not illustrations of data: the live heatmap is the proof.
3. Privacy is stated plainly and verifiably (`sync --dry`), never as vague reassurance.
4. One combined number across tools and machines is the headline idea.

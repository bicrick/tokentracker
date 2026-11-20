<p align="center">
  <a href="https://tokentracker.patrickbrown.dev"><img src="docs/assets/banner.png" alt="tokentracker: every AI token, every tool, every machine" width="100%"></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@bicrick/tokentracker"><img alt="npm" src="https://img.shields.io/npm/v/@bicrick/tokentracker?style=flat-square&color=f0c463&label=npm"></a>
  <a href="https://github.com/bicrick/tokentracker/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/bicrick/tokentracker/ci.yml?branch=main&style=flat-square&label=ci"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-2563eb?style=flat-square"></a>
  <img alt="stored in your GitHub" src="https://img.shields.io/badge/data-your%20GitHub-181717?style=flat-square&logo=github&logoColor=white">
  <img alt="macOS, Linux, Windows" src="https://img.shields.io/badge/macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-supported-555?style=flat-square">
</p>

<p align="center">
  <a href="https://tokentracker.patrickbrown.dev">Website</a> ·
  <a href="https://www.npmjs.com/package/@bicrick/tokentracker">npm</a> ·
  <a href="https://tokentracker.patrickbrown.dev/docs">Docs</a> ·
  <a href="https://tokentracker.patrickbrown.dev/llms.txt">llms.txt</a> ·
  <a href="https://github.com/bicrick/tokentracker-data">Example</a>
</p>

---

Every AI token you spend, across Claude Code, Codex, Cursor, OpenCode, Gemini CLI, Copilot and more, on every machine, as one API. Stored in a repo on your own GitHub. Free, no account.

## Install

Ask your agent:

> Install tokentracker for me: run `npx @bicrick/tokentracker init`

Or run it yourself (Node 22.13+; you'll sign in to GitHub with a code):

```sh
npx @bicrick/tokentracker init
```

## Use it

Ask your agent:

> How many tokens did I use this month, and on which models? Use my tokentracker API.

Agents get everything they need from [`llms.txt`](https://tokentracker.patrickbrown.dev/llms.txt) and [`AGENTS.md`](AGENTS.md). People can read the [docs](https://tokentracker.patrickbrown.dev/docs).

```sh
curl https://<github-username>.github.io/tokentracker-data/api/v1/stats.json
```

## License

MIT

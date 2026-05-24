# omp-tg-sdk

Telegram bridge for OMP, built directly on the `@oh-my-pi/pi-coding-agent` SDK.

In-process: a single Bun process holds one `AgentSession` per Telegram chat
(or per topic), with full type access to the SDK — no `omp --mode rpc`
subprocess, no JSON-RPC marshalling.

## Status

**v1**: per-chat AgentSession, fully streaming, UI bridge (confirm /
select / input / editor) wired through inline keyboards, and the core
session commands (`/new`, `/sessions`, `/resume`, `/cancel`, `/status`).
Each chat is pinned to one cwd at session creation; multi-cwd per chat
will land when we add forum-topic support.

## Layout

```
src/
  spike.ts   ← single-cwd telegram bot driving one AgentSession
  smoke.ts   ← offline check: AgentSession + prompt + dispose, no telegram
```

## Quick start

```sh
bun install

# Verify the SDK side works on your machine (no telegram needed).
bun run src/smoke.ts /path/to/repo

# Wire telegram.
cp .env.example .env
# fill TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_CHATS, OMP_DEFAULT_CWD
bun run spike
```

Then DM the bot. `/status`, `/cancel`, plain text → agent turn.

## Why this and not the python fork

`../omp-tg-bridge` was a fork of FreakySurgeon/claude-telegram-bridge with
its claude-CLI runner swapped for `omp --mode rpc`. It works for the basic
prompt loop, but every interactive surface (the agent's `ask` tool,
extension `confirm` / `select` / `input`, preview gates from `ast_edit`)
arrives as `extension_ui_request` frames the fork has no UI to render — so
the bridge has to auto-reject every one of them. We get a chat but lose
half the agent.

In-process we own the `ExtensionUIContext` and can map each UI request to
inline keyboards / text replies natively. That's the v1 target after the
spike.

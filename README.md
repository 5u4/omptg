<div align="center">

# omptg

**Telegram bridge for [OMP](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent).**
One Bun process, one `AgentSession` per chat, every interactive surface mapped to native Telegram UI.

[Quick start](#quick-start) · [Commands](#commands) · [Configuration](#configuration) · [Production](#production-pm2)

</div>

---

## What it does

Bridges a Telegram chat to OMP's `AgentSession` SDK in-process — no `omp --mode rpc` subprocess, no JSON-RPC marshalling, full type access to the SDK.

- **Native UI mapping** 🎛️ — agent `confirm` / `select` / `input` / `editor` arrive as inline keyboards or text-reply prompts, not auto-rejected RPC frames
- **Streaming replies** ✍️ — throttled inline message edits as tokens arrive; per-tool status line (`📖 read foo.ts`, `💻 bash: …`, `❌ bash failed: …`)
- **Per-chat cwd binding** 📌 — pin any chat (or forum topic) to a project directory; persisted to `~/.omp-tg/chats.json`
- **Voice input** 🎙️ — voice / audio messages → ffmpeg → local whisper → confirm-before-send keyboard
- **Auth that fits group chats** 🔐 — allow-list by user id OR chat id; one user id covers DMs + every group you're in
- **Auto session titles** 🏷️ — OMP's `smol` role names sessions for `/sessions`

## Quick start

**Prerequisites:** [Bun](https://bun.sh) ≥ 1.3. For voice input also [`ffmpeg`](https://ffmpeg.org) and [`uv`](https://github.com/astral-sh/uv) (only consulted the first time a voice message arrives — skip if you won't speak to the bot).

**1. Create a bot.** Talk to [@BotFather](https://t.me/botfather), send `/newbot`, copy the token.

**2. Find your user id.** Talk to [@userinfobot](https://t.me/userinfobot) once.

**3. Boot it.**

```sh
bun install
cp .env.example .env
# fill TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_CHATS
bun start
```

DM the bot. `/start` shows the command list; `/whoami` prints the ids the bot sees you as.

**4. Pin it to a project.**

```
/bind ~/Workspaces/my-repo
```

Every agent turn in this chat now runs in that cwd. In a [forum topic](https://core.telegram.org/api/forum) the binding is scoped to that topic only.

## Commands

- `/new` — start a fresh session in the current chat
- `/sessions [n]` — list recent sessions (default 10)
- `/resume <n>` — resume session #n from `/sessions`
- `/cancel` — cancel the in-flight agent turn
- `/status` — active session id, cwd, model
- `/whoami` — Telegram ids the bot sees you as
- `/bind <path>` — pin this chat/topic to a cwd
- `/unbind` — remove the binding
- `/binding` — show current binding

Registered across `default` / `all_private_chats` / `all_group_chats` / `all_chat_administrators` scopes so they appear in Telegram's `/` menu everywhere.

## Configuration

All variables live in `.env` (auto-loaded by Bun). See [`.env.example`](./.env.example) for the full list with inline docs.

**Required:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHATS`.

**Optional:** `OMP_DEFAULT_CWD` · `OMP_TG_STT_MODEL` · `OMP_TG_STT_LANG` · `OMP_TG_LOG_RETAIN_DAYS` · `OMP_TG_LOG_COMPRESS_AFTER_DAYS`.

## Production (PM2)

`bun start` dies when your terminal closes. For real use, supervise with [PM2](https://pm2.keymetrics.io) — one config covers macOS launchd, Linux systemd, and Windows services.

```sh
bun install -g pm2          # or: brew install pm2 / npm i -g pm2

bun run pm2:start           # pm2 start ecosystem.config.cjs
pm2 save                    # remember the running set across reboots
pm2 startup                 # generate the OS autostart hook — run the printed sudo line once

bun run pm2:logs            # live tail
bun run pm2:restart         # apply code changes
bun run pm2:stop
```

After `save` + `startup`, the bot survives logouts, reboots, and its own crashes (auto-restart, capped at 10 restarts within 10s windows).

**Logs.** Structured JSONL in `logs/<date>.log` (one event per line, `jq`-friendly), rotated on each boot: gzipped after `OMP_TG_LOG_COMPRESS_AFTER_DAYS` (default 7), deleted after `OMP_TG_LOG_RETAIN_DAYS` (default 30). PM2's own `pm2-out.log` / `pm2-err.log` aren't managed by us — install [`pm2-logrotate`](https://github.com/keymetrics/pm2-logrotate) if you care.

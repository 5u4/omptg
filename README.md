<div align="center">

# omptg

**Bridge for [OMP](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent) on Telegram, Discord, and the local Web UI.**
One Bun process per transport, one `AgentSession` per chat, every interactive surface mapped to the native UI of each.

[Quick start](#quick-start) · [Commands](#commands) · [Configuration](#configuration) · [Production](#production-pm2)

</div>

---

## What it does

Bridges a Telegram chat to OMP's `AgentSession` SDK in-process — no `omp --mode rpc` subprocess, no JSON-RPC marshalling, full type access to the SDK.

- **Native UI mapping** 🎛️ — agent `confirm` / `select` / `input` / `editor` arrive as inline keyboards or text-reply prompts, not auto-rejected RPC frames
- **Streaming replies** ✍️ — throttled inline message edits as tokens arrive; per-tool status line (`📖 read foo.ts`, `💻 bash: …`, `❌ bash failed: …`)
- **Per-chat cwd binding** 📌 — pin any chat (or forum topic) to a project directory; persisted to `~/.omptg/chats.json`
- **Voice input** 🎙️ — voice / audio messages → ffmpeg → local whisper → confirm-before-send keyboard
- **Auth that fits group chats** 🔐 — allow-list by user id OR chat id; one user id covers DMs + every group you're in
- **Auto session titles** 🏷️ — OMP's `smol` role names sessions for `/sessions`

## Quick start

**Installing with an LLM agent?** Point it at [`install.md`](./install.md) — that file is written for autonomous execution (Mintlify [install.md](https://installmd.org/) format) and front-loads everything that doesn't need a human, leaving only the Telegram-bot creation step for you.

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
- `/sessions [n]` — list recent sessions (default 8)
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

**Optional:** `OMP_DEFAULT_CWD` · `OMPTG_STT_MODEL` · `OMPTG_STT_LANG` · `OMPTG_LOG_RETAIN_DAYS` · `OMPTG_LOG_COMPRESS_AFTER_DAYS`.

## Bridges

Three transports, three independent processes, one shared `~/.omptg/chats.json` for cwd bindings:

- **Telegram** (`bun start`, env `TELEGRAM_*`) — DM + group + forum-topic routing, voice input, MarkdownV2 with the in-house escaper. The original surface; everything else is modeled after it.
- **Discord** (`bun run start:discord`, env `DISCORD_*`) — one text channel ↔ one cwd, top-level messages auto-spawn a thread, each thread is an independent session. Slash commands register globally + per-dev-guild. See [Discord setup](#discord-setup) below.
- **Web** (`bun run start:web`) — local Svelte UI for hands-on use without a chat client; useful when you want copy-paste and code rendering without Telegram/Discord caps.

Each bridge namespaces its `ChatStore` keys (`tg:` / `dc:` / `web:`) so the three processes don't collide on the shared JSON file. Writes are reload-then-merge under atomic tmp-rename, so concurrent `/bind` calls from different bridges interleave safely: each process preserves entries written by the others between its load and its save.

## Discord setup

**1. Create the application.** [Discord developer portal](https://discord.com/developers/applications) → New Application → Bot → Reset Token. Paste into `DISCORD_BOT_TOKEN`.

**2. Enable intents.** Same page, "Privileged Gateway Intents":

- **MESSAGE CONTENT INTENT** — required, the bot can't read message text without it.

Non-privileged intents (`Guilds`, `GuildMessages`, `GuildMessageReactions`) are requested automatically at gateway login.

**3. Invite URL.** OAuth2 → URL Generator. Scopes: `bot`, `applications.commands`. Bot permissions: `View Channels`, `Send Messages`, `Send Messages in Threads`, `Create Public Threads`, `Read Message History`, `Add Reactions`, `Use Slash Commands`. The portal builds the URL — open it, pick a guild, authorize.

Equivalent permission bitfield for a hand-rolled URL: `311385197632` (`VIEW_CHANNEL` + `SEND_MESSAGES` + `SEND_MESSAGES_IN_THREADS` + `CREATE_PUBLIC_THREADS` + `READ_MESSAGE_HISTORY` + `ADD_REACTIONS` + `USE_APPLICATION_COMMANDS` — no `MANAGE_*` bits). Template:

```
https://discord.com/api/oauth2/authorize?client_id=<APP_ID>&permissions=311385197632&scope=bot%20applications.commands
```

**4. Configure & boot.**

```sh
# fill DISCORD_BOT_TOKEN at minimum; DISCORD_ALLOWED_GUILDS recommended.
# DISCORD_DEV_GUILDS = your test-server id → instant slash-command updates
# while iterating (global registration takes up to 1h to propagate).
bun run start:discord
```

Post any message in an allowed text channel — the bot auto-creates a thread, runs your prompt inside it, and every subsequent message in that thread routes to the same session. `/bind /abs/path` on the parent channel pins the cwd for every thread spawned underneath; `/bind` inside a specific thread overrides for that thread only.

## Production (PM2)

`bun start` dies when your terminal closes. For real use, supervise with [PM2](https://pm2.keymetrics.io) — one config covers macOS launchd, Linux systemd, and Windows services. The shipped `ecosystem.config.cjs` declares both `omptg` (Telegram) and `omptg-discord`; start whichever apply.

```sh
bun install -g pm2          # or: brew install pm2 / npm i -g pm2

bun run pm2:start           # pm2 start ecosystem.config.cjs (starts both apps)
pm2 save                    # remember the running set across reboots
pm2 startup                 # generate the OS autostart hook — run the printed sudo line once

pm2 logs                    # live tail of all apps
pm2 restart omptg           # apply code changes to Telegram only
pm2 restart omptg-discord   # ...or Discord only
pm2 stop omptg-discord      # don't want Discord supervised? stop + delete it
```

> **Upgrading from a pre-Phase-6 deployment?** PM2 log filenames now include the app name: `logs/pm2-out.log` → `logs/pm2-omptg-out.log` (and a new `pm2-omptg-discord-*.log` pair). The old files are orphaned, not deleted — `rm logs/pm2-{out,err}.log` once you've checked you don't need them.

After `save` + `startup`, the bots survive logouts, reboots, and their own crashes (auto-restart, capped at 10 restarts within 10s windows). Telegram and Discord run as separate processes so a gateway flake on one doesn't impact the other.

**Logs.** Structured JSONL in `logs/<date>.log` (one event per line, `jq`-friendly), rotated on each boot: gzipped after `OMPTG_LOG_COMPRESS_AFTER_DAYS` (default 7), deleted after `OMPTG_LOG_RETAIN_DAYS` (default 30). PM2's own `pm2-<app>-out.log` / `pm2-<app>-err.log` aren't managed by us — install [`pm2-logrotate`](https://github.com/keymetrics/pm2-logrotate) if you care.

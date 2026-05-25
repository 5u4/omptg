# omp-tg-sdk

Telegram bridge for OMP, built directly on the `@oh-my-pi/pi-coding-agent` SDK.

In-process: a single Bun process holds one `AgentSession` per Telegram chat,
with full type access to the SDK — no `omp --mode rpc` subprocess, no
JSON-RPC marshalling.

## What works

- Per-chat `AgentSession` with streaming text replies (throttled inline edits)
- `ExtensionUIContext` bridge: agent `confirm` / `select` / `input` / `editor`
  arrive as Telegram inline keyboards or text-reply prompts
- Tool-execution status line — `📖 read foo.ts`, `💻 bash: …`, `❌ bash failed: …`
- Persistent per-chat cwd binding (`~/.omp-tg/chats.json`)
- Auto-generated session titles (OMP's `smol`/`commit` role)
- Commands: `/new` `/sessions [n]` `/resume <n>` `/cancel` `/status`
  `/whoami` `/bind <path>` `/unbind` `/binding`
- Group chats: auth allows update if EITHER `from.id` OR `chat.id` is allow-listed
- Slash commands registered across `default` / `all_private_chats` /
  `all_group_chats` / `all_chat_administrators` scopes
- Voice input: `message:voice` / `:audio` → ffmpeg → local openai-whisper
  (auto-installed into an isolated `uv` venv at `~/.omp-tg/whisper-venv/`,
  model weights cached to `~/.omp-tg/whisper-models/`) → `[✅ send] [❌ cancel]`
  keyboard before dispatching; reply to the transcription message with a
  correction to override. Requires `ffmpeg` + [`uv`](https://github.com/astral-sh/uv).
  Tunables: `OMP_TG_STT_MODEL` (default `base`, try `small` for non-English),
  `OMP_TG_STT_LANG` (default `en`, or `auto` for whisper's language detector).

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.3 — `curl -fsSL https://bun.sh/install | bash`
- [`ffmpeg`](https://ffmpeg.org) — required for voice input. `brew install ffmpeg` / `apt install ffmpeg`.
- [`uv`](https://github.com/astral-sh/uv) — required for voice input (used to bootstrap an isolated whisper venv at `~/.omp-tg/whisper-venv/`). `brew install uv` / `curl -LsSf https://astral.sh/uv/install.sh | sh`.
- [PM2](https://pm2.keymetrics.io) — recommended for production. `bun install -g pm2`.

ffmpeg + uv are only consulted the first time a voice message arrives; if you don't plan to speak to the bot you can skip them.

## Quick start

### 1. Create the bot

Open Telegram, talk to [@BotFather](https://t.me/botfather):

```
/newbot
<pick a display name>
<pick a username ending in "bot">
```

BotFather replies with an HTTP API token that looks like
`123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ`. Keep it — that's `TELEGRAM_BOT_TOKEN`.

### 2. Find your user id

Talk to [@userinfobot](https://t.me/userinfobot) once. It replies with your
numeric Telegram user id (something like `1603972061`). That's the value
for `TELEGRAM_ALLOWED_CHATS` — the bot will refuse every other sender.

Putting **your user id** (not a chat id) here means you can DM the bot AND
use it in any group you're already a member of, without enumerating each
group separately. Add group ids (negative numbers) only when you want
*everyone* in that group to talk to the bot.

### 3. Boot it

```sh
bun install
cp .env.example .env
# fill TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_CHATS, save
bun start
```

DM the bot in Telegram. `/start` shows the full command list; `/whoami`
prints the ids the bot sees you as.

### 4. Pin it to a project

```
/bind ~/Workspaces/my-repo
```

Every agent turn in this chat now runs in that cwd. Use `/binding` to see
the current binding, `/unbind` to remove it. In a [forum topic](https://core.telegram.org/api/forum)
the binding is scoped to that topic only.

## Environment

All env vars live in `.env` (loaded by Bun automatically).

| Var | Required | Default | What it does |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | — | BotFather token |
| `TELEGRAM_ALLOWED_CHATS` | yes | — | Comma-separated user ids and/or chat ids permitted to talk to the bot |
| `OMP_DEFAULT_CWD` | no | `~/.omp-tg/` | cwd used when a chat has no `/bind`; auto-created if missing |
| `OMP_TG_STT_MODEL` | no | `base` | whisper model: `tiny` / `base` / `small` / `medium` / `large`. Avoid `*.en` unless you only speak English. |
| `OMP_TG_STT_LANG` | no | `en` | ISO language code, or `auto` for whisper's detector |
| `OMP_TG_LOG_RETAIN_DAYS` | no | `30` | Delete `logs/<date>.log{.gz}` older than this |
| `OMP_TG_LOG_COMPRESS_AFTER_DAYS` | no | `7` | gzip `logs/<date>.log` older than this |

## Production (PM2)

`bun start` dies the moment your terminal closes. For real use, supervise
the bot with [PM2](https://pm2.keymetrics.io) — one config covers macOS
launchd, Linux systemd, and Windows services.

```sh
bun install -g pm2     # or: brew install pm2 / npm i -g pm2

bun run pm2:start      # pm2 start ecosystem.config.cjs
pm2 save               # remember the running set across reboots
pm2 startup            # generate the OS-level autostart hook
                       # (writes a launchd plist on macOS, systemd unit on Linux)
# Run the printed sudo command exactly once.

bun run pm2:logs       # live tail (also see logs/<date>.log)
bun run pm2:restart    # apply code changes
bun run pm2:stop
pm2 delete omp-tg      # remove from PM2
```

After `pm2 save` + `pm2 startup`, the bot survives logouts, reboots, and
its own crashes (auto-restart, capped at 10 restarts within 10s windows
to avoid hammering on a bad commit).

## Layout

```
src/
  main.ts        ← grammY bot, command handlers, auth, scope registration
  chat.ts        ← ChatSession (per-chat AgentSession) + ChatRegistry
  chat-store.ts  ← ~/.omp-tg/chats.json (per-chat cwd binding)
  ui-bridge.ts   ← TelegramUI implements ExtensionUIContext
  streamer.ts    ← throttled telegram message edits
  tool-render.ts ← per-tool one-line status renderer
  logger.ts      ← structured JSONL → logs/<date>.log
  smoke*.ts      ← offline scenario checks (no telegram needed)
ecosystem.config.cjs ← PM2 process config
```

## Logs

- `logs/<date>.log` — structured JSONL (one event per line, flat fields).
  Generated by `src/logger.ts`; tail-friendly with `jq`.
- `logs/pm2-out.log`, `logs/pm2-err.log` — raw stdout/stderr captured by
  PM2 (`pm2 logs omp-tg` reads these).

### Rotation

- **Structured JSONL** (`logs/<date>.log`): rotated automatically on each
  boot. Files older than `OMP_TG_LOG_COMPRESS_AFTER_DAYS` (default 7)
  are gzipped in place; files older than `OMP_TG_LOG_RETAIN_DAYS`
  (default 30) are deleted. The active day's file is never touched.
- **PM2 stdout/stderr** (`logs/pm2-out.log` / `pm2-err.log`): not managed
  by us — install [`pm2-logrotate`](https://github.com/keymetrics/pm2-logrotate):
  ```sh
  pm2 install pm2-logrotate
  pm2 set pm2-logrotate:max_size 10M
  pm2 set pm2-logrotate:retain 14
  pm2 set pm2-logrotate:compress true
  ```

## Why this and not the python fork

`../omp-tg-bridge` was a fork of FreakySurgeon/claude-telegram-bridge with
its claude-CLI runner swapped for `omp --mode rpc`. It works for the basic
prompt loop, but every interactive surface (the agent's `ask` tool,
extension `confirm` / `select` / `input`, preview gates from `ast_edit`)
arrives as `extension_ui_request` frames the fork has no UI to render — so
the bridge has to auto-reject every one of them. We get a chat but lose
half the agent.

In-process we own the `ExtensionUIContext` and can map each UI request to
inline keyboards / text replies natively. That's what this codebase does.

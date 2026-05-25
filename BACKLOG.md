# omp-tg-sdk backlog

Pickup target for telegram-driven dogfooding. Each entry is small enough
to land in one session. Phases are loose — grab whatever feels useful.

## Conventions

- All paths relative to `omp-tg-sdk/` unless noted.
- Smokes live in `src/smoke-<topic>.ts`, runnable with `bun run src/smoke-<topic>.ts`.
- Restart the bot after code changes: `bun run pm2:restart`.
- Logs: structured `logs/<date>.log`, raw `logs/pm2-out.log` (`bun run pm2:logs`).
- Typecheck before commit: `bun run typecheck`.
- Commit style: short imperative subject + body. No co-author lines.

## Done so far (don't redo)

- per-chat AgentSession + ChatRegistry, streaming, throttled message edits
- ExtensionUIContext bridge (confirm/select/input/editor) → inline keyboards
- chat-scoped bindings (`~/.omp-tg/chats.json`, `/bind` `/unbind` `/whoami` `/binding`)
- `/new` `/sessions [n]` `/resume <n>` `/cancel` `/status`
- LLM-generated session titles via OMP's `generateSessionTitle`
- tool-execution visualization (`📖 read foo.ts`, `❌ bash failed: ...`)
- structured JSONL logger, crash hooks
- callback_query delivery (fire-and-forget agent turn so grammY can dispatch)
- auth allows from.id OR chat.id (groups Just Work without listing chat id)
- slash commands registered across 4 scopes; chat-scope overrides wiped on boot
- unknown command reply
- PM2 supervision + `ecosystem.config.cjs`

---

## Priority 1 — paper cuts you'll hit fast

### P1.1 — Markdown rendering for assistant replies

Right now `TelegramStreamer.flush()` calls `editMessageText(chat, id, text)`
with no `parse_mode`. Agent output uses ``` code blocks, `**bold**`,
`[link](url)`, but telegram shows raw markdown.

**Approach**: detect that the agent emits markdown (always true) and send
with `parse_mode: "MarkdownV2"`. Telegram MarkdownV2 escape rules are
strict — every `_ * [ ] ( ) ~ \` > # + - = | { } . !` outside code must be
backslash-escaped. Use a robust escaper; do NOT try to handwrite a regex.
Reference implementation: search `escapeMarkdown` in
`omp-tg-bridge/src/omp_telegram/markdown.py` (upstream python fork) or use
`telegramify-markdown` from npm.

**Watch out**: streaming deltas can split a ``` fence in half across two
edits, telegram will reject as "can't parse entities". Buffer at fence
boundaries before flushing. Falling back to plain text on parse error is OK.

**Files**: `src/streamer.ts` (add `parse_mode` + escape), maybe new
`src/markdown.ts` for the escaper. Smoke: `smoke-markdown.ts`.

### P1.2 — Long replies overflow telegram's 4096-char limit

Right now a single `editMessageText` past 4096 chars throws `MESSAGE_TOO_LONG`
and the whole reply gets lost. Need to chunk: keep editing the current
message up to ~4000 chars, then `sendMessage` a new one and continue
editing that.

**Files**: `src/streamer.ts`. Smoke: trigger via prompt
"Write a 200-line poem about debugging".

### P1.3 — Image input from telegram

You send a photo, agent uses vision. SDK already supports
`session.prompt(text, { images: [...] })`.

**Approach**:
- `bot.on("message:photo")` → pick the largest size, `bot.api.getFile`,
  download bytes
- caption (if any) is the prompt text; no caption → `"What do you see?"`
- pass `{ images: [{ data: base64, mimeType: "image/jpeg" }] }`

**Files**: `src/main.ts` (new handler), maybe a `src/media.ts` helper.
Look at `ImageContent` type in
`node_modules/@oh-my-pi/pi-coding-agent/dist/types/sdk.d.ts` for the
exact shape. Smoke: take a screenshot, send, agent describes.

---

## Priority 2 — capability gaps

### P2.1 — `/model` to switch models

`AgentSession.modelRegistry.getAvailable()` returns the list. Use
`session.setModel(model)` (verify name in agent-session.d.ts). UI: same
TelegramUI.select pattern we already use.

**Files**: `src/main.ts`. Register in `SLASH_COMMANDS`.

### P2.2 — `/compact` to compact current session context

OMP has `session.runIdleCompaction()` (or similar — check
`agent-session.d.ts`). Useful before context runs out on long sessions.

**Files**: `src/main.ts`. Register in `SLASH_COMMANDS`.

### P2.3 — `/retitle [new title]` to rename current session

`session.setSessionName(name, "user")`. With no arg, force-rerun
`generateSessionTitle` (regen).

### P2.4 — Voice input (whisper)

You send a voice note → transcribe → prompt as if typed.

**Approach**: `bot.on("message:voice")` → download → run whisper.cpp
binary OR send to OpenAI whisper API. Show the transcription to the user
with an inline `[✅ send] [✏️ edit] [❌ cancel]` keyboard before dispatching
(so misrecognition doesn't burn agent tokens).

Look at `omp-tg-bridge` for prior art if helpful.

---

## Priority 3 — bigger features (you originally wanted)

### P3.1 — Forum topics: one topic per session

Original requirement: a Telegram **forum group** where each topic
auto-creates a fresh session, optionally bound to its own cwd. Today
ChatRegistry is keyed by `chatId` alone.

**Approach**:
- key by `(chatId, thread_id)` instead of `chatId`
- detect forum topics via `message.message_thread_id` and
  `message.is_topic_message`
- when topic is created, auto-bind to a cwd (config? or first
  `/bind` in that topic?)
- pass `message_thread_id` on every `sendMessage` / `editMessageText`
  in that thread

Larger change (~100 lines + tests). Worth a proper plan before coding.

**References**: FreakySurgeon's `omp-tg-bridge/src/omp_telegram/topic.py`
(same idea, different runner).

### P3.2 — Multi-bot from one process

One bot per "persona" or per project, sharing the same code. Each bot
has its own token, allow-list, default cwd. Useful when you want
distinct telegram chats with the same backend but different scopes.

**Approach**: lift the `Bot` + `ChatRegistry` pair into a `BotInstance`
class, instantiate N of them based on `BOTS_CONFIG_PATH` env var
pointing at a yaml/json list. Each one polls independently.

### P3.3 — Web dashboard (low priority)

`aily`-style dashboard. Probably not worth it — telegram is already the
UI. Skip unless you find yourself wanting it.

---

## Priority 4 — hygiene

### P4.1 — log rotation

`logs/<date>.log` rotates daily by filename but never deletes old days.
`logs/pm2-out.log` and `logs/pm2-err.log` grow unbounded.

PM2 ships `pm2-logrotate`:
```sh
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 14
```
Document in README. Our own structured log: add a `compress + delete files
older than N days` pass on boot, or run via cron.

### P4.2 — Real unit tests

Right now we only have `smoke-*.ts` (integration). Bun has a built-in
`bun:test`. Worth covering:
- `tool-render.ts` (already pseudo-tested in smoke, formalize)
- `chat-store.ts` (atomic write, reload across instances)
- `ui-bridge.ts` `resolve()` matrix
- `parseCallback` round-trip

### P4.3 — README quickstart polish

Current README assumes you know what a telegram bot token looks like.
Add: link to @BotFather, screenshot of `/whoami` etc., link to a 30s
demo gif.

---

## Discoveries during dogfood (fill in as you hit them)

<!-- pickup-here -->
- (none yet)

---

## How to pick up from telegram

In a chat that's `/bind`-ed to `~/Workspaces/omp-tg/omp-tg-sdk`:

1. Tell the agent: "read BACKLOG.md and pick the smallest P1 item"
2. Let it propose a plan, approve via confirm button
3. After it commits: `bash bun run typecheck && bun run pm2:restart`
4. Test the change in another chat (or in the same one with `/new`)
5. If it works: ask agent to also append a line to "Discoveries" describing
   anything tricky it ran into

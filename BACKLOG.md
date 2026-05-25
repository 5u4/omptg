# omp-tg-sdk backlog

Pickup target for telegram-driven dogfooding. Each entry is small enough
to land in one session. Phases are loose — grab whatever feels useful.

## Conventions

- All paths relative to `omp-tg-sdk/` unless noted.
- Smokes live in `src/smoke-<topic>.ts`, runnable with `bun run src/smoke-<topic>.ts`.
- After code changes: commit first, then `bun run pm2:restart`. PM2 reads the
  on-disk source at restart time, so restarting before committing means the
  running bot and the commit can drift if you forget to restart again later.
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
- chunked streaming past 4096-char telegram limit (seals prior msg, opens new one)
- MarkdownV2 rendering for assistant replies (telegramify-markdown + fence-safe split)
- `/retitle [name]` — rename session or LLM-regen via title-generator
- image input via `message:photo` → base64 + ImageContent → session.prompt
- `/status` shows session title + context window % (tokens/window)
- `/model [id]` switches model — picker via TelegramUI.select or by id, `setModelTemporary` (does NOT persist to global settings)
- `/compact [instructions]` manually compacts context (refuses while streaming; auto-compaction handles in-flight overflow)
- `/resume` with no arg defaults to most recent session in cwd (independent of /sessions cache)
- bun:test coverage for `tool-render`, `chat-store`, `ui-bridge` (parseCallback + resolve matrix) — run with `bun test test/`
- forum topics: ChatRegistry keyed by `(chatId, threadId)`; per-topic cwd bindings (topic → group → default); `message_thread_id` routed on every send / edit / typing / UI prompt; General topic shares the group key for zero-migration
- voice input via `message:voice` / `message:audio` → ffmpeg → openai-whisper (local, via `@oh-my-pi/pi-coding-agent/stt`) → `[✅ send] [❌ cancel]` keyboard, with reply-to-transcription as the edit channel. `OMP_TG_STT_MODEL` (default `base`) and `OMP_TG_STT_LANG` (default `en`) tune the engine.


---



## Priority 2 — capability gaps



### ~~P2.4 — Voice input (whisper)~~  ✓ done


---

## Priority 3 — bigger features (you originally wanted)

### P3.1 — Topic auto-bind to cwd

Forum topics already get their own session + per-topic `/bind` (see
"Done so far"). Open question: when a brand-new topic is created,
should it auto-bind to a cwd instead of requiring an explicit `/bind`
in that topic?

**Options**:
- config file mapping `topic_name_regex → cwd`
- inherit the group binding until first `/bind` (current behavior —
  may already be enough)
- a `/bind` issued in General sets the default for new topics in
  that forum

Probably wait until the current behavior actually hurts before
designing this. **References**: FreakySurgeon's
`omp-tg-bridge/src/omp_telegram/topic.py`.

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


### P4.3 — README quickstart polish

Current README assumes you know what a telegram bot token looks like.
Add: link to @BotFather, screenshot of `/whoami` etc., link to a 30s
demo gif.

---

## Discoveries during dogfood (fill in as you hit them)

<!-- pickup-here -->
- P1.1 MarkdownV2: telegramify-markdown converts agent prose; chrome
  paths (tool/preamble/notice/(no response)) stay plain text so an
  errant escape can't break the heartbeat. Code fences are kept balanced
  per chunk by closing+reopening across boundaries — see
  `splitMarkdownForTelegram` in `src/markdown.ts`. On send failure
  (BadRequest entity parsing) we retry the same chunk as plain text so
  the user never gets nothing.
- P1.2 chunking: reserved 196 chars of headroom for the status tail so the
  tool-render line doesn't push the active message past 4096 mid-flush.
  Split prefers the last newline within budget but requires it to be ≥ half
  the budget to avoid stalling on a long line with one early newline.
  Status tail is cleared in finalize() so the last sealed message renders
  clean body only. Smoke: `bun run src/smoke-chunk.ts`.

---

## How to pick up from telegram

In a chat that's `/bind`-ed to `~/Workspaces/omp-tg/omp-tg-sdk`:

1. Tell the agent: "read BACKLOG.md and pick the smallest P1 item"
2. Let it propose a plan, approve via confirm button
3. After it commits: `bash bun run typecheck && bun run pm2:restart`
4. Test the change in another chat (or in the same one with `/new`)
5. If it works: ask agent to also append a line to "Discoveries" describing
   anything tricky it ran into

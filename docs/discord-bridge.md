# Discord Bridge — Implementation Phases

Goal: add Discord as a third transport for omptg, alongside Telegram and
the local Web UI. Sessions, persistence, slash-command logic, and the
agent runtime are shared; only the rendering/IO layer differs.

User model:
- One Discord **text channel** ↔ one **cwd** (same shape as Telegram
  group ↔ cwd; reuses `ChatStore` with channel snowflakes as keys).
- A top-level message in the channel triggers the bot to **auto-create a
  thread** off that message; all subsequent messages inside the thread
  route to a single `ChatSession` (one independent session per thread).
- A message posted directly inside an existing thread routes to that
  thread's session.

Non-goals (v1):
- DMs to the bot (channels only — keeps the cwd model simple).
- Voice messages / attachments other than images.
- Replacing Telegram or Web bridges — all three must keep working.
- Multi-guild slash-command management UI; register globally + per-guild
  on join, no admin panel.

Library: `discord.js` v14 (mature, types are good, slash + components +
threads + modals all first-class).

---

## Phase 0 — chatId type widening (refactor, zero behavior change)

**Outcome**: `chatId` is `string | number` throughout. Telegram path
serializes its numeric ids as before; Discord snowflakes (which exceed
`Number.MAX_SAFE_INTEGER`) pass through as strings without lossy casts.

Files changed:
- `src/chat.ts` — `ChatSession.chatId`, `ChatRegistry.get(chatId, threadId?)`,
  log scoping keys.
- `src/bridge/types.ts` — `Bridge.route(chatId, threadId?)` parameter.
- `src/bridge/telegram/index.ts` — accepts `string | number`, internally
  asserts numeric and coerces via `Number(...)`.
- `src/bridge/web/index.ts` — already mints synthetic `web:<n>` keys;
  unchanged except for the type signature.
- `src/handlers/turn.ts`, `src/handlers/*.ts` — propagate the wider type.
- `src/chat-store.ts` — key already stringified; verify and add a comment.

Acceptance:
- `bun test test/` green.
- `bun typecheck` green.
- Manual smoke: Telegram bot still binds/unbinds, runs a turn.

---

## Phase 1 — Hoist grammy out of `handlers/turn.ts`

**Outcome**: `handlers/turn.ts` no longer imports `grammy`. The "↪
steered" ack and the error-reply both go through `SessionTransport`.

Why: this is the last cross-bridge handler that pokes Telegram directly.
Once removed, every per-turn IO path is bridge-agnostic.

Files changed:
- `src/bridge/types.ts` — add to `SessionTransport`:
  ```ts
  /** Post a transient bridge-side system message (steered ack, fatal
   *  error). `replyTo` is bridge-opaque (telegram numeric, discord
   *  snowflake string); telegram threads it as reply_parameters and
   *  honors `silent` via `disable_notification`, web publishes a
   *  `notice` envelope and ignores both opts, discord posts a plain
   *  reply in the active thread. */
  postSystemMessage(text: string, opts?: { replyTo?: number | string; silent?: boolean }): Promise<void>;
  ```
  Same widening hits `newStreamer({ replyTo?: number | string })` for
  symmetry — Discord reply anchors are snowflake message ids.
- `src/bridge/telegram/index.ts` — implement using `bot.api.sendMessage`
  with the existing `reply_parameters` + topic-id + `disable_notification`
  wiring. The `route(chatId)` and `narrowReplyTo` boundary guards
  reject precision-losing snowflakes (`Number.isSafeInteger` + string
  round-trip check) so a future Discord caller misrouting an id throws
  instead of silently indexing into the wrong telegram chat.
- `src/bridge/web/index.ts` — publish a one-off `notice` event into the
  route ring buffer (already supported by the web protocol). `silent`
  is web-meaningless and dropped; per-level severity is a phase-5 nit.
- `src/handlers/turn.ts` — drop `Bot` import; replace both
  `bot.api.sendMessage(...)` calls with `chat.postSystemMessage(...)`,
  a thin forwarder on `ChatSession` so handlers can't reach into the
  transport surface (no rogue streamers, no mid-turn `dispose()`).
- `src/handlers/turn.ts` `TurnArgs` — drop `bot` field, widen
  `replyTo: number | string` (Discord prep).

Acceptance:
- `bun test test/` green.
- Telegram smoke: send two messages in quick succession, second gets the
  "↪ steered" ack; force an error (e.g. bad `/dir`), error bubble shows.

---

## Phase 2 — Discord bridge skeleton

**Outcome**: `DiscordBridge implements Bridge` exists with stubbed
streamer/UI/typing. `bun run src/discord-main.ts` connects to Discord,
logs `ready`, accepts a message in a channel, auto-creates a thread, and
echoes the message back. No agent wiring yet.

Files added:
- `src/bridge/discord/index.ts` — `DiscordBridge`, route key
  `${channelId}:${threadId ?? ""}`, `discordRouteKey` /
  `parseDiscordRoute` mirroring telegram bridge.
- `src/bridge/discord/streamer.ts` — `DiscordStreamer` stub: all methods
  no-op except `commitAssistant` which posts a single message.
- `src/bridge/discord/ui.ts` — `DiscordUI` stub: throws on any prompt.
- `src/bridge/discord/typing.ts` — `DiscordTyping` calling
  `channel.sendTyping()` every 8s while active.
- `src/discord-main.ts` — entry mirroring `main.ts`: env, ChatStore,
  bridge, registry, handlers, login.
- `src/handlers/discord/message.ts` — minimal: on `messageCreate`, if
  top-level channel message → `message.startThread({ name: <first 80
  chars> })`, route into registry; if inside thread → route directly.

Files changed:
- `src/bridge/types.ts` — `Bridge.kind` adds `"discord"`.
- `package.json` — add `discord.js@^14`, script `start:discord`.

Env (mirrors Telegram):
- `DISCORD_BOT_TOKEN` (required)
- `DISCORD_ALLOWED_GUILDS` (CSV, optional allowlist; same shape as
  `TELEGRAM_ALLOWED_CHATS`)
- `DISCORD_ALLOWED_CHANNELS` (CSV, optional; if set, only these channels
  accept top-level messages — defense for shared guilds)

Discord intents required:
- `Guilds`, `GuildMessages`, `MessageContent`, `GuildMessageReactions`.

Acceptance:
- Bot logs in, shows online.
- Posting "hello" in an allowed channel creates a thread named "hello"
  and the bot echoes "hello" inside the thread.
- Posting in an existing thread does NOT spawn a new thread.

---

## Phase 3 — `DiscordStreamer` (real rendering)

**Outcome**: agent turns render properly in Discord threads: tool
activity coalesced into a rolling "activity message", assistant replies
split at 2000 chars (Discord per-message cap) on safe boundaries.

Design choices (cribbed from `TelegramStreamer`, adapted):
- Discord supports **full markdown** (no MarkdownV2 escaping) and **code
  fences with language tags**. The system-prompt addendum reflects that
  — closer to the web bridge than telegram.
- **Activity message** model carries over verbatim: first muted event
  posts one message; subsequent events `message.edit()` the same id;
  caps `ACTIVITY_CHAR_CAP = 1800`, `ACTIVITY_LINE_CAP = 20` (under
  Discord's 2000 hard cap with headroom for emoji + the last appended
  line).
- `toolEnd` rewrites the original tool-start line via the saved
  `{messageId, lineIndex}` reference. Sealed messages remain editable
  for the channel's lifetime — no telegram-style 48h window.
- Assistant text splits at the last `\n` within budget; hard split at
  midpoint if no newline fits. Preserve fenced code blocks (split at
  fence boundaries when possible — port the splitter from
  `markdown.ts` and parameterize the cap to 2000).
- Debounce flushes at 250ms (same as telegram) — Discord rate-limits
  edits per channel; bursts of toolStart/toolEnd collapse into one
  `edit` round-trip.

Files added:
- `src/bridge/discord/markdown.ts` — `splitMarkdownForDiscord(text, cap = 2000)`,
  shares structure with `splitMarkdownForTelegram` but drops the V2
  escape pass. Extract a shared core if the duplication is non-trivial;
  otherwise keep parallel modules to avoid premature abstraction.

Files changed:
- `src/bridge/discord/streamer.ts` — full implementation.
- `src/bridge/discord/index.ts` — `DISCORD_SYSTEM_BLOCK` added,
  describing Discord-flavored markdown rules (emoji, mentions, code
  fences, 2000-char per-message cap so the model can plan splits).

Acceptance:
- New test `test/discord-streamer.test.ts` mirroring
  `test/streamer.test.ts`: cap splitting, activity-cap rollover,
  `toolEnd` rewriting both pre- and post-seal.
- Manual: run a turn that fires multiple tool calls + a long markdown
  reply with a code block; verify split points and no broken fences.

---

## Phase 4 — `DiscordUI` (interactive prompts)

**Outcome**: agent `ui.select` / `ui.confirm` / `ui.input` / `ui.editor`
work via Discord native components.

Mapping:
- `select` (≤25 options) → **Select Menu** (`StringSelectMenuBuilder`,
  Discord cap is exactly 25). >25 → fall back to paginated buttons,
  same trick as the telegram bridge but with action rows.
- `confirm` → **two Buttons** in one action row (Primary + Secondary,
  labels respect `confirmLabel` / `cancelLabel`).
- `input` (short) → **Modal** (`TextInputBuilder`, Short style). The
  modal is opened by the user clicking an "Answer" button we post
  alongside the prompt — Discord modals can only be opened in response
  to an interaction, not posted unilaterally.
- `editor` (long, multi-line) → **Modal** with Paragraph style; same
  "Answer" button trigger.
- Pending-request model identical to telegram: one slot per route, late
  taps reply with an ephemeral "expired" message via
  `interaction.reply({ ephemeral: true })`.

Files added:
- `src/handlers/discord/interaction.ts` — single `interactionCreate`
  handler routing button taps / select submits / modal submits to the
  per-route `DiscordUI.resolve(...)`.

Files changed:
- `src/bridge/discord/ui.ts` — full implementation. Custom-id encoding
  `omp:<requestId>:<value>` (mirrors `ompui:` prefix from telegram).
- `src/bridge/discord/index.ts` — register the interaction handler when
  the bridge mounts.

Acceptance:
- Test in a real channel: trigger an agent path that calls each of the
  four ui kinds (e.g. `/dir` confirmation, a permission prompt).
- All four resolve and the agent proceeds.
- Late tap (after a new turn supersedes) → ephemeral "expired" reply.

---

## Phase 5 — Slash commands + `/bind` model

**Outcome**: every slash command in `commands.ts` works under Discord.
The cwd-binding model parallels Telegram: `/bind /abs/path` on the
channel binds the channel; inside a thread, `/bind` binds the thread
(overrides channel binding).

Files added:
- `src/handlers/discord/commands.ts` — registers Discord slash commands
  from `SLASH_COMMANDS` (already a structured list in `commands.ts`),
  routes invocations through the existing dispatcher.
- `src/bridge/discord/registration.ts` — `registerSlashCommands(client,
  guildIds?)`. Guild-scoped registration (instant) when
  `DISCORD_DEV_GUILDS` is set; otherwise global (up to 1h propagation).

Files changed:
- `src/commands.ts` — extract the dispatcher (already largely
  bridge-agnostic) so it accepts a `CommandContext` shape both bridges
  can fill. If invasive, gate behind a small adapter in the discord
  handler instead.
- `src/chat-store.ts` — verify three-level resolution still applies
  (thread → channel → default); no logic change expected, just a
  comment noting Discord uses the same path.

Acceptance:
- `/help`, `/new`, `/dir`, `/bind`, `/sessions`, `/resume`, `/cancel`,
  `/model` all behave identically to Telegram in a thread.
- `/bind` on the parent channel sets the channel-level cwd; new threads
  in that channel inherit it.

---

## Phase 6 — Verification, docs, smoke

Files added:
- `scripts/discord-smoke.ts` — connect, post a message in a configured
  test channel, assert a thread is created and the bot replies inside
  it, then disconnect.
- `test/discord-route.test.ts` — pure unit tests for
  `discordRouteKey` / `parseDiscordRoute`.

Files changed:
- `README.md` — three-bridge matrix (Telegram, Web, Discord); env vars;
  intents to enable in the Discord developer portal.
- `install.md` — Discord bot setup walkthrough (create app, invite URL
  with correct scopes/permissions, env vars).
- `ecosystem.config.cjs` — optional second app entry for the Discord
  process so pm2 can run telegram + discord side-by-side.

Acceptance:
- `bun test test/` green.
- `bun typecheck` green.
- `scripts/discord-smoke.ts` green against a real test guild.
- All three bridges can run concurrently (separate processes; shared
  `~/.omptg/chats.json` — keyspaces don't collide because telegram ids
  are numeric strings and Discord snowflakes are also numeric strings
  but a different magnitude; document the namespacing risk and prefix
  Discord keys with `dc:` in `ChatStore` to be safe).

---

## Open questions (resolve before Phase 2)

1. **Threads namespace clash in `ChatStore`**: telegram `chat_id` and
   Discord `channel_id` are both numeric strings. Prefix Discord keys
   with `dc:` and telegram keys with `tg:` (migration: on read, treat
   bare-numeric keys as telegram). Decide before Phase 2 so the first
   `/bind` doesn't write an ambiguous key.
2. **One process or two?** Recommend two (`start` and `start:discord`)
   so a Discord gateway disconnect doesn't impact the Telegram poller.
   Web bridge already runs as a third process. ChatStore is safe for
   concurrent readers, single writer per chat-id — fine in practice
   because each process owns disjoint key prefixes after (1).
3. **Reply / quote semantics**: Discord's "reply" is a first-class
   message reference. Mirror `quote.ts`'s blockquote framing: when the
   user replies to a prior message inside the thread, prepend the
   quoted body as a markdown blockquote. Forwards: Discord doesn't have
   a forward primitive — skip the forward branch entirely.
4. **Image attachments**: Phase 2 sends a stub. Real image handling
   (download → cache → pass to agent as `ImageContent`) is a Phase 4.5;
   `media.ts` is already grammy-coupled, factor the cache layer out as
   part of that phase.

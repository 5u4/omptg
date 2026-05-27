# Web UI Bridge — Implementation Phases

Goal: add a local web UI as a second transport for omptg, alongside the
existing Telegram bridge. Sessions, persistence, and slash-command logic
are shared; only the rendering/IO layer differs.

Non-goals:
- Mobile / remote access (local-only, bind 127.0.0.1).
- Auth.
- Replacing Telegram bridge — both must keep working.

---

## Phase 1 — Bridge abstraction + Telegram wrap (refactor, zero new features)

**Outcome**: `ChatSession` no longer imports `grammy`, `TelegramUI`,
`TelegramStreamer`, or `TypingIndicator` directly. Telegram path behaves
identically; all existing tests pass.

Files added:
- `src/bridge/types.ts` — `Bridge`, `SessionTransport`, `Streamer`, `Typing`, `SessionRoute` interfaces.
- `src/bridge/telegram/index.ts` — `TelegramBridge implements Bridge`; constructs `TelegramUI` / `TelegramStreamer` / `TypingIndicator` per route.

Files changed:
- `src/chat.ts` — constructor takes `{ route, cwd, transport }` instead of `{ chatId, threadId, cwd, bot }`. Drop direct `Bot` / `TelegramUI` imports. Replace `new TelegramStreamer(...)` in `prompt()` with `this.transport.newStreamer(replyTo)` (Streamer factory on transport).
- `src/chat.ts` — `ChatRegistry` constructor takes `Bridge` instead of `Bot`; `get()` calls `bridge.open(route)`.
- `src/main.ts` — wrap bot in `new TelegramBridge(bot)` and pass to `ChatRegistry`.
- `src/handlers/*.ts`, `src/commands.ts` — anywhere reaching into `chat.ui` / `chat.resolvePending` stays the same (those methods stay on `ChatSession`, they just delegate to `transport.ui`).

Interfaces (final shape, not draft):
```ts
// src/bridge/types.ts
export interface SessionRoute { key: string; label: string; }

export interface Bridge {
  readonly kind: "telegram" | "web";
  /** Per-route system-prompt addendum (Telegram MarkdownV2 rules vs. web). */
  systemPromptAddendum(): string;
  /** Lazily build / fetch the transport for `route`. Idempotent. */
  open(route: SessionRoute): SessionTransport;
  dispose(): Promise<void>;
}

export interface SessionTransport {
  readonly ui: ExtensionUIContext;
  readonly typing: Typing;
  /** Build a fresh per-turn streamer. Telegram passes replyTo; web ignores. */
  newStreamer(opts: { replyTo?: number }): Streamer;
  dispose(): Promise<void>;
}

export interface Streamer {
  enqueue(task: () => Promise<void>): void;
  commitAssistant(text: string): Promise<void>;
  commitPreamble(text: string): Promise<void>;
  toolStart(toolCallId: string, line: string): Promise<void>;
  toolEnd(toolCallId: string, isError: boolean, errorLine?: string): Promise<void>;
  notice(line: string): Promise<void>;
  subagentLine(key: string, line: string): Promise<void>;
  subagentCollapse(keys: readonly string[]): void;
  finalize(): Promise<void>;
  replaceWith(text: string): Promise<void>;
}

export interface Typing { start(): void; stop(): void; }
```

`TelegramStreamer` already matches `Streamer` 1:1 (the methods were
copied from its current public surface) — wrap is trivial.

Decision points pre-baked:
- **system-prompt addendum**: extracted from `TELEGRAM_SYSTEM_BLOCK` in `chat.ts` and moved into `TelegramBridge.systemPromptAddendum()`. `withTelegramPrompt` becomes `withBridgePrompt(addendum, defaults)`.
- **Per-chat `bot.api.sendMessage` calls outside ChatSession** (e.g. `handlers/*.ts` posting acks): those stay on grammy directly — they're Telegram-handler-scoped, not ChatSession-scoped. No abstraction needed.

Verification:
- `bun test` — all existing tests green.
- `bun run smoke` if it exercises the telegram path.
- Manual: start the bot, send one message, verify reply + tool render unchanged.

---

## Phase 2 — Web bridge backend

**Outcome**: a second entry point (`bun src/web-main.ts`) brings up a
local HTTP + WebSocket server that exposes the same `ChatRegistry` /
`ChatStore` over a web protocol. No frontend yet; verified with `wscat`
or a one-page test harness.

Files added:
- `src/bridge/web/index.ts` — `WebBridge implements Bridge`; maintains `Map<routeKey, WebSessionTransport>`, broadcasts to subscribers.
- `src/bridge/web/streamer.ts` — `WebStreamer implements Streamer`; methods serialize structured events and push to subscribers. No Telegram-style coalescing — web frontend can handle the firehose.
- `src/bridge/web/ui.ts` — `WebUI implements ExtensionUIContext`; `select/confirm/input/editor` post a `ui.request` to subscribers and `await` matching `ui.response`.
- `src/bridge/web/typing.ts` — `WebTyping`; emits `turn.active` events; no setInterval needed (web frontend has its own pulse).
- `src/bridge/web/server.ts` — `Bun.serve({ fetch, websocket })`. HTTP routes for static + session list; WebSocket for the live event stream.
- `src/bridge/web/protocol.ts` — TypeScript types for every envelope (`session.list`, `session.event`, `session.assistant`, `ui.request`, `ui.response`, `session.send`, `session.open`, `session.abort`, `session.subscribe`).
- `src/web-main.ts` — entry: build `WebBridge`, `ChatStore`, `ChatRegistry(bridge, cwd, store)`, install hooks (`installProcessHooks` reused — already bridge-agnostic after Phase 1's `Deps` cleanup).
- `~/.omptg/web-sessions.json` (runtime artifact, not in repo) — `{ routeKey: { sessionFile, title, lastActivity } }` so restarts repopulate the session list.

Files changed:
- `src/deps.ts` — `Deps.bot` becomes optional (only telegram path uses it); add `Deps.bridge: Bridge` and `Deps.registry` (already there).
- `src/chat.ts` — `WebSessionEvent` type emitted by `ChatSession.handleEvent` becomes a passthrough: instead of consuming events into the streamer only, also publish the raw `AgentSessionEvent` via the transport so web subscribers get structured data, not pre-rendered strings. **This is the one cross-cutting change after Phase 1** — gated behind `transport.publishEvent?.(ev)` so telegram path is a no-op.
- `src/boot.ts` — `installProcessHooks` already calls `registry.disposeAll()`; just teach it to skip `bot.stop()` when `deps.bot` is undefined.

Wire protocol (final):
```ts
// Server → Client
type ServerMsg =
  | { type: "session.list"; sessions: SessionSummary[] }
  | { type: "session.event"; key: string; event: AgentSessionEvent }
  | { type: "session.assistant"; key: string; text: string }
  | { type: "session.turn"; key: string; active: boolean }
  | { type: "session.title"; key: string; title: string }
  | { type: "ui.request"; key: string; reqId: string; req: UiRequest }
  | { type: "ui.cancel"; key: string; reqId: string };

// Client → Server
type ClientMsg =
  | { type: "session.open"; cwd?: string; resume?: string }
  | { type: "session.send"; key: string; text: string }
  | { type: "session.abort"; key: string }
  | { type: "session.subscribe"; keys: string[] }   // tab focus
  | { type: "session.close"; key: string }          // dispose session
  | { type: "ui.response"; key: string; reqId: string; value: unknown };

interface SessionSummary {
  key: string; title: string; cwd: string;
  modelId?: string; lastActivity: number; turnActive: boolean;
}

type UiRequest =
  | { kind: "select"; title: string; options: string[] }
  | { kind: "confirm"; title: string; message: string }
  | { kind: "input"; title: string; placeholder?: string }
  | { kind: "editor"; title: string; prefill?: string };
```

Route key scheme: web sessions use `web:<n>` keys (n monotonic). Stored
in `~/.omptg/web-sessions.json` so server restart restores the same
keys → same `ChatStore` cwd bindings.

Verification:
- Unit test `src/bridge/web/streamer.test.ts` — Streamer methods produce the right envelopes.
- Integration test with two ws clients: subscribe to same session, both receive every event in order.
- `wscat` smoke: open → send → observe events → ui.request flow with a manual select call.
- Telegram path still green (Phase 1 tests re-run).

---

## Phase 3 — Frontend SPA

**Outcome**: open `http://localhost:7878` in a browser, see session list
left, message stream right. Can create / resume / send to sessions.

Files added under `src/bridge/web/static/`:
- `index.html` — empty shell + module script.
- `app.js` — ESM module: ws client, render loop, state store. Vanilla JS, no framework.
- `style.css` — minimal, dark theme by default, mobile-readable (you might glance from a phone on the same wifi).
- `markdown.js` — small wrapper. **Reuse `src/markdown.ts` logic where possible**, but the Telegram MarkdownV2 converter is irrelevant — frontend renders full markdown via a tiny lib (suggested: `marked` from CDN, or vendored).

Rendering rules (event-type → UI):
- `text_delta` / final assistant text → markdown block, code-highlighted.
- `tool_execution_start/end` → collapsible card: header `<emoji> <tool> <one-line-args>`, body shows full args/result on expand. Reuse `renderToolStart`/`renderToolEnd` for the header line; the bodies are JSON-pretty-printed.
- `task` tool → nested card with per-subagent progress rows (drive from `task:subagent:progress` events, same data the Telegram subagentLine renders).
- `notice` / `auto_retry_start` → inline pill.
- `ui.request` → inline form rendered between messages, blocks the input box until answered or cancelled.

UX features:
- Left rail: session cards with title, cwd basename, "active" pulse, unread badge.
- Window title: `(N) omptg — <current title>` where N = total unread.
- Keyboard: `⌘K` (or `Ctrl+K`) opens session picker; `⌘N` new session; `Esc` aborts active turn.
- Reconnect: on ws drop, exponential backoff, replay-from-store on reconnect (server keeps last 200 events per session in memory ring buffer).

Verification:
- Manual: drive a real session end-to-end, confirm tool cards render, confirm `ui.request` (e.g. a `select` from a tool) works.
- Resize to phone width — list collapses to drawer.
- Restart server → reload page → session list still populated, can resume any.

---

## Phase 4 — Polish + parity gaps

Only items actually needed after dogfooding Phase 3. Candidates (decide
after using it):
- Voice input (reuse `voice.ts` — whisper already local).
- Image paste/upload (reuse `media.ts`).
- `/compact`, `/model`, `/resume` slash commands in the web input (parse client-side, dispatch as control messages, OR mirror Telegram's `commands.ts` registry).
- Multi-cwd quick switcher.
- Session export (call existing omp `--export` machinery).

---

## Out of scope (explicitly)

- Multi-user / auth.
- Remote access via tunnel / reverse proxy.
- Replacing Telegram entirely.
- Mobile-first design (responsive, not native-feeling).
- Notification sounds / desktop notifications (could add in Phase 4 if missed).

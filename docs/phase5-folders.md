> **Status: shipped.** This document is the spec-as-shipped, edited
> after implementation to match. Deviations from the original plan:
> - No cwd-uniqueness enforcement (multiple folders may share a cwd;
>   ungrouped sessions may share a cwd with a folder).
> - No `folder.delete` / `folder.removed` (no protocol message, no
>   bridge method, no UI). `folderId` is therefore immutable
>   post-create.
> - No toast infrastructure; server `error` envelopes for
>   `folder.create` surface only as `console.warn` — tracked for a
>   later UX phase.
>
> Out-of-scope deferrals from the original plan stay deferred:
> nested folders, drag-drop reassignment, server-side collapse state,
> folder-level settings.

# Phase 5 — Folders MVP

Goal: group web sessions into user-named **folders**, each pinned 1:1 to
a working directory. Folder = workspace; opening a new session inside a
folder reuses that folder's `cwd` and auto-files the session under it.

Non-goals (out of scope for this phase):
- Nested / hierarchical folders.
- Drag-and-drop reassignment of existing sessions across folders.
- Server-side persisted collapse state (frontend `localStorage` only).
- Folder-level settings (model, system prompt, etc.).
- Sharing folder state across devices.

---

## 1. Data model

Folder is a thin pointer record. Sessions still own their `cwd`; folder
just gives the rail a grouping key.

```ts
// src/bridge/web/protocol.ts — additions

export interface FolderSummary {
  id: string;          // "f:<n>", monotonic
  name: string;        // user-supplied; trimmed; non-empty; length ≤ 80
  cwd: string;         // canonicalized absolute path (NOT unique across folders)
  createdAt: number;
}

// SessionSummary gains:
//   folderId?: string;   // undefined = ungrouped
```

Persistence: extend `PersistedState` in `src/bridge/web/index.ts` to
`version: 2`, add `folders: PersistedFolder[]` and
`PersistedSession.folderId?: string`. Loader migrates v1 → v2 by
defaulting `folderId = undefined` (i.e. all existing sessions land in
Ungrouped on first load, per agreement).

Invariants enforced server-side:
- `folder.cwd` is canonicalized via existing `canonicalize()` and
  validated against `allowedCwdPrefixes` (same guard as
  `session.open`). Folder records always store the canonical path.
- `folder.name` trimmed, non-empty, length ≤ 80. Duplicate names are
  allowed. **cwd uniqueness is NOT enforced** — folders are pure UI
  grouping labels; multiple folders may point at the same canonical
  cwd.
- `folder.create` / `folder.rename` defensively coerce `name` to a
  string before trimming; a malformed wire payload (`name: undefined`)
  returns an `error` envelope instead of throwing.
- No `folder.delete`. `folderId` on a session is set on creation and
  never reassigned in this phase.

---

## 2. Wire protocol (additions)

Server → Client (additions to `ServerMsg`):
```ts
| { type: "folder.list"; folders: FolderSummary[] }
| { type: "folder.created"; folder: FolderSummary }
| { type: "folder.updated"; id: string; patch: Partial<Pick<FolderSummary, "name">> }
```

Client → Server (additions to `ClientMsg`):
```ts
| { type: "folder.create"; name: string; cwd: string }
| { type: "folder.rename"; id: string; name: string }
| { type: "session.open"; cwd?: string; folderId?: string }   // existing, extended
```

Behavior of `session.open`:
- `folderId` set → server resolves the folder, uses `folder.cwd`
  unconditionally (any client-supplied `cwd` is ignored for safety;
  log if mismatched), tags new session with `folderId`.
- `folderId` absent → ungrouped; `cwd` resolves as today (falls back
  to `defaultCwd`).

Initial handshake: server emits `folder.list` once, immediately before
the existing `session.list`. No backfill / ring buffer needed for
folders (state is small, push every change).

`session.created` carries the final `folderId` (folder branch sets it
via `bridge.patchSession`). `session.updated` does not currently move
sessions between folders.

---

## 3. Backend changes

`src/bridge/web/index.ts`:
- `private folders: Map<string, PersistedFolder>` and
  `private nextFolderId: number`.
- Public methods: `listFolders()`, `folderCwd(id)`,
  `createFolder({name, cwd})`, `renameFolder(id, name)`. Each mutator
  validates input, mutates state, schedules persist, broadcasts the
  matching `folder.*` envelope to all subscribers.
- `PersistedState` bumped to `version: 2` with `folders` +
  `nextFolderId` fields and an optional `folderId` on
  `PersistedSession`. `loadState` migrates `version: 1` files in
  place (sessions land in Ungrouped, no folders, `nextFolderId = 1`).
- `loadState` reconciles `nextFolderId` against existing folder ids
  via `reconcileNext()`: a hand-edited or partially-restored state
  file with `nextFolderId: 1` and existing `f:5` still mints `f:6`
  next, preventing silent Map overwrite. Same helper is available for
  future use on `nextId`.
- `WebBridgeOptions` unchanged (folders share `allowedCwdPrefixes`).

`src/bridge/web/server.ts`:
- Dispatches `folder.create` (cwd routed through `resolveCwd` before
  reaching the bridge) and `folder.rename`.
- `session.open` handler: when `folderId` is set, resolves the folder,
  re-validates `folder.cwd` via `resolveCwd` (so a deleted/moved
  directory surfaces a clean error), and tags the session with the
  folder id. Any client-supplied `cwd` is ignored; a mismatch is
  logged at info level for debugging.
- Handshake emits `folder.list` immediately before `session.list` so
  the client has grouping metadata in hand before any
  `session.created` / `session.list` envelope references a `folderId`.

No changes outside `src/bridge/web/`. `ChatSession`, telegram bridge,
core types untouched.

---

## 4. Frontend

New types in `src/bridge/web/frontend/src/lib/store/index.svelte.ts`:
- `Folder = FolderSummary` (re-exported).
- `Store.folders = $state<Folder[]>([])`.
- `Store.collapsed = $state<Set<string>>(loadCollapsed())` — read
  from `localStorage["omptg:foldersCollapsed"]` on construction;
  `toggleFolder()` persists via `saveCollapsed()` on every mutation.
- `groupedSessions = $derived(...)` returns `{ byFolder: Map<id,
  Session[]>, ungrouped: Session[] }`. Sessions whose `folderId`
  references an unknown folder fall into `ungrouped` so an orphan is
  never invisible.
- `openNewSession({folderId?, cwd?})`, `createFolder(name, cwd)`,
  `renameFolder(id, name)`, `toggleFolder(id)`, all dispatched via
  `send`.

New components under `src/bridge/web/frontend/src/lib/components/`:
- **`FolderGroup.svelte`** — header (chevron, name, cwd basename,
  count) + collapsible body rendering `SessionItem`s. Inline `+`
  and `✎` buttons appear on hover → `openNewSession({folderId})` and
  rename dialog. No delete affordance in this phase.
- **`NewFolderDialog.svelte`** — dual-mode modal: `mode="folder"`
  collects name + cwd (→ `folder.create`); `mode="cwd"` collects only
  cwd (→ `session.open` for a new ungrouped session). Closes
  optimistically on submit; server-side failures (e.g. cwd outside
  allowlist) currently only `console.warn` — see status banner.
- **`RenameFolderDialog.svelte`** — single text field; same modal
  shell.

Updated components:
- **`Rail.svelte`** — replaces the flat `{#each store.sessions}`
  block with:
  - Two top buttons: `+ session` (opens `NewFolderDialog` in
    `mode="cwd"`) and `+ folder` (opens it in `mode="folder"`).
  - `{#each store.folders}` → `<FolderGroup>`.
  - Ungrouped sessions render in a bare section below; the
    "Ungrouped" label is shown only when at least one folder exists
    (avoids a redundant label on fresh state). The section itself is
    hidden when empty.
- **`SessionItem.svelte`** — no structural change; nested under
  `FolderGroup` it just inherits indent from the parent.
- **`Pane.svelte`** — one-line change: wraps `openNewSession` so the
  click handler doesn't pass a `MouseEvent` into the new optional
  opts arg.

Modal shell: minimal — overlay + card; reuse `Button`, no new
shadcn-style primitive needed unless it grows. (Phase 4 didn't ship a
Dialog primitive.)

---

## 5. Tests

Backend (`test/web-folders.test.ts`, new):
- create folder → broadcast + persisted, trims name, rejects empty /
  overlong.
- multiple folders on the same cwd are allowed (cwd uniqueness
  deliberately not enforced).
- rename → broadcast + state mutation; rejects unknown id / empty /
  overlong.
- `listFolders` ascending by `createdAt`, ties broken by id.
- `folderCwd(id)` returns recorded cwd / undefined.
- `patchSession({folderId})` carries `folderId` in `session.updated`.
- restart: folders + `nextFolderId` survive disk roundtrip.
- v1 → v2 state file migration: sessions land in Ungrouped, fresh
  folder mints from `f:1`.

Backend (`test/web-bridge.test.ts`, additive):
- handshake order: `folder.list` arrives before `session.list` over a
  real ws connection.

End-to-end (`scripts/phase5-walk.ts`, new — not in `bun test`):
- Headless ws walkthrough covering handshake order, folder create,
  `session.open` with `folderId` overriding a junk client cwd, rename,
  persistence across restart, and v1 → v2 migration. 18 assertions;
  run with `bun scripts/phase5-walk.ts`.

Frontend: no new test runner yet on the Svelte side; verify by
existing `bun run smoke` plus manual checklist (Phase 5 §7).

---

## 6. File map

Touched / added:
```
docs/phase5-folders.md                              (this doc, new)
src/bridge/web/protocol.ts                          (additions)
src/bridge/web/index.ts                             (folder CRUD, v2 schema)
src/bridge/web/server.ts                            (dispatch new msgs)
src/bridge/web/frontend/src/lib/store/index.svelte.ts (folder state)
src/bridge/web/frontend/src/lib/components/Rail.svelte
src/bridge/web/frontend/src/lib/components/NewFolderDialog.svelte (new)
src/bridge/web/frontend/src/lib/components/RenameFolderDialog.svelte (new)
src/bridge/web/frontend/src/lib/components/Pane.svelte           (one-line)
test/web-folders.test.ts                                          (new)
test/web-bridge.test.ts                                           (additive)
scripts/phase5-walk.ts                                            (new)
```

No changes to `src/chat.ts`, `src/main.ts`, telegram bridge, voice,
markdown, streamer.


## 6.1 Conventions

- **Folder ordering**: fixed ascending by `createdAt`, ties broken by
  folder id. No manual reorder in this phase.
- **Delete**: not shipped. `folderId` is therefore immutable for the
  lifetime of a session.
---

## 7. Verification

- `bun test` — 208 pass / 0 fail. Folder suite + handshake order test
  live in `test/web-folders.test.ts` and `test/web-bridge.test.ts`.
- `bun run typecheck` — clean (svelte-check emits a11y/state-init
  warnings on the two new dialog components; non-fatal, not
  suppressed).
- `bun run build:web` — vite build clean.
- `bun scripts/phase5-walk.ts` — 18/18 assertions pass.
- Manual checklist exercised by the walk script above; remaining
  browser-only checks:
  1. Fresh state file → only Ungrouped, `+ session` → cwd picker
     → session lands in Ungrouped.
  2. `+ folder` → name + cwd → folder appears, empty.
  3. `+` inside folder → new session nested inside the folder group.
  4. Rename folder → header updates everywhere.
  5. Restart server → folders + sessions restored, association
     intact.
  6. Collapse a folder → reload page → still collapsed.
  7. Existing v1 state file → sessions visible in Ungrouped, no
     folders.

---

## 8. Risks / open items

- **Modal infra**: phase 4 didn't ship a dialog primitive. Building a
  one-off overlay is fine for now; promote to a `Dialog.svelte` if a
  later phase grows more modals.
- **Cwd picker UX**: a plain text input is the MVP. A future picker
  (recent dirs, fs autocomplete) is out of scope.
- **Server error feedback**: no toast yet — `folder.create` with a
  denied cwd silently closes the dialog. Track for a later UX pass.
- **Race on rapid create**: `nextFolderId` increments synchronously
  before disk write — same model as session ids, acceptable.
- **Migration rollback**: if a v2 state file is opened by a v1 binary,
  it'll fail to parse. Acceptable (local-only, single user).

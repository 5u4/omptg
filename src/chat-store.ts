/**
 * Per-chat configuration store at `~/.omptg/chats.json`.
 *
 *   {
 *     "chats": {
 *       "<bridge>:<chat_id>": {
 *         "cwd": "/abs/path",
 *         "label?": "...",
 *         "added_at": "ISO",
 *         "topics?": {
 *           "<thread_id>": { "cwd": "...", "label?": "...", "added_at": "ISO" }
 *         }
 *       }
 *     }
 *   }
 *
 * Three-level cwd resolution: topic binding → group binding → default.
 * This file owns the first two; `resolveCwd` returns undefined when
 * nothing is bound at either level. The "default" third step lives in
 * `ChatRegistry.cwdFor`, which knows the bridge-supplied fallback and
 * substitutes it for the undefined return.
 * Forum topics / Discord threads are addressed by their bridge-native
 * id stringified (Telegram: `message_thread_id`; Discord: thread
 * snowflake). Telegram's "General" topic and non-forum supergroups are
 * keyed without a topic (threadId = undefined).
 *
 * Keys are namespaced by bridge (`tg:`, `dc:`, `web:`) so a numeric
 * Telegram chat id can't collide with a same-looking Discord snowflake
 * inside the shared file. Callers do NOT build the prefix themselves —
 * they pass raw ids into `ChatRegistry`, which delegates to
 * `Bridge.bindingKey(chatId)` to produce the prefixed key. ChatStore
 * itself is bridge-blind and just stores opaque string keys.
 *
 * Migration: files written before namespacing landed had bare numeric
 * keys (Telegram was the only bridge that ever wrote bindings). On
 * load, bare-numeric keys (`^-?\d+$`) are rewritten as `tg:<id>` and
 * the file is persisted once. Already-prefixed keys are left alone;
 * non-numeric, non-prefixed keys (operator hand-edits, unknown future
 * schemes) pass through verbatim so we don't lose data we don't yet
 * understand. Idempotent: a fully-prefixed file makes no changes.
 *
 * Reads are cached in memory; writes go through `mkdir -p` + atomic
 * tmp-rename so a crash mid-write can't corrupt the file.
 */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve as resolvePath } from "node:path";

export interface TopicBinding {
	/** May be `null` when a session-pin-only topic exists with no
	 *  explicit `/bind` cwd. Topic resolution then falls through to
	 *  the group / default cwd, matching the un-pinned behavior. */
	cwd: string | null;
	label?: string;
	added_at: string;
	/** Pinned OMP session id for this thread. Set by bridges that want
	 *  a thread to keep resuming the *same* session across bot restarts
	 *  (Discord — every thread is one conversation; without pinning, all
	 *  threads in the same cwd would auto-resume to whichever session
	 *  happens to be newest on disk). Repointed by `ChatSession.attach()`
	 *  on every fresh / resumed / auto-resumed session (so `/new`,
	 *  `/resume`, and successful pin-hit cold-starts all keep it in
	 *  sync). Absent for Telegram-style bindings where cwd-level
	 *  newest-wins resume is the desired UX. */
	sessionId?: string;
}

export interface ChatBinding {
	/** May be `null` after a group-level `/unbind` on a chat that still
	 *  has topic bindings — the entry survives so topics resolve, but
	 *  group resolution falls through to the default. */
	cwd: string | null;
	label?: string;
	added_at: string;
	topics?: Record<string, TopicBinding>;
}

interface ChatStoreFile {
	chats: Record<string, ChatBinding>;
}

const DEFAULT_PATH = resolvePath(homedir(), ".omptg", "chats.json");

/** Bridge prefixes recognized at load time. Anything else (i.e. a
 *  bare numeric key from before namespacing) is migrated to `tg:`. */
const KNOWN_PREFIXES = ["tg:", "dc:", "web:"] as const;

function hasKnownPrefix(key: string): boolean {
	for (const p of KNOWN_PREFIXES) if (key.startsWith(p)) return true;
	return false;
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return resolvePath(homedir(), path.slice(2));
	return path;
}

export class ChatStore {
	private data: ChatStoreFile;
	/** Keys this process has mutated (set / delete / setTopic /
	 *  deleteTopic / migration) and therefore owns on the next save.
	 *  Untouched keys are re-read fresh from disk every save, so a
	 *  concurrent process updating an existing key isn't clobbered by
	 *  our stale in-memory copy.
	 *
	 *  Cleared after each successful save: subsequent writes restart
	 *  the dirty set, so the next save again starts from the latest
	 *  disk snapshot. */
	private dirtyKeys = new Set<string>();
	/** Keys this process has deliberately removed (delete / deleteTopic
	 *  that cleared the whole chat / migration retiring a bare-numeric
	 *  key). Suppressed in the save-time disk merge so a concurrent
	 *  reader writing back its stale snapshot can't undo our /unbind.
	 *  Process-local and persists for the lifetime of this instance. */
	private tombstones = new Set<string>();

	constructor(private readonly path: string = DEFAULT_PATH) {
		this.data = this.load();
	}

	private load(): ChatStoreFile {
		if (!existsSync(this.path)) return { chats: {} };
		try {
			const raw = readFileSync(this.path, "utf8");
			const parsed = JSON.parse(raw) as ChatStoreFile;
			if (!parsed || typeof parsed !== "object"
				|| !parsed.chats || typeof parsed.chats !== "object" || Array.isArray(parsed.chats)
			) {
				return { chats: {} };
			}
			return this.migrate(parsed);
		} catch {
			// Corrupt file: don't overwrite, but don't crash either. Start
			// empty in memory; next save will replace it.
			return { chats: {} };
		}
	}

	/** Rewrite bare-numeric legacy keys (Telegram was the only bridge
	 *  that ever wrote bindings before namespacing landed) as `tg:<id>`.
	 *  Non-numeric, non-prefixed keys are left untouched — they might
	 *  be operator hand-edits or a future bridge scheme we don't
	 *  recognize yet, and silently rebranding them as Telegram would
	 *  be lossy. Idempotent: a fully-prefixed file makes no changes
	 *  and skips the save. */
	private migrate(parsed: ChatStoreFile): ChatStoreFile {
		let mutated = false;
		const next: Record<string, ChatBinding> = {};
		for (const [k, v] of Object.entries(parsed.chats)) {
			if (hasKnownPrefix(k)) {
				next[k] = v;
				continue;
			}
			if (!/^-?\d+$/.test(k)) {
				// Unrecognized non-numeric key. Keep verbatim so we don't
				// destroy unknown data; nothing in the new API reads it.
				next[k] = v;
				continue;
			}
			const migrated = `tg:${k}`;
			// Tombstone the bare key either way — it's been retired.
			this.tombstones.add(k);
			mutated = true;
			// Collision: a `tg:<id>` already exists alongside the bare
			// `<id>`. The prefixed entry wins (it was written by a newer
			// code path); the bare entry is dropped.
			if (next[migrated] !== undefined || parsed.chats[migrated] !== undefined) {
				continue;
			}
			next[migrated] = v;
			this.dirtyKeys.add(migrated);
		}
		if (mutated) {
			this.data = { chats: next };
			try { this.save(); } catch {
				// Migration save best-effort: in-memory state is correct
				// either way; the next successful write rewrites the file.
			}
			return this.data;
		}
		return { chats: next };
	}


	/** Atomic write-through with cross-process awareness. Conflict model:
	 *
	 *   - Start from the latest on-disk snapshot (the source of truth
	 *     for anything we haven't touched).
	 *   - Overlay only `dirtyKeys` from in-memory `this.data` — these
	 *     are the keys this process actually mutated since the last
	 *     save and therefore owns.
	 *   - Apply `tombstones` as deletions so a stale writeback by
	 *     another process can't resurrect a key we removed.
	 *
	 *  In practice each bridge owns a disjoint key prefix (`tg:`/`dc:`/
	 *  `web:`) so cross-process writes to the same key don't happen.
	 *  The dirty model still matters for the entries a process reads
	 *  from another bridge's prefix at boot: without it, an unrelated
	 *  /bind here would write our stale copy back over the other
	 *  bridge's fresh update.
	 *
	 *  Dirty/tombstone sets are cleared after a successful save so the
	 *  next save again starts from the latest disk snapshot — without
	 *  this, a key written once would stay "owned" forever and the
	 *  cross-process freshness for that key would be lost. */
	private save(): void {
		mkdirSync(dirname(this.path), { recursive: true });
		const merged = this.readDisk()?.chats ?? {};
		for (const k of this.dirtyKeys) {
			const local = this.data.chats[k];
			if (local !== undefined) merged[k] = local;
		}
		for (const k of this.tombstones) {
			delete merged[k];
		}
		const tmp = `${this.path}.tmp.${process.pid}`;
		writeFileSync(tmp, `${JSON.stringify({ chats: merged }, null, 2)}\n`, {
			mode: 0o600,
		});
		renameSync(tmp, this.path);
		// Sync in-memory state to what we just wrote, then clear dirty
		// markers. Tombstones survive: an unbind is permanent intent
		// that must keep vetoing future stale writebacks for this
		// process's lifetime (clearing them would let a concurrent
		// writeback resurrect the key after our next save).
		this.data = { chats: merged };
		this.dirtyKeys.clear();
	}

	/** Mirror of `load()` minus the migration step. Migration runs once
	 *  per process at construction; on a write-time reload we trust
	 *  whatever is on disk (any other process running this code already
	 *  migrated, and a hand-edit between then and now would surface as
	 *  an unmigrated bare-numeric key the next time we boot). */
	private readDisk(): ChatStoreFile | undefined {
		if (!existsSync(this.path)) return undefined;
		try {
			const raw = readFileSync(this.path, "utf8");
			const parsed = JSON.parse(raw) as ChatStoreFile;
			if (!parsed || typeof parsed !== "object"
				|| !parsed.chats || typeof parsed.chats !== "object" || Array.isArray(parsed.chats)
			) {
				return undefined;
			}
			return parsed;
		} catch {
			return undefined;
		}
	}

	get(key: string): ChatBinding | undefined {
		return this.data.chats[key];
	}

	set(
		key: string,
		binding: Omit<ChatBinding, "added_at" | "topics"> & { added_at?: string },
	): void {
		const existing = this.data.chats[key];
		this.data.chats[key] = {
			...binding,
			added_at: binding.added_at ?? new Date().toISOString(),
			// Preserve any topic-level bindings on a group-level overwrite.
			...(existing?.topics ? { topics: existing.topics } : {}),
		};
		this.dirtyKeys.add(key);
		this.save();
	}

	/** Delete the group-level binding. Topic-level bindings on the same
	 *  chat are PRESERVED — user set those explicitly, we don't infer
	 *  intent to clear them from a group-level /unbind. */
	delete(key: string): boolean {
		const existing = this.data.chats[key];
		if (!existing) return false;
		if (existing.topics && Object.keys(existing.topics).length > 0) {
			// Keep topics; clear the group-level cwd. `null` is the typed
			// sentinel — callers checking truthiness see "no group binding"
			// while topic lookups continue to back per-topic resolution.
			this.data.chats[key] = {
				cwd: null,
				added_at: existing.added_at,
				topics: existing.topics,
			};
			this.dirtyKeys.add(key);
			this.save();
			return true;
		}
		delete this.data.chats[key];
		this.tombstones.add(key);
		this.save();
		return true;
	}

	/** All persisted binding keys, prefixed with their bridge scheme
	 *  (e.g. `tg:-1001234567890`, `dc:123456789012345678`). Callers
	 *  scoping to one bridge MUST filter by prefix. */
	chatIds(): string[] {
		return Object.keys(this.data.chats);
	}

	getTopic(
		key: string,
		threadId: number | string,
	): TopicBinding | undefined {
		return this.data.chats[key]?.topics?.[String(threadId)];
	}

	setTopic(
		key: string,
		threadId: number | string,
		binding: Omit<TopicBinding, "added_at"> & { added_at?: string },
	): void {
		const tkey = String(threadId);
		const existing = this.data.chats[key];
		const entry: ChatBinding = existing
			? { ...existing, topics: { ...(existing.topics ?? {}) } }
			: { cwd: null, added_at: new Date().toISOString(), topics: {} };
		const prior = entry.topics![tkey];
		entry.topics![tkey] = {
			// Preserve any prior `sessionId` pin — `/bind` flows through
			// here and only carries cwd/label, so without this spread the
			// pin set by ChatSession.attach() would be silently dropped.
			...(prior?.sessionId ? { sessionId: prior.sessionId } : {}),
			...binding,
			added_at: binding.added_at ?? new Date().toISOString(),
		};
		this.data.chats[key] = entry;
		this.dirtyKeys.add(key);
		this.save();
	}

	/** Update only the pinned OMP `sessionId` for a topic, preserving
	 *  existing cwd / label. If the topic doesn't exist yet, create one
	 *  with `cwd: null` (resolution falls through to group / default —
	 *  identical to the un-pinned case). Used by bridges with
	 *  `pinsSessions = true` (Discord) to remember which OMP session a
	 *  given thread belongs to across bot restarts. */
	setTopicSession(
		key: string,
		threadId: number | string,
		sessionId: string,
	): void {
		const tkey = String(threadId);
		const existing = this.data.chats[key];
		const entry: ChatBinding = existing
			? { ...existing, topics: { ...(existing.topics ?? {}) } }
			: { cwd: null, added_at: new Date().toISOString(), topics: {} };
		const prior = entry.topics![tkey];
		entry.topics![tkey] = prior
			? { ...prior, sessionId }
			: { cwd: null, added_at: new Date().toISOString(), sessionId };
		this.data.chats[key] = entry;
		this.dirtyKeys.add(key);
		this.save();
	}

	deleteTopic(key: string, threadId: number | string): boolean {
		const tkey = String(threadId);
		const existing = this.data.chats[key];
		if (!existing?.topics || !(tkey in existing.topics)) return false;
		delete existing.topics[tkey];
		// If the entry now has no group-level cwd and no remaining topics,
		// garbage-collect it to keep the file tidy.
		if (!existing.cwd && Object.keys(existing.topics).length === 0) {
			delete this.data.chats[key];
			this.tombstones.add(key);
		} else {
			if (Object.keys(existing.topics).length === 0) delete existing.topics;
			this.dirtyKeys.add(key);
		}
		this.save();
		return true;
	}

	topicIds(key: string): string[] {
		const entry = this.data.chats[key];
		return entry?.topics ? Object.keys(entry.topics) : [];
	}

	/** Three-level cwd resolution: topic > group > undefined.
	 *  Returns undefined if no binding exists at any level. */
	resolveCwd(
		key: string,
		threadId: number | string | undefined,
	): string | undefined {
		if (threadId !== undefined) {
			const t = this.getTopic(key, threadId);
			if (t && t.cwd) return t.cwd;
		}
		const g = this.get(key);
		if (g && g.cwd) return g.cwd;
		return undefined;
	}

	get filePath(): string {
		return this.path;
	}
}

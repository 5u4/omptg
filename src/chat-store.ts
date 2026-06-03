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
 * load, any key without a known `<scheme>:` prefix is rewritten as
 * `tg:<key>` and the file is rewritten once. Idempotent: subsequent
 * loads see the prefixed form and skip migration.
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
	cwd: string;
	label?: string;
	added_at: string;
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

	constructor(private readonly path: string = DEFAULT_PATH) {
		this.data = this.load();
	}

	private load(): ChatStoreFile {
		if (!existsSync(this.path)) return { chats: {} };
		try {
			const raw = readFileSync(this.path, "utf8");
			const parsed = JSON.parse(raw) as ChatStoreFile;
			if (!parsed || typeof parsed !== "object" || !parsed.chats) {
				return { chats: {} };
			}
			return this.migrate(parsed);
		} catch {
			// Corrupt file: don't overwrite, but don't crash either. Start
			// empty in memory; next save will replace it.
			return { chats: {} };
		}
	}

	/** Rewrite any bare-numeric keys (legacy Telegram-only schema) as
	 *  `tg:<id>`. If any rewrites happened, persist immediately so the
	 *  file matches the in-memory shape on the next process boot. */
	private migrate(parsed: ChatStoreFile): ChatStoreFile {
		let mutated = false;
		const next: Record<string, ChatBinding> = {};
		for (const [k, v] of Object.entries(parsed.chats)) {
			if (hasKnownPrefix(k)) {
				next[k] = v;
				continue;
			}
			const migrated = `tg:${k}`;
			// Collision: a `tg:<id>` already exists alongside the bare
			// `<id>`. The prefixed entry wins (it was written by a newer
			// code path); the bare entry is dropped.
			if (next[migrated] !== undefined || parsed.chats[migrated] !== undefined) {
				mutated = true;
				continue;
			}
			next[migrated] = v;
			mutated = true;
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

	private save(): void {
		mkdirSync(dirname(this.path), { recursive: true });
		const tmp = `${this.path}.tmp.${process.pid}`;
		writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, {
			mode: 0o600,
		});
		renameSync(tmp, this.path);
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
			this.save();
			return true;
		}
		delete this.data.chats[key];
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
		entry.topics![tkey] = {
			...binding,
			added_at: binding.added_at ?? new Date().toISOString(),
		};
		this.data.chats[key] = entry;
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
		} else if (Object.keys(existing.topics).length === 0) {
			delete existing.topics;
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
			if (t) return t.cwd;
		}
		const g = this.get(key);
		if (g && g.cwd) return g.cwd;
		return undefined;
	}

	get filePath(): string {
		return this.path;
	}
}

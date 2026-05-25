/**
 * Per-chat configuration store at `~/.omptg/chats.json`.
 *
 *   {
 *     "chats": {
 *       "<chat_id>": {
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
 * Forum topics are addressed by their `message_thread_id` (Telegram
 * forum supergroups only; threadId 1 is "General" which we treat as no
 * thread — same key as a non-forum supergroup).
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
	cwd: string;
	label?: string;
	added_at: string;
	/** Per-topic overrides. Absent when no topic-level binding exists. */
	topics?: Record<string, TopicBinding>;
}

interface ChatStoreFile {
	chats: Record<string, ChatBinding>;
}

const DEFAULT_PATH = resolvePath(homedir(), ".omptg", "chats.json");

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
			return parsed;
		} catch {
			// Corrupt file: don't overwrite, but don't crash either. Start
			// empty in memory; next save will replace it.
			return { chats: {} };
		}
	}

	private save(): void {
		mkdirSync(dirname(this.path), { recursive: true });
		const tmp = `${this.path}.tmp.${process.pid}`;
		writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, {
			mode: 0o600,
		});
		renameSync(tmp, this.path);
	}

	get(chatId: number | string): ChatBinding | undefined {
		return this.data.chats[String(chatId)];
	}

	set(
		chatId: number | string,
		binding: Omit<ChatBinding, "added_at" | "topics"> & { added_at?: string },
	): void {
		const key = String(chatId);
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
	delete(chatId: number | string): boolean {
		const key = String(chatId);
		const existing = this.data.chats[key];
		if (!existing) return false;
		if (existing.topics && Object.keys(existing.topics).length > 0) {
			// Keep topics; drop group-level fields by replacing the entry
			// with a sentinel that has empty cwd. Simpler: store with a
			// marker. Cleanest: just keep cwd but set a flag. Actually the
			// simplest: track group-level presence by whether `cwd` is set.
			// But cwd is required by interface. Use a separate concept:
			// after delete, get() should return undefined for group binding
			// while topic lookups continue to work. So: stash topics under
			// a synthetic entry with cwd="" and add a `groupBindingActive`
			// flag.
			//
			// Pragmatic choice instead: keep the whole entry but blank cwd
			// to "" — callers ignore an empty cwd as "no group binding".
			this.data.chats[key] = {
				cwd: "",
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

	chatIds(): string[] {
		return Object.keys(this.data.chats);
	}

	getTopic(
		chatId: number | string,
		threadId: number | string,
	): TopicBinding | undefined {
		return this.data.chats[String(chatId)]?.topics?.[String(threadId)];
	}

	setTopic(
		chatId: number | string,
		threadId: number | string,
		binding: Omit<TopicBinding, "added_at"> & { added_at?: string },
	): void {
		const key = String(chatId);
		const tkey = String(threadId);
		const existing = this.data.chats[key];
		const entry: ChatBinding = existing
			? { ...existing, topics: { ...(existing.topics ?? {}) } }
			: { cwd: "", added_at: new Date().toISOString(), topics: {} };
		entry.topics![tkey] = {
			...binding,
			added_at: binding.added_at ?? new Date().toISOString(),
		};
		this.data.chats[key] = entry;
		this.save();
	}

	deleteTopic(chatId: number | string, threadId: number | string): boolean {
		const key = String(chatId);
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

	topicIds(chatId: number | string): string[] {
		const entry = this.data.chats[String(chatId)];
		return entry?.topics ? Object.keys(entry.topics) : [];
	}

	/** Three-level cwd resolution: topic > group > default.
	 *  Returns undefined if no binding exists at any level. */
	resolveCwd(
		chatId: number | string,
		threadId: number | string | undefined,
	): string | undefined {
		if (threadId !== undefined) {
			const t = this.getTopic(chatId, threadId);
			if (t) return t.cwd;
		}
		const g = this.get(chatId);
		if (g && g.cwd) return g.cwd;
		return undefined;
	}

	get filePath(): string {
		return this.path;
	}
}

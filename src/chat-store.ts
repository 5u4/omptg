/**
 * Per-chat configuration store at `~/.omp-tg/chats.json`.
 *
 *   {
 *     "chats": {
 *       "<chat_id>": { "cwd": "/abs/path", "label?": "...", "added_at": "ISO" }
 *     }
 *   }
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

export interface ChatBinding {
	cwd: string;
	label?: string;
	added_at: string;
}

interface ChatStoreFile {
	chats: Record<string, ChatBinding>;
}

const DEFAULT_PATH = resolvePath(homedir(), ".omp-tg", "chats.json");

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

	set(chatId: number | string, binding: Omit<ChatBinding, "added_at"> & { added_at?: string }): void {
		this.data.chats[String(chatId)] = {
			...binding,
			added_at: binding.added_at ?? new Date().toISOString(),
		};
		this.save();
	}

	delete(chatId: number | string): boolean {
		const key = String(chatId);
		if (!(key in this.data.chats)) return false;
		delete this.data.chats[key];
		this.save();
		return true;
	}

	chatIds(): string[] {
		return Object.keys(this.data.chats);
	}

	get filePath(): string {
		return this.path;
	}
}

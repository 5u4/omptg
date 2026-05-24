/**
 * TelegramUI implements `ExtensionUIContext`: when the agent (or an
 * extension) asks the user a question, we post a telegram message with
 * inline buttons or wait for the next text reply, and resolve the
 * pending Promise on the answer.
 *
 * Only one pending request at a time per chat. If a second arrives while
 * the first is unresolved, we reject the new one fast and log — chains
 * of overlapping UI calls happen for compound permissions, but in v1 we
 * keep the model simple.
 */
import type { Bot } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
	TerminalInputHandler,
	Theme,
} from "@oh-my-pi/pi-coding-agent";

const CALLBACK_PREFIX = "ompui:";
const TEXT_REPLY_PREFIX = "(reply with text)";

type Resolver = (value: unknown) => void;

export interface PendingUiRequest {
	requestId: string;
	kind: "select" | "confirm" | "input" | "editor";
	messageId: number;
	resolve: Resolver;
	/** When true, next plain text message from the user is the answer. */
	awaitsText: boolean;
}

let nextRequestId = 0;
function freshId(): string {
	nextRequestId = (nextRequestId + 1) >>> 0;
	return `${Date.now().toString(36)}-${nextRequestId.toString(36)}`;
}

export function encodeCallback(requestId: string, value: string): string {
	// Telegram callback_data is capped at 64 bytes. Keep this short.
	return `${CALLBACK_PREFIX}${requestId}:${value}`;
}

export function parseCallback(
	data: string,
): { requestId: string; value: string } | undefined {
	if (!data.startsWith(CALLBACK_PREFIX)) return undefined;
	const rest = data.slice(CALLBACK_PREFIX.length);
	const idx = rest.indexOf(":");
	if (idx < 0) return undefined;
	return { requestId: rest.slice(0, idx), value: rest.slice(idx + 1) };
}

export class TelegramUI implements ExtensionUIContext {
	private current: PendingUiRequest | undefined;

	// Required by ExtensionUIContext but we never run a real Theme stack here.
	// The SDK only touches `theme` when an extension explicitly uses it; the
	// tools that ship in the box don't.
	readonly theme = {} as Theme;

	constructor(
		private readonly bot: Bot,
		private readonly chatId: number,
	) {}

	pending(): PendingUiRequest | undefined {
		return this.current;
	}

	/** Resolve a pending UI request. Returns false if nothing was waiting. */
	resolve(
		payload:
			| { kind: "callback"; requestId: string; value: unknown }
			| { kind: "text"; text: string },
	): boolean {
		const pending = this.current;
		if (!pending) return false;
		if (payload.kind === "callback") {
			if (pending.requestId !== payload.requestId) return false;
			this.current = undefined;
			pending.resolve(payload.value);
			return true;
		}
		// text reply
		if (!pending.awaitsText) return false;
		this.current = undefined;
		pending.resolve(payload.text);
		return true;
	}

	// --- ExtensionUIContext methods (the ones we actually wire) -------------

	async select(
		title: string,
		options: string[],
		_dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		this.rejectInFlight();
		const requestId = freshId();
		// Encode option by *index* to stay inside the 64-byte callback cap.
		const keyboard: InlineKeyboardButton[][] = options.map((opt, i) => [
			{ text: opt, callback_data: encodeCallback(requestId, `i${i}`) },
		]);
		keyboard.push([
			{
				text: "✖ cancel",
				callback_data: encodeCallback(requestId, "cancel"),
			},
		]);
		const msg = await this.bot.api.sendMessage(this.chatId, `❓ ${title}`, {
			reply_markup: { inline_keyboard: keyboard },
		});
		return new Promise<string | undefined>(resolve => {
			this.current = {
				requestId,
				kind: "select",
				messageId: msg.message_id,
				awaitsText: false,
				resolve: raw => {
					const v = String(raw);
					if (v === "cancel") return resolve(undefined);
					if (v.startsWith("i")) {
						const idx = Number.parseInt(v.slice(1), 10);
						return resolve(options[idx]);
					}
					resolve(undefined);
				},
			};
		});
	}

	async confirm(
		title: string,
		message: string,
		_dialogOptions?: ExtensionUIDialogOptions,
	): Promise<boolean> {
		this.rejectInFlight();
		const requestId = freshId();
		const keyboard: InlineKeyboardButton[][] = [
			[
				{
					text: "✅ yes",
					callback_data: encodeCallback(requestId, "y"),
				},
				{
					text: "❌ no",
					callback_data: encodeCallback(requestId, "n"),
				},
			],
		];
		const text = title === message || !title ? message : `${title}\n\n${message}`;
		const msg = await this.bot.api.sendMessage(
			this.chatId,
			`❓ ${text}`,
			{ reply_markup: { inline_keyboard: keyboard } },
		);
		return new Promise<boolean>(resolve => {
			this.current = {
				requestId,
				kind: "confirm",
				messageId: msg.message_id,
				awaitsText: false,
				resolve: raw => resolve(String(raw) === "y"),
			};
		});
	}

	async input(
		title: string,
		placeholder?: string,
		_dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		this.rejectInFlight();
		const requestId = freshId();
		const hint = placeholder ? ` (${placeholder})` : "";
		const msg = await this.bot.api.sendMessage(
			this.chatId,
			`❓ ${title}${hint}\n${TEXT_REPLY_PREFIX}`,
			{
				reply_markup: {
					inline_keyboard: [
						[
							{
								text: "✖ cancel",
								callback_data: encodeCallback(requestId, "cancel"),
							},
						],
					],
				},
			},
		);
		return new Promise<string | undefined>(resolve => {
			this.current = {
				requestId,
				kind: "input",
				messageId: msg.message_id,
				awaitsText: true,
				resolve: raw => {
					if (raw === undefined) return resolve(undefined);
					const v = String(raw);
					if (v === "cancel") return resolve(undefined);
					resolve(v);
				},
			};
		});
	}

	async editor(
		title: string,
		prefill?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		_editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined> {
		// Same UX as input for now; a future enhancement is "send a file
		// back" but multi-line text-in-telegram works fine.
		const prompt = prefill
			? `${title}\n\n(current text — reply to replace, or 'cancel')\n${prefill}`
			: title;
		return this.input(prompt, undefined, dialogOptions);
	}

	notify(message: string, type: "info" | "warning" | "error" = "info"): void {
		const emoji = type === "error" ? "❌" : type === "warning" ? "⚠️" : "ℹ️";
		void this.bot.api
			.sendMessage(this.chatId, `${emoji} ${message}`)
			.catch(err => console.warn("[notify] failed:", err));
	}

	// --- The long tail. These are interactive-mode-only or footer/theme
	//     concerns; non-interactive bridges (RPC, print) leave them as
	//     no-ops too. We follow that pattern.

	onTerminalInput(_handler: TerminalInputHandler): () => void {
		return () => {};
	}
	setStatus(_key: string, _text: string | undefined): void {}
	setWorkingMessage(_message?: string): void {}
	setWidget(
		_key: string,
		_content: ExtensionWidgetContent,
		_options?: ExtensionWidgetOptions,
	): void {}
	setFooter(): void {}
	setHeader(): void {}
	setTitle(_title: string): void {}
	async custom<T>(): Promise<T> {
		throw new Error("ui.custom not supported in telegram bridge");
	}
	setEditorText(_text: string): void {}
	pasteToEditor(_text: string): void {}
	getEditorText(): string {
		return "";
	}
	setEditorComponent(): void {}
	async getAllThemes(): Promise<{ name: string; path: string | undefined }[]> {
		return [];
	}
	async getTheme(): Promise<Theme | undefined> {
		return undefined;
	}
	async setTheme(): Promise<{ success: boolean; error?: string }> {
		return { success: false, error: "themes not supported" };
	}
	getToolsExpanded(): boolean {
		return false;
	}
	setToolsExpanded(_expanded: boolean): void {}

	// --- internals ----------------------------------------------------------

	private rejectInFlight(): void {
		const pending = this.current;
		if (!pending) return;
		this.current = undefined;
		// Resolve as cancelled / undefined so the caller's await unblocks.
		pending.resolve(undefined);
		console.warn(
			`[chat ${this.chatId}] superseded pending UI ${pending.kind}/${pending.requestId}`,
		);
	}
}

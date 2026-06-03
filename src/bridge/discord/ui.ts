/**
 * DiscordUI — Phase 2 stub.
 *
 * Interactive prompts (select/confirm/input/editor) throw until phase 4
 * wires them to Discord components/modals. The rest of the
 * ExtensionUIContext surface is no-op, mirroring WebUI / TelegramUI.
 */
import type {
	ExtensionUIDialogOptions,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
	TerminalInputHandler,
	Theme,
} from "@oh-my-pi/pi-coding-agent";
import { theme as defaultTheme } from "@oh-my-pi/pi-coding-agent";
import type { Client } from "discord.js";
import type { InteractiveUI, PendingUiRequest } from "../types.ts";
import { scoped } from "../../logger.ts";

export class DiscordUI implements InteractiveUI {
	readonly theme: Theme = defaultTheme;
	private readonly log;

	constructor(
		_client: Client,
		channelId: string,
		threadId: string | undefined,
	) {
		this.log = scoped(`dcui:${channelId}${threadId ? `:${threadId}` : ""}`);
	}

	pending(): PendingUiRequest | undefined { return undefined; }
	resolve(_payload:
		| { kind: "callback"; requestId: string; value: unknown }
		| { kind: "text"; text: string }): boolean {
		this.log.warn("resolve.not_implemented");
		return false;
	}

	async select(_title: string, _options: string[], _opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
		throw new Error("DiscordUI.select: not implemented (phase 4)");
	}
	async confirm(_title: string, _message: string, _opts?: ExtensionUIDialogOptions): Promise<boolean> {
		throw new Error("DiscordUI.confirm: not implemented (phase 4)");
	}
	async input(_title: string, _placeholder?: string, _opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
		throw new Error("DiscordUI.input: not implemented (phase 4)");
	}
	async editor(_title: string, _prefill?: string, _opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
		throw new Error("DiscordUI.editor: not implemented (phase 4)");
	}

	notify(message: string, type: "info" | "warning" | "error" = "info"): void {
		this.log.info("notify", { type, message });
	}

	// --- long tail (no-op) -------------------------------------------------
	onTerminalInput(_handler: TerminalInputHandler): () => void { return () => {}; }
	setStatus(_key: string, _text: string | undefined): void {}
	setWorkingMessage(_message?: string): void {}
	setWidget(_key: string, _content: ExtensionWidgetContent, _options?: ExtensionWidgetOptions): void {}
	setFooter(): void {}
	setHeader(): void {}
	setTitle(_title: string): void {}
	async custom<T>(): Promise<T> { throw new Error("ui.custom not supported in discord bridge"); }
	setEditorText(_text: string): void {}
	pasteToEditor(_text: string): void {}
	getEditorText(): string { return ""; }
	setEditorComponent(): void {}
	async getAllThemes(): Promise<{ name: string; path: string | undefined }[]> { return []; }
	async getTheme(): Promise<Theme | undefined> { return undefined; }
	async setTheme(): Promise<{ success: boolean; error?: string }> {
		return { success: false, error: "themes not supported" };
	}
	getToolsExpanded(): boolean { return false; }
	setToolsExpanded(_expanded: boolean): void {}
}

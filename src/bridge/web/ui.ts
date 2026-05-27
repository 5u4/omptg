/**
 * WebUI — `InteractiveUI` for the web bridge. Dialog calls (select /
 * confirm / input / editor) post a `ui.request` envelope and `await` a
 * matching `ui.response` from the client. One pending request per route;
 * a new request supersedes the prior (mirrors TelegramUI semantics so
 * ChatSession's expectations carry over).
 *
 * Long-tail ExtensionUIContext methods (footer/widget/theme/editor
 * components) are no-ops, same as TelegramUI — those are
 * interactive-terminal concerns.
 */
import type {
	ExtensionUIDialogOptions,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
	TerminalInputHandler,
	Theme,
} from "@oh-my-pi/pi-coding-agent";
import { theme as defaultTheme } from "@oh-my-pi/pi-coding-agent";
import type { InteractiveUI, PendingUiRequest } from "../types.ts";
import type { UiRequestPayload } from "./protocol.ts";
import { scoped } from "../../logger.ts";

type Resolver = (value: unknown) => void;

interface PendingState extends PendingUiRequest {
	resolve: Resolver;
	req: UiRequestPayload;
}

let nextRequestId = 0;
function freshId(): string {
	nextRequestId = (nextRequestId + 1) >>> 0;
	return `${Date.now().toString(36)}-${nextRequestId.toString(36)}`;
}

/** Hook the bridge wires up: post a ui.request envelope to subscribers
 *  of this route, and (optionally) post a ui.cancel when superseded. */
export interface WebUiHooks {
	postRequest(reqId: string, req: UiRequestPayload, awaitsText: boolean): void;
	cancelRequest(reqId: string): void;
	/** Fan out an out-of-band notification (extension/tool called
	 *  `ui.notify`) as a `notice` SessionEvent. */
	postNotice(level: "info" | "warning" | "error", text: string): void;
}

export class WebUI implements InteractiveUI {
	private current: PendingState | undefined;
	private readonly log;

	readonly theme: Theme = defaultTheme;

	constructor(
		private readonly routeKey: string,
		private readonly hooks: WebUiHooks,
	) {
		this.log = scoped(`webui:${routeKey}`);
	}

	pending(): PendingUiRequest | undefined {
		if (!this.current) return undefined;
		const { requestId, kind, awaitsText } = this.current;
		return { requestId, kind, awaitsText };
	}

	resolve(payload:
		| { kind: "callback"; requestId: string; value: unknown }
		| { kind: "text"; text: string }): boolean {
		const pending = this.current;
		if (!pending) {
			this.log.warn("resolve.no_pending");
			return false;
		}
		if (payload.kind === "callback") {
			if (pending.requestId !== payload.requestId) {
				this.log.warn("resolve.req_id_mismatch", {
					expected: pending.requestId,
					got: payload.requestId,
				});
				return false;
			}
			this.current = undefined;
			pending.resolve(payload.value);
			return true;
		}
		if (!pending.awaitsText) {
			this.log.warn("resolve.text_into_non_text", { kind: pending.kind });
			return false;
		}
		this.current = undefined;
		pending.resolve(payload.text);
		return true;
	}

	async select(
		title: string,
		options: string[],
		_dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		this.supersede();
		const requestId = freshId();
		const req: UiRequestPayload = { kind: "select", title, options };
		this.hooks.postRequest(requestId, req, false);
		return new Promise<string | undefined>(resolve => {
			this.current = {
				requestId,
				kind: "select",
				awaitsText: false,
				req,
				resolve: raw => {
					if (raw === undefined || raw === null) return resolve(undefined);
					// Accept either the option string verbatim or a
					// numeric index (frontend convenience).
					if (typeof raw === "string") {
						if (options.includes(raw)) return resolve(raw);
					}
					if (typeof raw === "number" && raw >= 0 && raw < options.length) {
						return resolve(options[raw]);
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
		this.supersede();
		const requestId = freshId();
		const req: UiRequestPayload = { kind: "confirm", title, message };
		this.hooks.postRequest(requestId, req, false);
		return new Promise<boolean>(resolve => {
			this.current = {
				requestId,
				kind: "confirm",
				awaitsText: false,
				req,
				resolve: raw => resolve(raw === true || raw === "y" || raw === "yes"),
			};
		});
	}

	async input(
		title: string,
		placeholder?: string,
		_dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		this.supersede();
		const requestId = freshId();
		const req: UiRequestPayload = { kind: "input", title, placeholder };
		this.hooks.postRequest(requestId, req, true);
		return new Promise<string | undefined>(resolve => {
			this.current = {
				requestId,
				kind: "input",
				awaitsText: true,
				req,
				resolve: raw => {
					if (raw === undefined || raw === null) return resolve(undefined);
					resolve(String(raw));
				},
			};
		});
	}

	async editor(
		title: string,
		prefill?: string,
		_dialogOptions?: ExtensionUIDialogOptions,
		_editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined> {
		this.supersede();
		const requestId = freshId();
		const req: UiRequestPayload = { kind: "editor", title, prefill };
		this.hooks.postRequest(requestId, req, true);
		return new Promise<string | undefined>(resolve => {
			this.current = {
				requestId,
				kind: "editor",
				awaitsText: true,
				req,
				resolve: raw => {
					if (raw === undefined || raw === null) return resolve(undefined);
					resolve(String(raw));
				},
			};
		});
	}

	notify(message: string, type: "info" | "warning" | "error" = "info"): void {
		this.log.info("notify", { type, message });
		// Fan out as a `notice` SessionEvent so subscribers actually
		// see the message; without this, an extension-fired notify()
		// would silently only hit the server log.
		this.hooks.postNotice(type, message);
	}

	// --- long tail (no-op, mirror TelegramUI) ------------------------------

	onTerminalInput(_handler: TerminalInputHandler): () => void { return () => {}; }
	setStatus(_key: string, _text: string | undefined): void {}
	setWorkingMessage(_message?: string): void {}
	setWidget(_key: string, _content: ExtensionWidgetContent, _options?: ExtensionWidgetOptions): void {}
	setFooter(): void {}
	setHeader(): void {}
	setTitle(_title: string): void {}
	async custom<T>(): Promise<T> {
		throw new Error("ui.custom not supported in web bridge");
	}
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

	// --- internals ---------------------------------------------------------

	private supersede(): void {
		const pending = this.current;
		if (!pending) return;
		this.current = undefined;
		this.hooks.cancelRequest(pending.requestId);
		pending.resolve(undefined);
		this.log.warn("superseded", { kind: pending.kind, req_id: pending.requestId });
	}
}

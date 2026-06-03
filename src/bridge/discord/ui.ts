/**
 * DiscordUI — interactive prompts via Discord components/modals.
 *
 * Mapping (mirrors `TelegramUI` 1:1 at the public surface):
 *   select  ≤25 → StringSelectMenu (single row) + cancel button
 *   select  >25 → paginated buttons (16/page, 4 cols × 4 rows) + nav
 *   confirm     → two buttons (✅ yes / ❌ no)
 *   input       → "Answer" + "Cancel" buttons; answer click opens a
 *                 Short-style modal (Discord modals can only be opened
 *                 from an interaction, so we never post them unilaterally)
 *   editor      → same as input but Paragraph-style modal, prefill preserved
 *
 * Pending model: one slot per route (same as TelegramUI). A second call
 * while a request is in flight resolves the first with `undefined`
 * ("superseded") and the carrier message is rewritten to reflect that.
 *
 * Custom-id wire format (Discord caps custom_id at 100 chars; ours is tiny):
 *   omp:<requestId>:<tag>
 * where <tag> is one of:
 *   sel                    — select-menu submit (value carries i<N>|cancel)
 *   btn:<value>            — button tap (value: y|n|i<N>|cancel|answer|pg<N>|noop)
 *   mod                    — modal submit (text in the "text" field)
 *
 * Late taps (request already resolved or superseded) reply with an
 * ephemeral "expired" notice and do nothing else.
 */
import type {
	ExtensionUIDialogOptions,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
	TerminalInputHandler,
	Theme,
} from "@oh-my-pi/pi-coding-agent";
import { theme as defaultTheme } from "@oh-my-pi/pi-coding-agent";
import type {
	ButtonInteraction,
	Client,
	Message,
	ModalSubmitInteraction,
	StringSelectMenuInteraction,
} from "discord.js";
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	MessageFlags,
	ModalBuilder,
	StringSelectMenuBuilder,
	StringSelectMenuOptionBuilder,
	TextInputBuilder,
	TextInputStyle,
} from "discord.js";
import type { InteractiveUI, PendingUiRequest } from "../types.ts";
import { scoped } from "../../logger.ts";
import { resolveSendTarget } from "./index.ts";

const CUSTOM_ID_PREFIX = "omp:";
// 4 cols × 4 rows = 16 option buttons/page; +1 nav row keeps us under
// Discord's 5-ActionRow-per-message hard cap. Bumping any dimension here
// risks 50035 Invalid Form Body on long-options selects in production.
const PAGE_COLS = 4;
const PAGE_ROWS = 4;
const PAGE_SIZE = PAGE_COLS * PAGE_ROWS;

const DISCORD_MSG_CAP = 2000;
const DISCORD_MODAL_LABEL_CAP = 45;
const DISCORD_BUTTON_LABEL_CAP = 80;
const DISCORD_SELECT_LABEL_CAP = 100;
const DISCORD_SELECT_DESC_CAP = 100;
const DISCORD_MODAL_INPUT_SHORT_CAP = 4000;
const DISCORD_MODAL_TITLE_CAP = 45;

// Carrier-finalize budgets. `editCarrier` re-truncates with `DISCORD_MSG_CAP`
// as a final guard, but choosing the budget here keeps the "→ choice"
// suffix intact even on max-length titles.
//   confirm/select: "✅ " + title + "  " + "→ " + choice
//      choice <= title length, so leave 100 chars of headroom.
//   input/editor:  "✅ " + title + "  " + "→ " + answer
//      `answer` truncated to 200 below, plus framing — total fits in 300.
const CARRIER_TITLE_BUDGET = DISCORD_MSG_CAP - 100;       // = 1900
const CARRIER_TITLE_BUDGET_TEXT = DISCORD_MSG_CAP - 300;  // = 1700
const CARRIER_ANSWER_PREVIEW = 200;

type ParsedCustomId =
	| { tag: "sel"; requestId: string }
	| { tag: "btn"; requestId: string; value: string }
	| { tag: "mod"; requestId: string };

export function parseDiscordCustomId(id: string): ParsedCustomId | undefined {
	if (!id.startsWith(CUSTOM_ID_PREFIX)) return undefined;
	const rest = id.slice(CUSTOM_ID_PREFIX.length);
	const i1 = rest.indexOf(":");
	if (i1 < 0) return undefined;
	const requestId = rest.slice(0, i1);
	const tail = rest.slice(i1 + 1);
	if (tail === "sel") return { tag: "sel", requestId };
	if (tail === "mod") return { tag: "mod", requestId };
	if (tail.startsWith("btn:")) {
		return { tag: "btn", requestId, value: tail.slice(4) };
	}
	return undefined;
}

function btnId(requestId: string, value: string): string {
	return `${CUSTOM_ID_PREFIX}${requestId}:btn:${value}`;
}
function selId(requestId: string): string {
	return `${CUSTOM_ID_PREFIX}${requestId}:sel`;
}
function modId(requestId: string): string {
	return `${CUSTOM_ID_PREFIX}${requestId}:mod`;
}

function truncate(s: string, cap: number): string {
	return s.length <= cap ? s : `${s.slice(0, cap - 1)}…`;
}

/**
 * Carrier message + the pending state for a single in-flight UI request.
 * The carrier is the message we posted with the prompt + components; on
 * resolve we edit it to show the chosen answer (or "cancelled" / "expired")
 * and strip components so a late tap is a no-op.
 */
interface DiscordPending {
	requestId: string;
	kind: "select" | "confirm" | "input" | "editor";
	awaitsText: boolean;
	carrierMessageId: string;
	/** Static fields needed for re-rendering carriers (pagination, finalize)
	 *  and for re-creating the modal when the user clicks "Answer". */
	prompt: string;
	options?: string[]; // select only, full list
	pageIndex?: number; // select with pagination
	modalTitle?: string; // input/editor only
	modalPrefill?: string; // editor only
	/** Resolve with the bridge-side raw value:
	 *   - select: `i<N>` | `cancel` | undefined (supersede)
	 *   - confirm: `y` | `n` | undefined
	 *   - input/editor: text string | undefined
	 *  TelegramUI's `current.resolve` mirrors this. */
	resolve: (raw: string | undefined) => void;
}

export class DiscordUI implements InteractiveUI {
	readonly theme: Theme = defaultTheme;
	private current: DiscordPending | undefined;
	private nextReq = 0;
	private readonly log;

	constructor(
		private readonly client: Client,
		private readonly channelId: string,
		private readonly threadId: string | undefined,
	) {
		this.log = scoped(`dcui:${channelId}${threadId ? `:${threadId}` : ""}`);
	}

	pending(): PendingUiRequest | undefined {
		if (!this.current) return undefined;
		const { requestId, kind, awaitsText } = this.current;
		return { requestId, kind, awaitsText };
	}

	resolve(
		payload:
			| { kind: "callback"; requestId: string; value: unknown }
			| { kind: "text"; text: string },
	): boolean {
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
			pending.resolve(payload.value === undefined ? undefined : String(payload.value));
			return true;
		}
		// `kind: "text"` — only meaningful for input/editor modal submits.
		// Discord's modal text always arrives via `handleInteraction` and
		// is routed in through `resolve({ kind: "callback", value })`, so
		// the text branch is here purely for InteractiveUI parity (and
		// guards against a future caller wiring DM text replies in).
		if (!pending.awaitsText) {
			this.log.warn("resolve.text_into_non_text", { pending_kind: pending.kind });
			return false;
		}
		this.current = undefined;
		pending.resolve(payload.text);
		return true;
	}

	// --- prompt surface -----------------------------------------------------

	async select(
		title: string,
		options: string[],
		_opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		this.rejectInFlight();
		const requestId = this.freshId();
		this.log.info("select.fire", { req_id: requestId, n_options: options.length });
		const useMenu = options.length <= 25;
		const promptText = truncate(`❓ ${title}`, DISCORD_MSG_CAP);

		const target = await resolveSendTarget(this.client, this.channelId, this.threadId);
		const components = useMenu
			? this.buildSelectMenuComponents(requestId, options)
			: this.buildPaginatedSelectComponents(requestId, options, 0);
		const sent = await target.send({
			content: promptText,
			components,
			allowedMentions: { parse: [], repliedUser: false },
		});
		this.log.info("select.posted", { req_id: requestId, message_id: sent.id });

		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		const finalize = (choice: string | undefined): void => {
			const suffix = choice === undefined ? "⊘ cancelled" : `→ ${choice}`;
			this.editCarrier(sent.id, `✅ ${truncate(title, CARRIER_TITLE_BUDGET)}  ${suffix}`, "select");
			resolve(choice);
		};
		this.current = {
			requestId,
			kind: "select",
			awaitsText: false,
			carrierMessageId: sent.id,
			prompt: promptText,
			options,
			pageIndex: useMenu ? undefined : 0,
			resolve: raw => {
				if (raw === undefined) return finalize(undefined);
				if (raw === "cancel") return finalize(undefined);
				if (raw.startsWith("i")) {
					const idx = Number.parseInt(raw.slice(1), 10);
					return finalize(options[idx]);
				}
				finalize(undefined);
			},
		};
		return promise;
	}

	async confirm(
		title: string,
		message: string,
		_opts?: ExtensionUIDialogOptions,
	): Promise<boolean> {
		this.rejectInFlight();
		const requestId = this.freshId();
		this.log.info("confirm.fire", { req_id: requestId });
		const text = title === message || !title ? message : `${title}\n\n${message}`;
		const promptText = truncate(`❓ ${text}`, DISCORD_MSG_CAP);
		const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId(btnId(requestId, "y"))
				.setStyle(ButtonStyle.Success)
				.setLabel("✅ yes"),
			new ButtonBuilder()
				.setCustomId(btnId(requestId, "n"))
				.setStyle(ButtonStyle.Secondary)
				.setLabel("❌ no"),
		);
		const target = await resolveSendTarget(this.client, this.channelId, this.threadId);
		const sent = await target.send({
			content: promptText,
			components: [row],
			allowedMentions: { parse: [], repliedUser: false },
		});
		const { promise, resolve } = Promise.withResolvers<boolean>();
		const finalize = (choice: boolean | undefined): void => {
			const suffix = choice === undefined
				? "⊘ cancelled"
				: `→ ${choice ? "yes" : "no"}`;
			this.editCarrier(sent.id, `✅ ${truncate(text, CARRIER_TITLE_BUDGET)}  ${suffix}`, "confirm");
			// `confirm` returns a bare boolean; supersede/cancel collapses
			// to `false` (status-quo), matching TelegramUI.
			resolve(choice ?? false);
		};
		this.current = {
			requestId,
			kind: "confirm",
			awaitsText: false,
			carrierMessageId: sent.id,
			prompt: promptText,
			resolve: raw => {
				if (raw === undefined) return finalize(undefined);
				finalize(raw === "y");
			},
		};
		return promise;
	}

	async input(
		title: string,
		placeholder?: string,
		_opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return this.openTextPrompt({ title, placeholder, multiline: false });
	}

	async editor(
		title: string,
		prefill?: string,
		_opts?: ExtensionUIDialogOptions,
		_editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined> {
		return this.openTextPrompt({ title, prefill, multiline: true });
	}

	notify(message: string, type: "info" | "warning" | "error" = "info"): void {
		const emoji = type === "error" ? "❌" : type === "warning" ? "⚠️" : "ℹ️";
		void resolveSendTarget(this.client, this.channelId, this.threadId)
			.then(t => t.send({
				content: `${emoji} ${truncate(message, DISCORD_MSG_CAP - 4)}`,
				allowedMentions: { parse: [], repliedUser: false },
			}))
			.catch(err => this.log.warn("notify.failed", { err: String(err) }));
	}

	// --- inbound interaction routing ----------------------------------------

	/**
	 * Called by the `interactionCreate` handler for any interaction whose
	 * customId matches our `omp:` prefix.
	 *
	 *   - Button "answer" (input/editor): show the modal. `showModal`
	 *     MUST be the first response to the interaction, so this branch
	 *     runs ahead of the deferUpdate path below.
	 *   - Button (confirm/select-cancel/select-paginated): resolve the
	 *     pending request, then `deferUpdate()` so Discord doesn't show
	 *     the "interaction failed" red toast.
	 *   - Select menu submit: resolve with `values[0]`.
	 *   - Modal submit: pull the "text" field, resolve.
	 *
	 * Late / mismatched taps: ephemeral "expired" reply (the carrier is
	 * already in its finalize state; user just clicked a stale render).
	 *
	 * Returns true if we recognized and handled the interaction. False
	 * means the caller should ignore us — useful if the interaction
	 * handler grows other prefixes (slash commands, voice, etc.).
	 */
	async handleInteraction(
		interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
	): Promise<boolean> {
		const parsed = parseDiscordCustomId(interaction.customId);
		if (!parsed) return false;
		const pending = this.current;
		const expired = !pending || pending.requestId !== parsed.requestId;

		// Modal flow: `showModal` MUST be the first response to the
		// interaction (Discord rejects any sequence where another reply
		// went out first), so this branch runs before the deferUpdate
		// submit path. The `&& pending` keeps TS narrowing inside the
		// kind check; `!expired` already implies pending exists.
		if (
			!expired
			&& interaction.isButton()
			&& parsed.tag === "btn"
			&& parsed.value === "answer"
			&& pending
			&& (pending.kind === "input" || pending.kind === "editor")
		) {
			const modal = this.buildModal(pending);
			await interaction.showModal(modal);
			return true;
		}

		if (expired) {
			await this.replyEphemeral(interaction, "⊘ expired — try the latest prompt");
			return true;
		}

		// Pagination: doesn't resolve, edits the carrier in place.
		if (
			interaction.isButton()
			&& parsed.tag === "btn"
			&& parsed.value.startsWith("pg")
			&& pending.kind === "select"
			&& pending.options
		) {
			const next = Number.parseInt(parsed.value.slice(2), 10);
			if (Number.isFinite(next)) {
				pending.pageIndex = next;
				const components = this.buildPaginatedSelectComponents(
					pending.requestId, pending.options, next,
				);
				await interaction.update({ components });
				return true;
			}
		}

		// The decorative page-indicator carries a `noop` customId so we
		// can spot it in routing. Discord blocks disabled-button clicks
		// server-side, but if one ever races the disabled flag we ack
		// silently instead of falling through to the submit path (which
		// would resolve the select with garbage → finalize(undefined) →
		// silent cancel).
		if (interaction.isButton() && parsed.tag === "btn" && parsed.value === "noop") {
			await interaction.deferUpdate().catch(err => {
				this.log.warn("noop.deferUpdate_failed", { err: String(err) });
			});
			return true;
		}

		// Submit paths — extract raw value to feed into pending.resolve.
		let raw: string | undefined;
		if (interaction.isButton() && parsed.tag === "btn") {
			raw = parsed.value;
		} else if (interaction.isStringSelectMenu() && parsed.tag === "sel") {
			raw = interaction.values[0]; // single-select
		} else if (interaction.isModalSubmit() && parsed.tag === "mod") {
			raw = interaction.fields.getTextInputValue("text");
		} else {
			// Unrecognized combination (e.g., select-menu submit with a btn
			// tag) — treat as a no-op rather than resolving with garbage.
			await this.replyEphemeral(interaction, "unrecognized interaction");
			return true;
		}

		// `deferUpdate` ack: tells Discord we handled it without changing
		// the message — the carrier edit lands via the pending.resolve →
		// finalize → editCarrier path. Modal submits also accept
		// deferUpdate (closes the modal cleanly).
		await interaction.deferUpdate().catch(err => {
			this.log.warn("deferUpdate.failed", { err: String(err) });
		});

		this.resolve({ kind: "callback", requestId: parsed.requestId, value: raw });
		return true;
	}

	// --- long tail (no-op, mirrors TelegramUI) ------------------------------
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

	// --- internals ----------------------------------------------------------

	private freshId(): string {
		this.nextReq += 1;
		return `r${this.nextReq.toString(36)}`;
	}

	private rejectInFlight(): void {
		const pending = this.current;
		if (!pending) return;
		this.current = undefined;
		// The prior carrier's finalize closure runs synchronously inside
		// `pending.resolve(undefined)` and fire-and-forgets its
		// editCarrier; no awaiting needed.
		pending.resolve(undefined);
		this.log.warn("superseded", { kind: pending.kind, req_id: pending.requestId });
	}

	private async openTextPrompt(args: {
		title: string;
		placeholder?: string;
		prefill?: string;
		multiline: boolean;
	}): Promise<string | undefined> {
		this.rejectInFlight();
		const requestId = this.freshId();
		this.log.info("text_prompt.fire", { req_id: requestId, kind: args.multiline ? "editor" : "input" });
		const hint = args.placeholder ? ` (${args.placeholder})` : "";
		// Discord modals can only be opened in response to an interaction
		// (button click), so we post a message with an "Answer" button
		// rather than trying to open the modal directly.
		const promptText = truncate(
			`❓ ${args.title}${hint}\n_Click **Answer** to reply._`,
			DISCORD_MSG_CAP,
		);
		const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId(btnId(requestId, "answer"))
				.setStyle(ButtonStyle.Primary)
				.setLabel("Answer"),
			new ButtonBuilder()
				.setCustomId(btnId(requestId, "cancel"))
				.setStyle(ButtonStyle.Secondary)
				.setLabel("✖ cancel"),
		);
		const target = await resolveSendTarget(this.client, this.channelId, this.threadId);
		const sent = await target.send({
			content: promptText,
			components: [row],
			allowedMentions: { parse: [], repliedUser: false },
		});
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		const finalize = (answer: string | undefined): void => {
			const suffix = answer === undefined
				? "⊘ cancelled"
				: `→ ${truncate(answer, CARRIER_ANSWER_PREVIEW)}`;
			this.editCarrier(sent.id, `✅ ${truncate(args.title, CARRIER_TITLE_BUDGET_TEXT)}  ${suffix}`, args.multiline ? "editor" : "input");
			resolve(answer);
		};
		this.current = {
			requestId,
			kind: args.multiline ? "editor" : "input",
			awaitsText: true,
			carrierMessageId: sent.id,
			prompt: promptText,
			modalTitle: args.title,
			modalPrefill: args.prefill,
			resolve: raw => {
				if (raw === undefined) return finalize(undefined);
				if (raw === "cancel") return finalize(undefined);
				finalize(raw);
			},
		};
		return promise;
	}

	private buildModal(pending: DiscordPending): ModalBuilder {
		const isEditor = pending.kind === "editor";
		const titleRaw = pending.modalTitle ?? "Answer";
		const prefill = pending.modalPrefill;
		const input = new TextInputBuilder()
			.setCustomId("text")
			.setStyle(isEditor ? TextInputStyle.Paragraph : TextInputStyle.Short)
			.setLabel(truncate(titleRaw || "Answer", DISCORD_MODAL_LABEL_CAP))
			.setRequired(true);
		if (prefill) input.setValue(truncate(prefill, DISCORD_MODAL_INPUT_SHORT_CAP));
		const row = new ActionRowBuilder<TextInputBuilder>().addComponents(input);
		return new ModalBuilder()
			.setCustomId(modId(pending.requestId))
			.setTitle(truncate(titleRaw || "Answer", DISCORD_MODAL_TITLE_CAP))
			.addComponents(row);
	}

	private buildSelectMenuComponents(
		requestId: string,
		options: string[],
	): (ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>)[] {
		const menu = new StringSelectMenuBuilder()
			.setCustomId(selId(requestId))
			.setPlaceholder("Pick one")
			.addOptions(
				options.map((opt, i) => {
					const b = new StringSelectMenuOptionBuilder()
						.setLabel(truncate(opt, DISCORD_SELECT_LABEL_CAP))
						.setValue(`i${i}`);
					// Only set a description when the label was truncated;
					// passing an empty string trips Discord's "DESCRIPTION_BASE_TYPE_BAD_LENGTH".
					if (opt.length > DISCORD_SELECT_LABEL_CAP) {
						b.setDescription(truncate(opt, DISCORD_SELECT_DESC_CAP));
					}
					return b;
				}),
			);
		const menuRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
		const cancelRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId(btnId(requestId, "cancel"))
				.setStyle(ButtonStyle.Secondary)
				.setLabel("✖ cancel"),
		);
		return [menuRow, cancelRow];
	}

	private buildPaginatedSelectComponents(
		requestId: string,
		options: string[],
		page: number,
	): ActionRowBuilder<ButtonBuilder>[] {
		const totalPages = Math.max(1, Math.ceil(options.length / PAGE_SIZE));
		const safePage = Math.max(0, Math.min(page, totalPages - 1));
		const start = safePage * PAGE_SIZE;
		const end = Math.min(start + PAGE_SIZE, options.length);
		// PAGE_COLS buttons per row, max PAGE_ROWS option rows. The nav
		// row pushed at the bottom brings total ActionRows to at most 5
		// — Discord's per-message cap.
		const rows: ActionRowBuilder<ButtonBuilder>[] = [];
		let row = new ActionRowBuilder<ButtonBuilder>();
		let cols = 0;
		for (let i = start; i < end; i++) {
			row.addComponents(
				new ButtonBuilder()
					.setCustomId(btnId(requestId, `i${i}`))
					.setStyle(ButtonStyle.Secondary)
					.setLabel(truncate(`${i + 1}) ${options[i]}`, DISCORD_BUTTON_LABEL_CAP)),
			);
			cols += 1;
			if (cols === PAGE_COLS) {
				rows.push(row);
				row = new ActionRowBuilder<ButtonBuilder>();
				cols = 0;
			}
		}
		if (cols > 0) rows.push(row);

		const nav = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId(btnId(requestId, `pg${safePage - 1}`))
				.setStyle(ButtonStyle.Secondary)
				.setLabel("◀ prev")
				.setDisabled(safePage === 0),
			new ButtonBuilder()
				.setCustomId(btnId(requestId, "noop"))
				.setStyle(ButtonStyle.Secondary)
				.setLabel(`${safePage + 1}/${totalPages}`)
				.setDisabled(true),
			new ButtonBuilder()
				.setCustomId(btnId(requestId, `pg${safePage + 1}`))
				.setStyle(ButtonStyle.Secondary)
				.setLabel("next ▶")
				.setDisabled(safePage === totalPages - 1),
			new ButtonBuilder()
				.setCustomId(btnId(requestId, "cancel"))
				.setStyle(ButtonStyle.Danger)
				.setLabel("✖ cancel"),
		);
		rows.push(nav);
		return rows;
	}

	/**
	 * Edit the carrier to show resolution and strip components. Fire-and-
	 * forget: the resolve() caller doesn't need to wait for cleanup, and
	 * we don't surface failures (rate limit, deleted message, …). On any
	 * edit failure we still try to strip components so a late tap can't
	 * re-fire.
	 */
	private editCarrier(messageId: string, text: string, scope: string): void {
		const safe = truncate(text, DISCORD_MSG_CAP);
		void this.resolveCarrier(messageId)
			.then(m => m.edit({ content: safe, components: [] }))
			.catch(err => {
				this.log.warn(`${scope}.edit_failed`, { err: String(err) });
				void this.resolveCarrier(messageId)
					.then(m => m.edit({ components: [] }))
					.catch(err2 => this.log.warn(`${scope}.strip_failed`, { err: String(err2) }));
			});
	}

	private async resolveCarrier(messageId: string): Promise<Message> {
		const target = await resolveSendTarget(this.client, this.channelId, this.threadId);
		// `messages.fetch` round-trips Discord; cheaper than relying on
		// the cache for finalize edits since the carrier may be old.
		return target.messages.fetch(messageId);
	}

	private async replyEphemeral(
		interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
		content: string,
	): Promise<void> {
		try {
			if (interaction.replied || interaction.deferred) return;
			await interaction.reply({
				content: truncate(content, DISCORD_MSG_CAP),
				flags: MessageFlags.Ephemeral,
			});
		} catch (err) {
			this.log.warn("ephemeral.failed", { err: String(err) });
		}
	}
}

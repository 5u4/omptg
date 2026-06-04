/**
 * All slash commands in one place. Each command is implemented as a
 * bridge-agnostic handler over `CommandContext`; Telegram and Discord
 * each adapt their native event shape into that context.
 *
 * `installCommands(deps)` wires the Telegram (`grammy`) bot; Discord
 * dispatches via `runSlashCommand(name, ctx)` from
 * `handlers/discord/commands.ts`.
 *
 * SLASH_COMMANDS is the single source of truth for "what /commands
 * exist" — Telegram's setMyCommands AND Discord's slash-command
 * registration both consume it.
 */
import { existsSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { Deps } from "./deps.ts";
import type { ChatRegistry } from "./chat.ts";
import type { ChatId } from "./bridge/types.ts";
import { scoped } from "./logger.ts";
import { extractThreadId } from "./topic.ts";
import { listStoredSessions } from "./chat.ts";
import { expandHome } from "./chat-store.ts";

const log = scoped("commands");

const SESSIONS_DEFAULT_LIMIT = 8;
const SESSIONS_MAX_LIMIT = 50;

/**
 * Command metadata pushed to telegram via setMyCommands AND used to
 * derive Discord slash-command registrations. Kept in registration
 * order = display order.
 *
 * `arg` (optional) describes the single free-form argument the command
 * accepts after the command name. Discord registers it as a single
 * STRING option; Telegram parses it from `ctx.match`. Commands with no
 * `arg` ignore any trailing text.
 */
export interface SlashCommandSpec {
	command: string;
	description: string;
	arg?: { name: string; description: string; required?: boolean };
}

export const SLASH_COMMANDS = [
	{ command: "new",      description: "Start a fresh session in the current cwd" },
	{ command: "sessions", description: "List recent stored sessions (default 8)",
	  arg: { name: "count", description: "How many to list (1..50)" } },
	{ command: "resume",   description: "Reopen session — no arg = most recent",
	  arg: { name: "index", description: "1-based index from /sessions" } },
	{ command: "cancel",   description: "Abort the current turn (keeps session)" },
	{ command: "status",   description: "Show session id, model, cwd" },
	{ command: "model",    description: "Switch model — no arg opens picker",
	  arg: { name: "id", description: "Model id (omit to pick from list)" } },
	{ command: "compact",  description: "Manually compact session context",
	  arg: { name: "instructions", description: "Optional compaction guidance" } },
	{ command: "whoami",   description: "Show this chat's id + binding" },
	{ command: "bind",     description: "/bind <path> — pin chat or topic to a cwd",
	  arg: { name: "path", description: "Absolute or ~-path; optional `|label` suffix", required: true } },
	{ command: "unbind",   description: "Remove binding for this scope" },
	{ command: "binding",  description: "Show topic + group bindings" },
	{ command: "retitle",  description: "/retitle [name] — rename current session, or regen via LLM if no name",
	  arg: { name: "name", description: "New title (omit to regen via LLM)" } },
	{ command: "start",    description: "Show help" },
] as const satisfies readonly SlashCommandSpec[];

/** Lazy memo so the text-handler "unknown /command" check is allocation-free. */
let _knownCommands: Set<string> | undefined;

// Re-typed view used by callers that need `arg` to exist on every
// entry (Discord registration). `as const satisfies` above preserves
// literal types for `command`/`description` but narrows each entry to
// the exact shape it was written with — so on entries without an
// `arg` field, TS rejects `entry.arg`. This widening alias gives the
// loop a uniform shape without losing the source-of-truth.
export const SLASH_COMMAND_SPECS: readonly SlashCommandSpec[] = SLASH_COMMANDS;
export function knownCommands(): Set<string> {
	if (!_knownCommands) {
		_knownCommands = new Set(SLASH_COMMANDS.map(c => c.command));
	}
	return _knownCommands;
}

/**
 * Bridge-neutral surface every command handler runs against. Telegram
 * adapts grammy's `Context`; Discord adapts `ChatInputCommandInteraction`.
 *
 * `arg` is the trimmed argument string (empty when the user passed
 * nothing). Telegram supplies `ctx.match`; Discord reads its single
 * STRING option.
 *
 * `reply()` is the user-visible response channel. Implementations are
 * responsible for splitting / truncating to platform limits; command
 * bodies build plain text only.
 */
export interface CommandContext {
	chatId: ChatId;
	threadId: number | string | undefined;
	chatType: string;
	chatTitle?: string;
	arg: string;
	registry: ChatRegistry;
	defaultCwd: string;
	reply(text: string): Promise<unknown>;
}

type Handler = (ctx: CommandContext) => Promise<void>;

/* ──────────────────────────  command bodies  ────────────────────────── */

const cmdStart: Handler = async ctx => {
	await ctx.reply([
		"omptg up.",
		`cwd: ${ctx.defaultCwd}`,
		"",
		"send any text to chat with the agent",
		"/cancel  abort current turn (keeps session)",
		"/new     start a fresh session in the current cwd",
		"/sessions [n]  list recent stored sessions (default 8, max 50)",
		"/resume [n]  reopen session by 1-based index (default: most recent)",
		"/status  show session id, model, cwd",
		"/model [id]  switch model — no arg = pick from list (temporary, not persisted)",
		"/compact [instructions]  manually compact context now",
		"",
		"chat → cwd binding",
		"/whoami   show this chat's id, type, and binding",
		"/bind <path> [|label]   bind to a cwd — in a topic: topic-only; in General/DM: group default (effect: next /new)",
		"/unbind   remove binding for this scope (topic or group)",
		"/binding  show topic + group bindings",
		"/retitle [name]  rename session, or LLM-regen if no name",
	].join("\n"));
};

const cmdStatus: Handler = async ctx => {
	const chat = ctx.registry.get(ctx.chatId, ctx.threadId);
	const lines = [
		`cwd: ${chat.cwd}`,
		`session: ${chat.sessionId ?? "(not yet created)"}`,
		`title: ${chat.sessionName ?? "-"}`,
		`model: ${chat.modelId ?? "?"}`,
		`streaming: ${chat.isStreaming}`,
		`file: ${chat.sessionFile ?? "-"}`,
	];
	const usage = chat.contextUsage;
	if (usage) {
		const pct = usage.percent;
		const tok = usage.tokens;
		const win = usage.contextWindow;
		const pctStr = pct === null ? "?" : `${pct.toFixed(1)}%`;
		const tokStr = tok === null ? "?" : tok.toLocaleString("en-US");
		lines.push(`context: ${pctStr} (${tokStr} / ${win.toLocaleString("en-US")})`);
	}
	await ctx.reply(lines.join("\n"));
};

const cmdModel: Handler = async ctx => {
	const chat = ctx.registry.get(ctx.chatId, ctx.threadId);
	const arg = ctx.arg;
	if (arg) {
		const model = await chat.setModelById(arg);
		if (!model) {
			const available = (await chat.getAvailableModels()).map(m => m.id);
			await ctx.reply(
				`unknown model "${arg}"\navailable:\n  ${available.join("\n  ")}`,
			);
			return;
		}
		await ctx.reply(`model: ${model.id}`);
		return;
	}
	const picked = await chat.promptModelSelection();
	if (!picked) {
		await ctx.reply("model unchanged");
		return;
	}
	await ctx.reply(`model: ${picked.id}`);
};

const cmdCompact: Handler = async ctx => {
	const chat = ctx.registry.get(ctx.chatId, ctx.threadId);
	const instructions = ctx.arg || undefined;
	const res = await chat.compact(instructions);
	switch (res.status) {
		case "no-session":
			await ctx.reply("no active session — nothing to compact");
			return;
		case "busy":
			await ctx.reply("agent is streaming — /cancel first, then /compact");
			return;
		case "error":
			await ctx.reply(`compact failed: ${res.message}`);
			return;
		case "ok": {
			const before = res.tokensBefore.toLocaleString("en-US");
			const after = res.tokensAfter === null ? "?" : res.tokensAfter.toLocaleString("en-US");
			const win = res.contextWindow.toLocaleString("en-US");
			const head = `✅ compacted: ${before} → ${after} tokens (window ${win})`;
			// Telegram caps at 4096; summary can be long. Trim to keep
			// the reply readable — full summary lives in the session file.
			const SUMMARY_MAX = 1200;
			const summary = res.summary.length > SUMMARY_MAX
				? `${res.summary.slice(0, SUMMARY_MAX)}…`
				: res.summary;
			await ctx.reply(`${head}\n\n${summary}`);
			return;
		}
	}
};

const cmdCancel: Handler = async ctx => {
	const chat = ctx.registry.get(ctx.chatId, ctx.threadId);
	const cancelled = await chat.abort();
	await ctx.reply(cancelled ? "aborted" : "nothing to cancel");
};

const cmdWhoami: Handler = async ctx => {
	const { chatId, threadId, registry, defaultCwd } = ctx;
	const binding = registry.getBinding(chatId);
	const topicBinding = threadId !== undefined
		? registry.getTopicBinding(chatId, threadId)
		: undefined;
	// A topic entry with `cwd === null` is a session-pin-only stub
	// created by ChatSession.attach() for Discord threads — it carries
	// no user-visible /bind, so the whoami/binding UI must treat it
	// the same as "no topic binding".
	const topicBound = topicBinding && topicBinding.cwd ? topicBinding : undefined;
	const lines = [
		`chat_id: ${chatId}`,
		`chat_type: ${ctx.chatType}`,
	];
	if (ctx.chatTitle) lines.push(`chat_title: ${ctx.chatTitle}`);
	if (threadId !== undefined) lines.push(`thread_id: ${threadId}`);
	lines.push("");
	if (topicBound) {
		lines.push(`bound to (topic): ${topicBound.cwd}`);
		if (topicBound.label) lines.push(`label: ${topicBound.label}`);
		lines.push(`since: ${topicBound.added_at}`);
	}
	if (binding && binding.cwd) {
		const tag = topicBound ? "group default" : "bound to (group)";
		lines.push(`${tag}: ${binding.cwd}`);
		if (binding.label) lines.push(`label: ${binding.label}`);
		if (!topicBound) lines.push(`since: ${binding.added_at}`);
	}
	if (!topicBound && !(binding && binding.cwd)) {
		lines.push(`no binding — uses default cwd: ${defaultCwd}`);
		lines.push(threadId !== undefined
			? `bind this topic: /bind <path>`
			: `bind with: /bind <path>`);
	}
	await ctx.reply(lines.join("\n"));
};

const cmdBinding: Handler = async ctx => {
	const { chatId, threadId, registry, defaultCwd } = ctx;
	const binding = registry.getBinding(chatId);
	const topicBinding = threadId !== undefined
		? registry.getTopicBinding(chatId, threadId)
		: undefined;
	// See cmdWhoami: null-cwd topics are pin-only stubs, invisible to UI.
	const topicBound = topicBinding && topicBinding.cwd ? topicBinding : undefined;
	const hasGroup = !!(binding && binding.cwd);
	const allTopicIds = registry.topicBindingIds(chatId);
	// Filter out pin-only topics from the configured-topics list — they
	// were never `/bind`'d so listing them surfaces a phantom entry the
	// user didn't create.
	const topicIds = allTopicIds.filter(tid => {
		const t = registry.getTopicBinding(chatId, tid);
		return !!(t && t.cwd);
	});
	if (!topicBound && !hasGroup && topicIds.length === 0) {
		await ctx.reply(
			`no binding for chat ${chatId}${threadId !== undefined ? ` topic ${threadId}` : ""}\nfalls back to default: ${defaultCwd}`,
		);
		return;
	}
	const lines = [`chat_id: ${chatId}`];
	if (threadId !== undefined) lines.push(`thread_id: ${threadId}`);
	lines.push("");
	if (topicBound) {
		lines.push(`topic ${threadId} cwd: ${topicBound.cwd}`);
		if (topicBound.label) lines.push(`  label: ${topicBound.label}`);
		lines.push(`  added: ${topicBound.added_at}`);
	}
	if (hasGroup) {
		lines.push(`group cwd: ${binding!.cwd}`);
		if (binding!.label) lines.push(`  label: ${binding!.label}`);
		lines.push(`  added: ${binding!.added_at}`);
	}
	if (topicIds.length > 0) {
		lines.push("", "configured topics:");
		// Numeric-aware lexicographic compare: works for Telegram message_thread_id
		// (small ints) AND Discord snowflakes (> 2^53, would lose precision under Number()).
		const sorted = [...topicIds].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
		for (const tid of sorted) {
			const t = registry.getTopicBinding(chatId, tid)!;
			const mark = String(threadId) === tid ? " ←" : "";
			lines.push(`  ${tid}: ${t.cwd}${mark}`);
		}
	}
	await ctx.reply(lines.join("\n"));
};

const cmdBind: Handler = async ctx => {
	const raw = ctx.arg;
	if (!raw) {
		await ctx.reply([
			"usage: /bind <path> [|label]",
			"  e.g. /bind ~/Workspaces/omptg",
			"  e.g. /bind ~/Workspaces/foo|foo dev",
			"",
			"the new cwd takes effect on the next /new — the current session keeps its cwd",
		].join("\n"));
		return;
	}
	const sep = raw.indexOf("|");
	const pathPart = (sep >= 0 ? raw.slice(0, sep) : raw).trim();
	const label = sep >= 0 ? raw.slice(sep + 1).trim() : undefined;
	if (!pathPart) {
		// Guard: `resolvePath("")` returns process.cwd(), which would
		// silently bind to wherever the bot was launched (typically not
		// what `/bind |label` was meant to do — most likely a typo).
		await ctx.reply("❌ empty path; usage: /bind <path> [|label]");
		return;
	}
	const expanded = expandHome(pathPart);
	const abs = resolvePath(expanded);
	if (!existsSync(abs)) {
		await ctx.reply(`❌ not found: ${abs}`);
		return;
	}
	if (!statSync(abs).isDirectory()) {
		await ctx.reply(`❌ not a directory: ${abs}`);
		return;
	}
	const { chatId, threadId, registry } = ctx;
	registry.setBinding(chatId, { cwd: abs, label }, { threadId });
	const chat = registry.get(chatId, threadId);
	const scope = threadId !== undefined ? `topic ${threadId}` : "group";
	const lines = [
		`✓ bound ${scope} to ${abs}`,
		label ? `label: ${label}` : undefined,
		"",
		chat.cwd === abs
			? "(already current cwd — nothing to switch)"
			: "/new to apply (current session keeps cwd: " + chat.cwd + ")",
	].filter(Boolean) as string[];
	await ctx.reply(lines.join("\n"));
	log.info("bind.set", { chat_id: chatId, thread_id: threadId, cwd: abs, label });
};

const cmdUnbind: Handler = async ctx => {
	const { chatId, threadId, registry, defaultCwd } = ctx;
	const removed = registry.deleteBinding(chatId, threadId);
	if (!removed) {
		await ctx.reply(`no binding to remove (already using default: ${defaultCwd})`);
		return;
	}
	const scope = threadId !== undefined ? `topic ${threadId}` : "group";
	await ctx.reply([
		`✓ unbound ${scope} — fallback applies on next /new`,
		`(current session keeps its cwd)`,
	].join("\n"));
	log.info("bind.removed", { chat_id: chatId, thread_id: threadId });
};

const cmdNew: Handler = async ctx => {
	const { chatId, threadId, registry } = ctx;
	const chat = registry.get(chatId, threadId);
	const desiredCwd = registry.cwdFor(chatId, threadId);
	if (chat.isStreaming) await chat.abort();
	if (chat.cwd !== desiredCwd) {
		await chat.switchCwd(desiredCwd);
	} else {
		await chat.newSession();
	}
	await ctx.reply(`✨ fresh session in ${chat.cwd}\nid: ${chat.sessionId}`);
};

const cmdSessions: Handler = async ctx => {
	const chat = ctx.registry.get(ctx.chatId, ctx.threadId);
	const arg = ctx.arg;
	let limit = SESSIONS_DEFAULT_LIMIT;
	if (arg) {
		const n = Number.parseInt(arg, 10);
		if (!Number.isFinite(n) || n < 1) {
			await ctx.reply(
				`usage: /sessions [n]   1..${SESSIONS_MAX_LIMIT}, default ${SESSIONS_DEFAULT_LIMIT}`,
			);
			return;
		}
		limit = Math.min(n, SESSIONS_MAX_LIMIT);
	}
	const sessions = await listStoredSessions(chat.cwd, limit);
	if (sessions.length === 0) {
		await ctx.reply(`no stored sessions in ${chat.cwd}`);
		return;
	}
	chat.recentSessions = sessions;
	const lines = sessions.map((s, i) => {
		const ts = s.modified.toISOString().slice(5, 16).replace("T", " ");
		const raw = s.title || s.firstMessage || "(no message)";
		const preview = (raw.split("\n")[0] ?? "").slice(0, 70);
		return `${i + 1}. [${ts}] ${preview}`;
	});
	const footer = sessions.length >= limit && limit < SESSIONS_MAX_LIMIT
		? `…showing ${limit}; pass a larger number e.g. /sessions ${Math.min(limit * 2, SESSIONS_MAX_LIMIT)}`
		: "use /resume <n> to reopen";
	await ctx.reply([`recent sessions in ${chat.cwd}`, "", ...lines, "", footer].join("\n"));
};

const cmdResume: Handler = async ctx => {
	const arg = ctx.arg;
	const chat = ctx.registry.get(ctx.chatId, ctx.threadId);
	let targetPath: string;
	let targetIndex: number;
	if (!arg) {
		const latest = await listStoredSessions(chat.cwd, 1);
		if (latest.length === 0) {
			await ctx.reply(`no stored sessions in ${chat.cwd}`);
			return;
		}
		targetPath = latest[0]!.path;
		targetIndex = 1;
	} else {
		const n = Number.parseInt(arg, 10);
		const cached = chat.recentSessions;
		if (!Number.isFinite(n) || n < 1 || n > cached.length) {
			await ctx.reply("invalid index; run /sessions first");
			return;
		}
		targetPath = cached[n - 1]!.path;
		targetIndex = n;
	}
	if (chat.isStreaming) await chat.abort();
	try {
		await chat.resume(targetPath);
		await ctx.reply(
			`📜 resumed #${targetIndex} ${chat.sessionId}\ncwd: ${chat.cwd}`,
		);
	} catch (err) {
		await ctx.reply(`failed to resume: ${err instanceof Error ? err.message : err}`);
	}
};

const cmdRetitle: Handler = async ctx => {
	const chat = ctx.registry.get(ctx.chatId, ctx.threadId);
	if (!chat.hasSession) {
		await ctx.reply("no active session — send a message or /new first");
		return;
	}
	const arg = ctx.arg;
	if (arg) {
		const ok = await chat.setTitle(arg);
		await ctx.reply(ok ? `✓ renamed to: ${arg}` : "failed to rename");
		return;
	}
	await ctx.reply("regenerating title…");
	const newTitle = await chat.regenerateTitle();
	await ctx.reply(
		newTitle
			? `✓ renamed to: ${newTitle}`
			: "couldn't regenerate (no user prompt in history, or generator returned null)",
	);
};

/** Dispatch table — every name in SLASH_COMMANDS MUST map to a handler. */
const HANDLERS: Record<string, Handler> = {
	start:    cmdStart,
	status:   cmdStatus,
	model:    cmdModel,
	compact:  cmdCompact,
	cancel:   cmdCancel,
	whoami:   cmdWhoami,
	binding:  cmdBinding,
	bind:     cmdBind,
	unbind:   cmdUnbind,
	new:      cmdNew,
	sessions: cmdSessions,
	resume:   cmdResume,
	retitle:  cmdRetitle,
};

// Compile-time-ish guard: every command in SLASH_COMMANDS must have a
// dispatch entry. Catches the foot-gun where a contributor adds a row
// to SLASH_COMMANDS but forgets the matching HANDLERS entry, which
// would otherwise silently no-op on Telegram (Discord surfaces it as
// "unknown command"; the asymmetry is the trap). Throws at module
// load so both `main.ts` and `discord-main.ts` fail fast on boot.
for (const spec of SLASH_COMMANDS) {
	if (!HANDLERS[spec.command]) {
		throw new Error(`commands.ts: SLASH_COMMANDS row "${spec.command}" has no HANDLERS entry`);
	}
}

/** Run a slash command by name. Returns false when the name has no
 *  registered handler (caller decides how to report). */
export async function runSlashCommand(name: string, ctx: CommandContext): Promise<boolean> {
	const h = HANDLERS[name];
	if (!h) return false;
	await h(ctx);
	return true;
}

/* ─────────────────────────  Telegram adapter  ────────────────────────── */

export function installCommands(deps: Deps): void {
	const { bot, registry, defaultCwd } = deps;

	for (const spec of SLASH_COMMANDS) {
		bot.command(spec.command, async ctx => {
			const tgCtx: CommandContext = {
				chatId: ctx.chat.id,
				threadId: extractThreadId(ctx.message),
				chatType: ctx.chat.type,
				chatTitle: "title" in ctx.chat ? ctx.chat.title : undefined,
				arg: ctx.match?.trim() ?? "",
				registry,
				defaultCwd,
				reply: text => ctx.reply(text),
			};
			await runSlashCommand(spec.command, tgCtx);
		});
	}
}

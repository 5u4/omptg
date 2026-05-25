/**
 * All slash commands in one place. Each command is a tiny closure over
 * `Deps`; registering them is `installCommands(deps)` from main.ts.
 *
 * SLASH_COMMANDS (the metadata pushed to Telegram via setMyCommands)
 * lives here too so the source-of-truth for "what /commands exist" is
 * a single export. `knownCommands()` is the lookup used by the text
 * handler to detect unknown /commands.
 */
import { existsSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { Deps } from "./deps.ts";
import { scoped } from "./logger.ts";
import { extractThreadId } from "./topic.ts";
import { listStoredSessions } from "./chat.ts";
import { expandHome } from "./chat-store.ts";

const log = scoped("commands");

const SESSIONS_DEFAULT_LIMIT = 8;
const SESSIONS_MAX_LIMIT = 50;

/**
 * Command metadata pushed to telegram via setMyCommands so they appear
 * in the `/` autocomplete menu. Kept in registration order = display order.
 */
export const SLASH_COMMANDS = [
	{ command: "new",      description: "Start a fresh session in the current cwd" },
	{ command: "sessions", description: "List recent stored sessions (default 8)" },
	{ command: "resume",   description: "Reopen session — no arg = most recent" },
	{ command: "cancel",   description: "Abort the current turn (keeps session)" },
	{ command: "status",   description: "Show session id, model, cwd" },
	{ command: "model",    description: "Switch model — no arg opens picker" },
	{ command: "compact",  description: "Manually compact session context" },
	{ command: "whoami",   description: "Show this chat's id + binding" },
	{ command: "bind",     description: "/bind <path> — pin chat or topic to a cwd" },
	{ command: "unbind",   description: "Remove binding for this scope" },
	{ command: "binding",  description: "Show topic + group bindings" },
	{ command: "retitle",  description: "/retitle [name] — rename current session, or regen via LLM if no name" },
	{ command: "start",    description: "Show help" },
] as const;

let _knownCommands: Set<string> | undefined;
/** Lazy memo so the text-handler "unknown /command" check is allocation-free. */
export function knownCommands(): Set<string> {
	if (!_knownCommands) {
		_knownCommands = new Set(SLASH_COMMANDS.map(c => c.command));
	}
	return _knownCommands;
}

export function installCommands(deps: Deps): void {
	const { bot, registry, defaultCwd } = deps;

	bot.command("start", ctx =>
		ctx.reply(
			[
				"omptg up.",
				`cwd: ${defaultCwd}`,
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
			].join("\n"),
		),
	);

	bot.command("status", async ctx => {
		const chat = registry.get(ctx.chat.id, extractThreadId(ctx.message));
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
	});

	bot.command("model", async ctx => {
		const chat = registry.get(ctx.chat.id, extractThreadId(ctx.message));
		const arg = ctx.match?.trim();
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
	});

	bot.command("compact", async ctx => {
		const chat = registry.get(ctx.chat.id, extractThreadId(ctx.message));
		const instructions = ctx.match?.trim() || undefined;
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
	});

	bot.command("cancel", async ctx => {
		const chat = registry.get(ctx.chat.id, extractThreadId(ctx.message));
		const cancelled = await chat.abort();
		await ctx.reply(cancelled ? "aborted" : "nothing to cancel");
	});

	bot.command("whoami", async ctx => {
		const chatId = ctx.chat.id;
		const threadId = extractThreadId(ctx.message);
		const binding = registry.bindings.get(chatId);
		const topicBinding = threadId !== undefined
			? registry.bindings.getTopic(chatId, threadId)
			: undefined;
		const lines = [
			`chat_id: ${chatId}`,
			`chat_type: ${ctx.chat.type}`,
		];
		const title = "title" in ctx.chat ? ctx.chat.title : undefined;
		if (title) lines.push(`chat_title: ${title}`);
		if (threadId !== undefined) lines.push(`thread_id: ${threadId}`);
		lines.push("");
		if (topicBinding) {
			lines.push(`bound to (topic): ${topicBinding.cwd}`);
			if (topicBinding.label) lines.push(`label: ${topicBinding.label}`);
			lines.push(`since: ${topicBinding.added_at}`);
		}
		if (binding && binding.cwd) {
			const tag = topicBinding ? "group default" : "bound to (group)";
			lines.push(`${tag}: ${binding.cwd}`);
			if (binding.label) lines.push(`label: ${binding.label}`);
			if (!topicBinding) lines.push(`since: ${binding.added_at}`);
		}
		if (!topicBinding && !(binding && binding.cwd)) {
			lines.push(`no binding — uses default cwd: ${defaultCwd}`);
			lines.push(threadId !== undefined
				? `bind this topic: /bind <path>`
				: `bind with: /bind <path>`);
		}
		await ctx.reply(lines.join("\n"));
	});

	bot.command("binding", async ctx => {
		const chatId = ctx.chat.id;
		const threadId = extractThreadId(ctx.message);
		const binding = registry.bindings.get(chatId);
		const topicBinding = threadId !== undefined
			? registry.bindings.getTopic(chatId, threadId)
			: undefined;
		const hasGroup = !!(binding && binding.cwd);
		const topicIds = registry.bindings.topicIds(chatId);
		if (!topicBinding && !hasGroup && topicIds.length === 0) {
			await ctx.reply(
				`no binding for chat ${chatId}${threadId !== undefined ? ` topic ${threadId}` : ""}\nfalls back to default: ${defaultCwd}`,
			);
			return;
		}
		const lines = [`chat_id: ${chatId}`];
		if (threadId !== undefined) lines.push(`thread_id: ${threadId}`);
		lines.push("");
		if (topicBinding) {
			lines.push(`topic ${threadId} cwd: ${topicBinding.cwd}`);
			if (topicBinding.label) lines.push(`  label: ${topicBinding.label}`);
			lines.push(`  added: ${topicBinding.added_at}`);
		}
		if (hasGroup) {
			lines.push(`group cwd: ${binding!.cwd}`);
			if (binding!.label) lines.push(`  label: ${binding!.label}`);
			lines.push(`  added: ${binding!.added_at}`);
		}
		if (topicIds.length > 0) {
			lines.push("", "configured topics:");
			for (const tid of topicIds.sort((a, b) => Number(a) - Number(b))) {
				const t = registry.bindings.getTopic(chatId, tid)!;
				const mark = String(threadId) === tid ? " ←" : "";
				lines.push(`  ${tid}: ${t.cwd}${mark}`);
			}
		}
		await ctx.reply(lines.join("\n"));
	});

	bot.command("bind", async ctx => {
		const raw = ctx.match?.trim();
		if (!raw) {
			await ctx.reply(
				[
					"usage: /bind <path> [|label]",
					"  e.g. /bind ~/Workspaces/omptg",
					"  e.g. /bind ~/Workspaces/foo|foo dev",
					"",
					"the new cwd takes effect on the next /new — the current session keeps its cwd",
				].join("\n"),
			);
			return;
		}
		// Optional `|label` suffix, split on first `|` only.
		const sep = raw.indexOf("|");
		const pathPart = (sep >= 0 ? raw.slice(0, sep) : raw).trim();
		const label = sep >= 0 ? raw.slice(sep + 1).trim() : undefined;
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
		const threadId = extractThreadId(ctx.message);
		if (threadId !== undefined) {
			registry.bindings.setTopic(ctx.chat.id, threadId, { cwd: abs, label });
		} else {
			registry.bindings.set(ctx.chat.id, { cwd: abs, label });
		}
		const chat = registry.get(ctx.chat.id, threadId);
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
		log.info("bind.set", { chat_id: ctx.chat.id, thread_id: threadId, cwd: abs, label });
	});

	bot.command("unbind", async ctx => {
		const threadId = extractThreadId(ctx.message);
		const removed = threadId !== undefined
			? registry.bindings.deleteTopic(ctx.chat.id, threadId)
			: registry.bindings.delete(ctx.chat.id);
		if (!removed) {
			await ctx.reply(`no binding to remove (already using default: ${defaultCwd})`);
			return;
		}
		const scope = threadId !== undefined ? `topic ${threadId}` : "group";
		await ctx.reply(
			[
				`✓ unbound ${scope} — fallback applies on next /new`,
				`(current session keeps its cwd)`,
			].join("\n"),
		);
		log.info("bind.removed", { chat_id: ctx.chat.id, thread_id: threadId });
	});

	bot.command("new", async ctx => {
		const threadId = extractThreadId(ctx.message);
		const chat = registry.get(ctx.chat.id, threadId);
		const desiredCwd = registry.cwdFor(ctx.chat.id, threadId);
		if (chat.isStreaming) {
			await chat.abort();
		}
		// If the binding changed since this chat's session was created,
		// the fresh session should land in the new cwd. switchCwd disposes
		// the old session and creates a new one in the target cwd.
		if (chat.cwd !== desiredCwd) {
			await chat.switchCwd(desiredCwd);
		} else {
			await chat.newSession();
		}
		await ctx.reply(`✨ fresh session in ${chat.cwd}\nid: ${chat.sessionId}`);
	});

	bot.command("sessions", async ctx => {
		const chat = registry.get(ctx.chat.id, extractThreadId(ctx.message));
		const arg = ctx.match?.trim();
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
			// Prefer the LLM-generated title; fall back to the first user
			// message; last resort the placeholder.
			const raw = s.title || s.firstMessage || "(no message)";
			const preview = (raw.split("\n")[0] ?? "").slice(0, 70);
			return `${i + 1}. [${ts}] ${preview}`;
		});
		const footer = sessions.length >= limit && limit < SESSIONS_MAX_LIMIT
			? `…showing ${limit}; pass a larger number e.g. /sessions ${Math.min(limit * 2, SESSIONS_MAX_LIMIT)}`
			: "use /resume <n> to reopen";
		await ctx.reply(
			[`recent sessions in ${chat.cwd}`, "", ...lines, "", footer].join("\n"),
		);
	});

	bot.command("resume", async ctx => {
		const arg = ctx.match?.trim();
		const chat = registry.get(ctx.chat.id, extractThreadId(ctx.message));
		let targetPath: string;
		let targetIndex: number;
		if (!arg) {
			// No index: resume the most recent stored session in this cwd.
			// Independent of /sessions cache so it works on a cold chat.
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
			// `recentSessions` is `[]` until the first `/sessions` runs;
			// length===0 + n>=1 falls into the same "invalid" branch.
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
	});

	bot.command("retitle", async ctx => {
		const chat = registry.get(ctx.chat.id, extractThreadId(ctx.message));
		if (!chat.hasSession) {
			await ctx.reply("no active session — send a message or /new first");
			return;
		}
		const arg = ctx.match?.trim();
		if (arg) {
			const ok = await chat.setTitle(arg);
			await ctx.reply(ok ? `✓ renamed to: ${arg}` : "failed to rename");
			return;
		}
		// No arg: regenerate via LLM. Show a placeholder so the user knows
		// something is happening — the call takes a beat (one LLM round-trip).
		await ctx.reply("regenerating title…");
		const newTitle = await chat.regenerateTitle();
		await ctx.reply(
			newTitle
				? `✓ renamed to: ${newTitle}`
				: "couldn't regenerate (no user prompt in history, or generator returned null)",
		);
	});
}

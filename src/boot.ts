/**
 * One-shot boot-time tasks, grouped here so main.ts can call them in
 * order and stay focused on wiring.
 *
 *   - registerSlashCommands    push SLASH_COMMANDS to every relevant scope
 *   - wipeChatCommandOverrides clear stale per-chat command lists that
 *                              would shadow our scope-level registration
 *   - probeWebhook             detect + delete a stale webhook stealing
 *                              our updates
 *   - runLogRotation           prune / compress logs at boot
 *
 * All four are best-effort: a transient network failure logs a warning
 * and continues — none of them is fatal.
 */
import { initTheme } from "@oh-my-pi/pi-coding-agent";
import type { Deps } from "./deps.ts";
import { scoped, logPath, logDir } from "./logger.ts";
import { rotateLogs } from "./log-rotate.ts";
import { SLASH_COMMANDS } from "./commands.ts";

const log = scoped("boot");

const COMMAND_SCOPES = [
	{ type: "default" },
	{ type: "all_private_chats" },
	{ type: "all_group_chats" },
	{ type: "all_chat_administrators" },
] as const;

/**
 * Register slash commands with Telegram so they show up in autocomplete
 * and the menu button. Telegram scopes the command menu separately per
 * surface: the default scope only covers private chats, so groups won't
 * see autocomplete unless we also push to all_group_chats (and
 * all_chat_administrators so admin-only groups still see them).
 *
 * Best-effort: a network blip is not fatal — the bot can still receive
 * /commands without registration.
 */
export async function registerSlashCommands(deps: Deps): Promise<void> {
	const registered: Array<{ scope: string; ok: boolean; err?: string }> = [];
	for (const scope of COMMAND_SCOPES) {
		try {
			await deps.bot.api.setMyCommands([...SLASH_COMMANDS], { scope });
			registered.push({ scope: scope.type, ok: true });
		} catch (err) {
			registered.push({ scope: scope.type, ok: false, err: String(err) });
		}
	}
	log.info("commands_registered", { results: registered });
}

/**
 * `chat` scope overrides all broader scopes. If the bot was ever used
 * by a different codebase (or earlier version) that pushed a chat-specific
 * command list to a chat we now control, telegram clients in that chat
 * will keep showing the stale list. Wipe overrides for every chat we
 * know about so they fall through to our all_group_chats /
 * all_private_chats registration.
 */
export async function wipeChatCommandOverrides(deps: Deps): Promise<void> {
	const overrideChats = new Set<string>();
	for (const id of deps.allowedChats) overrideChats.add(id);
	for (const id of deps.chatStore.chatIds()) overrideChats.add(id);
	const wiped: Array<{ chat_id: string; ok: boolean; err?: string }> = [];
	for (const id of overrideChats) {
		try {
			await deps.bot.api.deleteMyCommands({
				scope: { type: "chat", chat_id: Number(id) },
			});
			wiped.push({ chat_id: id, ok: true });
		} catch (err) {
			// Most likely error: bot is not a member of that chat (private
			// chat the bot was never in, or a group we left). Not fatal.
			wiped.push({ chat_id: id, ok: false, err: String(err) });
		}
	}
	if (wiped.length > 0) log.info("chat_overrides_wiped", { results: wiped });
}

/**
 * Telegram caches the LAST `allowed_updates` value per bot token. If a
 * previous run (or any other client using this token) called getUpdates
 * without callback_query, telegram will keep filtering them out until
 * we explicitly re-set the list (which bot.start() does below).
 *
 * If a stale webhook is set, delete it but PRESERVE pending updates
 * (`drop_pending_updates: false`) — a callback_query the user tapped
 * while the webhook was active should still be delivered to us via
 * polling once it's gone.
 */
export async function probeWebhook(deps: Deps): Promise<void> {
	try {
		const info = await deps.bot.api.getWebhookInfo();
		log.info("webhook_info", {
			url: info.url,
			pending_update_count: info.pending_update_count,
			allowed_updates: info.allowed_updates,
			last_error_message: info.last_error_message,
		});
		if (info.url) {
			await deps.bot.api.deleteWebhook({ drop_pending_updates: false });
			log.info("webhook_deleted");
		}
	} catch (err) {
		log.warn("webhook_probe_failed", { err: String(err) });
	}
}

/**
 * Prune old structured logs. Cheap; runs once per boot. The active file
 * (today's) is always skipped — see log-rotate.ts. Caps come from
 * OMPTG_LOG_RETAIN_DAYS / OMPTG_LOG_COMPRESS_AFTER_DAYS env vars.
 */
export async function runLogRotation(): Promise<void> {
	const retainDays = Number(Bun.env.OMPTG_LOG_RETAIN_DAYS ?? 30);
	const compressAfterDays = Number(Bun.env.OMPTG_LOG_COMPRESS_AFTER_DAYS ?? 7);
	try {
		const result = await rotateLogs(logDir(), logPath(), {
			retainDays,
			compressAfterDays,
		});
		if (result.planned.length > 0) {
			log.info("log_rotated", {
				planned: result.planned.length,
				done: result.done.length,
				failed: result.failed.length,
				retain_days: retainDays,
				compress_after_days: compressAfterDays,
				details: result.done,
				errors: result.failed,
			});
		}
	} catch (err) {
		log.warn("log_rotate_failed", { err: String(err) });
	}
}

/** Initialize OMP's theme system. Required before any session runs. */
export async function initOmpTheme(): Promise<void> {
	await initTheme();
	log.info("theme_ready");
}

/**
 * Process-level error + signal hooks. `shutdown` disposes every active
 * ChatSession (flushing session files) before exiting.
 */
export function installProcessHooks(deps: Deps): void {
	const shutdown = async (signal: string): Promise<void> => {
		console.log(`\n[shutdown] ${signal}`);
		try {
			await deps.bot.stop();
		} catch {
			/* ignore */
		}
		try {
			await deps.registry.disposeAll();
		} catch (err) {
			log.warn("disposeAll_failed", { err: String(err) });
		}
		try {
			await deps.bridge.dispose();
		} catch (err) {
			log.warn("bridge_dispose_failed", { err: String(err) });
		}
		process.exit(0);
	};

	process.on("uncaughtException", err => {
		log.error("uncaughtException", {
			err: String(err),
			stack: err instanceof Error ? err.stack : undefined,
		});
	});
	process.on("unhandledRejection", reason => {
		log.error("unhandledRejection", {
			reason: String(reason),
			stack: reason instanceof Error ? reason.stack : undefined,
		});
	});
	process.on("exit", code => {
		log.warn("process.exit", { code });
	});

	process.once("SIGINT", () => void shutdown("SIGINT"));
	process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

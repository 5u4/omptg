/**
 * Spike: telegram <-> OMP via in-process SDK.
 *
 * Single-chat / single-cwd / single-AgentSession to validate the loop. We
 * grow this into a per-chat ChatSession registry in the next pass.
 *
 * Run: `bun run src/spike.ts` (loads .env via Bun)
 */
import { Bot, GrammyError, HttpError } from "grammy";
import {
	createAgentSession,
	SessionManager,
} from "@oh-my-pi/pi-coding-agent";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";

const TOKEN = required("TELEGRAM_BOT_TOKEN");
const CWD = required("OMP_DEFAULT_CWD");
const ALLOWED = new Set(
	(Bun.env.TELEGRAM_ALLOWED_CHATS ?? "")
		.split(",")
		.map(s => s.trim())
		.filter(Boolean),
);

function required(key: string): string {
	const v = Bun.env[key];
	if (!v) {
		console.error(`missing required env: ${key}`);
		process.exit(1);
	}
	return v;
}

// One AgentSession for the whole spike. We will key by chat_id later.
let session: AgentSession | undefined;

async function ensureSession(): Promise<AgentSession> {
	if (session) return session;
	console.log(`[boot] creating AgentSession (cwd=${CWD})`);
	const created = await createAgentSession({
		cwd: CWD,
		sessionManager: SessionManager.create(
			CWD,
			SessionManager.getDefaultSessionDir(CWD),
		),
		hasUI: false, // no interactive `ask`; we'll wire that in v1
	});
	if (created.modelFallbackMessage) {
		console.warn(`[boot] ${created.modelFallbackMessage}`);
	}
	session = created.session;
	console.log(
		`[boot] session ready: id=${session.sessionId} model=${session.model?.id ?? "?"}`,
	);
	return session;
}

const bot = new Bot(TOKEN);

bot.use(async (ctx, next) => {
	const id = ctx.chat?.id?.toString();
	if (!id || (ALLOWED.size && !ALLOWED.has(id))) {
		console.warn(`[auth] rejecting chat_id=${id}`);
		return;
	}
	await next();
});

bot.command("start", ctx =>
	ctx.reply(
		`omp-tg spike up.\n` +
			`cwd: ${CWD}\n` +
			`Send any message to talk to the agent.\n` +
			`/cancel to abort, /status for state.`,
	),
);

bot.command("status", async ctx => {
	const s = await ensureSession();
	await ctx.reply(
		`session: ${s.sessionId}\n` +
			`model: ${s.model?.id ?? "?"}\n` +
			`streaming: ${s.isStreaming}\n` +
			`sessionFile: ${s.sessionFile ?? "-"}`,
	);
});

bot.command("cancel", async ctx => {
	if (!session) return ctx.reply("nothing to cancel");
	if (!session.isStreaming) return ctx.reply("not streaming");
	await session.abort();
	await ctx.reply("aborted");
});

bot.on("message:text", async ctx => {
	const text = ctx.message.text;
	if (text.startsWith("/")) return; // grammy already dispatched it

	const s = await ensureSession();

	// Send a status message we'll edit with streaming deltas.
	const status = await ctx.reply("✨ thinking…");
	const statusId = status.message_id;
	const chatId = ctx.chat.id;

	const stream = new TelegramStreamer(bot, chatId, statusId);
	const unsubscribe = s.subscribe(event => handleEvent(event, stream));

	try {
		if (s.isStreaming) {
			await s.steer(text);
		} else {
			await s.prompt(text);
		}
		// prompt() returns once the turn is scheduled; we want to wait for the
		// agent to actually finish so we can flush the final text.
		await s.waitForIdle();
	} catch (err) {
		console.error("[turn] failed:", err);
		await stream.replaceWith(`❌ ${err instanceof Error ? err.message : String(err)}`);
		unsubscribe();
		return;
	}
	unsubscribe();
	await stream.finalize();
});

function handleEvent(event: AgentSessionEvent, stream: TelegramStreamer) {
	switch (event.type) {
		case "message_update": {
			const ame = event.assistantMessageEvent;
			if (ame.type === "text_delta") stream.pushDelta(ame.delta);
			break;
		}
		case "tool_execution_start": {
			// Best-effort hint; refine in v1.
			const t = (event as { tool?: { name?: string } }).tool;
			if (t?.name) stream.pushStatus(`🔧 ${t.name}`);
			break;
		}
		case "notice": {
			const n = event as { level: string; message: string };
			console.log(`[notice/${n.level}] ${n.message}`);
			break;
		}
		case "auto_retry_start":
			console.warn(`[retry] attempt ${(event as any).attempt}`);
			break;
		default:
			break;
	}
}

/**
 * Coalesces streaming text deltas into telegram message edits.
 * Telegram bot API rate-limits edits aggressively (~1/sec per message),
 * so we throttle to every 600ms or every 200 chars, whichever first.
 */
class TelegramStreamer {
	private buffer = "";
	private lastSent = "";
	private statusTail = "";
	private pending: ReturnType<typeof setTimeout> | undefined;
	private inflight = false;
	private finalized = false;
	private readonly MIN_INTERVAL_MS = 600;
	private readonly DELTA_THRESHOLD = 200;

	constructor(
		private readonly bot: Bot,
		private readonly chatId: number,
		private readonly messageId: number,
	) {}

	pushDelta(delta: string) {
		this.buffer += delta;
		this.maybeFlush();
	}

	pushStatus(line: string) {
		this.statusTail = line;
		this.maybeFlush();
	}

	private maybeFlush() {
		if (this.finalized) return;
		const pendingChars = this.buffer.length - this.lastSent.length;
		if (pendingChars >= this.DELTA_THRESHOLD) {
			void this.flush();
		} else if (!this.pending) {
			this.pending = setTimeout(() => {
				this.pending = undefined;
				void this.flush();
			}, this.MIN_INTERVAL_MS);
		}
	}

	private async flush() {
		if (this.inflight || this.finalized) return;
		const next = this.compose();
		if (next === this.lastSent || next.length === 0) return;
		this.inflight = true;
		try {
			await this.bot.api.editMessageText(this.chatId, this.messageId, next);
			this.lastSent = next;
		} catch (err) {
			// "message is not modified" / flood-wait are recoverable; log others.
			const msg = err instanceof Error ? err.message : String(err);
			if (!msg.includes("not modified")) {
				console.warn("[edit] failed:", msg);
			}
		} finally {
			this.inflight = false;
		}
	}

	private compose(): string {
		const body = this.buffer || "✨ thinking…";
		return this.statusTail ? `${body}\n\n${this.statusTail}` : body;
	}

	async finalize() {
		if (this.pending) {
			clearTimeout(this.pending);
			this.pending = undefined;
		}
		this.finalized = true;
		// Final edit with the complete text (no status tail).
		const final = this.buffer || "(no response)";
		if (final !== this.lastSent) {
			try {
				await this.bot.api.editMessageText(this.chatId, this.messageId, final);
			} catch (err) {
				console.warn("[final edit] failed:", err);
			}
		}
	}

	async replaceWith(text: string) {
		this.finalized = true;
		try {
			await this.bot.api.editMessageText(this.chatId, this.messageId, text);
		} catch (err) {
			console.warn("[replace] failed:", err);
		}
	}
}

bot.catch(err => {
	const e = err.error;
	if (e instanceof GrammyError) {
		console.error("[grammy api]", e.description);
	} else if (e instanceof HttpError) {
		console.error("[grammy http]", e.message);
	} else {
		console.error("[grammy]", e);
	}
});

// Graceful shutdown so AgentSession flushes the session file.
async function shutdown(signal: string) {
	console.log(`\n[shutdown] ${signal}`);
	try {
		await bot.stop();
	} catch {}
	if (session) {
		try {
			await session.dispose();
		} catch (err) {
			console.warn("[shutdown] dispose failed:", err);
		}
	}
	process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

console.log("[boot] starting bot polling…");
bot.start({
	onStart: info => console.log(`[boot] @${info.username} ready`),
});

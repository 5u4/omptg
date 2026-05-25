/**
 * Probe: call getUpdates directly with a tiny offset and print what
 * telegram actually has queued for this bot. Bypasses our handlers.
 *
 * Run while bot.start is NOT polling (kill the main bot first), or it'll
 * race for the same offsets.
 *
 *   bun run src/probe-updates.ts
 */
import { Bot } from "grammy";

const TOKEN = Bun.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
	console.error("set TELEGRAM_BOT_TOKEN");
	process.exit(1);
}

const bot = new Bot(TOKEN);
await bot.init();

console.log("=== webhook info ===");
const info = await bot.api.getWebhookInfo();
console.log(JSON.stringify(info, null, 2));

console.log("\n=== first 20 pending updates (allowed_updates=all) ===");
// Pass empty allowed_updates? No — "[]" means "default" (which excludes
// callback_query). Use the explicit list including everything we want
// to see. Telegram returns up to `limit` queued updates.
const updates = await bot.api.getUpdates({
	limit: 20,
	timeout: 0,
	allowed_updates: ["message", "edited_message", "callback_query"],
});

console.log(`got ${updates.length} updates`);
for (const u of updates) {
	const kind = u.callback_query
		? "callback_query"
		: u.message
			? "message"
			: u.edited_message
				? "edited_message"
				: Object.keys(u).filter(k => k !== "update_id")[0];
	const summary: Record<string, unknown> = { update_id: u.update_id, kind };
	if (u.callback_query) {
		summary.cb_data = u.callback_query.data;
		summary.from = u.callback_query.from.id;
		summary.msg_id = u.callback_query.message?.message_id;
		summary.chat_id = u.callback_query.message?.chat.id;
	} else if (u.message) {
		summary.text = u.message.text?.slice(0, 80);
		summary.chat_id = u.message.chat.id;
	}
	console.log(JSON.stringify(summary));
}

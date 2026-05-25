/**
 * Minimal callback test. Bypasses our ChatRegistry / UI bridge entirely.
 * Just sends a single inline keyboard and prints whatever telegram returns
 * for the next 60 seconds.
 *
 * Run while NO other instance of the bot is polling.
 *
 *   bun run src/probe-callback.ts <chat_id>
 */
const TOKEN = Bun.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
	console.error("set TELEGRAM_BOT_TOKEN");
	process.exit(1);
}
const CHAT_ID = Bun.argv[2];
if (!CHAT_ID) {
	console.error("usage: bun run src/probe-callback.ts <chat_id>");
	process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;

async function api(method: string, body: unknown): Promise<any> {
	const res = await fetch(`${API}/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const j = (await res.json()) as { ok: boolean; result?: any; description?: string };
	if (!j.ok) {
		console.error(`${method} failed:`, j);
		process.exit(1);
	}
	return j.result;
}

console.log("=== sending inline keyboard ===");
const sent = await api("sendMessage", {
	chat_id: CHAT_ID,
	text: "probe: tap one of these buttons",
	reply_markup: {
		inline_keyboard: [
			[
				{ text: "ping-a", callback_data: "probe:a" },
				{ text: "ping-b", callback_data: "probe:b" },
			],
		],
	},
});
console.log(`sent message_id=${sent.message_id}`);

console.log("\n=== polling getUpdates for 60s ===");
const deadline = Date.now() + 60_000;
let offset = 0;
while (Date.now() < deadline) {
	const updates = await api("getUpdates", {
		offset,
		timeout: 5,
		allowed_updates: ["message", "callback_query"],
	});
	for (const u of updates) {
		console.log(JSON.stringify(u, null, 2));
		offset = u.update_id + 1;
		if (u.callback_query) {
			console.log("\n✓ got callback_query — telegram delivery works fine");
			await api("answerCallbackQuery", {
				callback_query_id: u.callback_query.id,
				text: "probe ack",
			});
			process.exit(0);
		}
	}
}
console.log("\n✗ 60s elapsed, no callback_query received");
console.log("  this means telegram is NOT delivering button taps for this bot");

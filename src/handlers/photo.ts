/**
 * Image input — Hermes-style indirect vision.
 *
 * We DO NOT pass image bytes directly to session.prompt({ images }).
 * That route gets stripped by the SDK's vision-guard whenever the active
 * model's catalog entry lacks "image" input — and a user's preferred
 * long-context default (e.g. claude-opus-4.7-1m-internal) is text-only
 * even when the base claude-opus-4.7 is multimodal.
 *
 * Instead: download the photo to ~/.omptg/image-cache/<uuid>.<ext> and
 * hand the main agent a *text* prompt referencing the local path. The
 * main agent already has the `inspect_image` tool (OMP built-in), which
 * resolves modelRoles.vision and runs an out-of-band vision call with
 * a focused question. The default model stays in charge of context
 * (history + caption + when to look), the vision model only sees one
 * image at a time, and history stays text-only so subsequent turns
 * don't need vision-capable models.
 */
import type { Deps } from "../deps.ts";
import { scoped } from "../logger.ts";
import { extractThreadId } from "../topic.ts";
import { downloadPhotoToCache } from "../media.ts";
import { runTurn } from "./turn.ts";

const log = scoped("photo");

export function installPhotoHandler(deps: Deps): void {
	deps.bot.on("message:photo", async ctx => {
		const photos = ctx.message.photo;
		const largest = photos[photos.length - 1];
		if (!largest) return; // telegram always sends ≥1, defensive
		const caption = ctx.message.caption?.trim() ?? "";
		const chatId = ctx.chat.id;
		const threadId = extractThreadId(ctx.message);
		const replyTo = ctx.message.message_id;

		void (async () => {
			let promptText: string;
			try {
				const { path, bytes } = await downloadPhotoToCache(deps.bot, largest.file_id);
				log.info("cached", { chat_id: chatId, path, bytes });

				// Prompt format: the local path on its own line so the agent
				// can lift it verbatim into inspect_image(path=...), followed
				// by the user's caption (or an explicit "no caption" sentinel
				// so the agent doesn't think we forgot to forward it).
				promptText = [
					`[user attached image: ${path}]`,
					"",
					caption || "(no caption — describe or ask what they want)",
				].join("\n");
			} catch (err) {
				// Download / cache failure is a setup error, not a turn error
				// — surface it directly without going through runTurn (which
				// would call endTurn on a chat that never started a turn).
				//
				// NOTE: we deliberately did NOT materialize a ChatSession yet
				// (registry.get is below); otherwise a chat that only ever
				// sent failed-download photos would accumulate idle sessions
				// in the registry for the bot's lifetime.
				log.error("download_failed", {
					chat_id: chatId,
					err: String(err),
				});
				try {
					await ctx.reply(`❌ ${err instanceof Error ? err.message : String(err)}`, {
						reply_parameters: { message_id: replyTo },
					});
				} catch (replyErr) {
					log.error("error_reply_failed", { err: String(replyErr) });
				}
				return;
			}

			const chat = deps.registry.get(chatId, threadId);
			await runTurn({
				chat,
				prompt: promptText,
				replyTo,
				source: "photo",
			});
		})();
	});
}

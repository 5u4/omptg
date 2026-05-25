/**
 * Helpers for downloading telegram-hosted media (photos, voice, etc.)
 * and converting it into the SDK's `ImageContent` shape.
 *
 * Telegram's bot API gives us a `file_id` per attachment; calling
 * `bot.api.getFile(file_id)` resolves it to a relative `file_path`
 * which we fetch via the public file CDN. We then base64 the bytes
 * and tag with the mime type the SDK expects.
 */
import type { Bot } from "grammy";
import type { ImageContent } from "@oh-my-pi/pi-ai";

/**
 * Resolve a telegram `file_id` → ImageContent ready for `session.prompt`.
 *
 * `mimeType` defaults to `image/jpeg` because telegram serves all photo
 * sizes as JPEGs regardless of the original upload. Callers downloading
 * non-photo media (stickers, documents) MUST pass the correct mime.
 *
 * Throws on network / API failure. Caller decides whether to surface to
 * the user or fall back to a text-only prompt.
 */
export async function downloadAsImageContent(
	bot: Bot,
	fileId: string,
	mimeType = "image/jpeg",
): Promise<ImageContent> {
	const file = await bot.api.getFile(fileId);
	if (!file.file_path) {
		throw new Error(`getFile returned no file_path for ${fileId}`);
	}
	// The file URL uses the bot token; never log this.
	const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`download ${file.file_path} → HTTP ${res.status}`);
	}
	const buf = await res.arrayBuffer();
	const data = Buffer.from(buf).toString("base64");
	return { type: "image", data, mimeType };
}

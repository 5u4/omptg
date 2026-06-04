/**
 * Phase 4.5 — Discord image attachments.
 *
 * Covers the two pieces of the new path that have non-trivial logic:
 *   - pickImageAttachments: content-type vs filename-extension classification
 *   - cacheImageFromUrl: end-to-end download → cache → mime resolution
 *     against a real local HTTP server (no mocks, no grammY).
 *
 * The wiring in installDiscordMessageHandler itself is exercised only
 * indirectly — building a Message mock complete enough to drive
 * `messageCreate` is more ceremony than the branch warrants.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attachment, Message } from "discord.js";

// Redirect the image cache to a per-run tempdir *before* importing
// media.ts, otherwise writes pollute the dev's real ~/.omptg cache and
// (in the rare case where it's > 200MB) pruning would evict unrelated
// files. media.ts resolves the env var lazily on first call, so setting
// it any time before the first cacheImageFromUrl invocation works —
// doing it at module load keeps it ordered ahead of beforeAll.
const CACHE_ROOT = mkdtempSync(join(tmpdir(), "omptg-image-cache-test-"));
process.env["OMPTG_IMAGE_CACHE_DIR"] = CACHE_ROOT;

const { pickImageAttachments } = await import("../src/handlers/discord/message.ts");
const { cacheImageFromUrl } = await import("../src/media.ts");

/** Minimal Attachment stand-in — `pickImageAttachments` only touches
 *  `contentType` and `name`. */
type AttachmentStub = Pick<Attachment, "contentType" | "name"> & { url: string };

function msgWith(...atts: AttachmentStub[]): Message {
	return {
		attachments: new Map(atts.map((a, i) => [String(i), a as unknown as Attachment])),
	} as unknown as Message;
}

describe("pickImageAttachments", () => {
	test("keeps attachments whose contentType starts with image/", () => {
		const png = { contentType: "image/png", name: "x.png", url: "" };
		const jpg = { contentType: "image/jpeg", name: "y.jpg", url: "" };
		const got = pickImageAttachments(msgWith(png, jpg));
		expect(got.map(a => a.name)).toEqual(["x.png", "y.jpg"]);
	});

	test("drops non-image content types", () => {
		const got = pickImageAttachments(msgWith(
			{ contentType: "video/mp4", name: "clip.mp4", url: "" },
			{ contentType: "application/pdf", name: "doc.pdf", url: "" },
		));
		expect(got).toHaveLength(0);
	});

	test("falls back to filename extension when contentType is missing", () => {
		const got = pickImageAttachments(msgWith(
			{ contentType: null, name: "no-ct.webp", url: "" },
			{ contentType: null, name: "weird.bin", url: "" },
		));
		expect(got.map(a => a.name)).toEqual(["no-ct.webp"]);
	});

	test("is case-insensitive on both contentType and extension", () => {
		const got = pickImageAttachments(msgWith(
			{ contentType: "IMAGE/PNG", name: "a.PNG", url: "" },
			{ contentType: null, name: "B.JPEG", url: "" },
		));
		expect(got).toHaveLength(2);
	});
});

describe("cacheImageFromUrl", () => {
	// 1x1 PNG (smallest valid PNG that decoders accept).
	const PNG_BYTES = Buffer.from(
		"89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
		+ "890000000d4944415478da6300010000000500010d0a2db40000000049454e44"
		+ "ae426082",
		"hex",
	);
	let server: Server;
	let base: string;
	const cleanup: string[] = [];

	beforeAll(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		server = createServer((req, res) => {
			const url = new URL(req.url ?? "/", "http://x");
			if (url.pathname === "/photo.png") {
				res.writeHead(200, { "content-type": "image/png" });
				res.end(PNG_BYTES);
			} else if (url.pathname === "/no-ct") {
				// Server omits content-type; classifier must fall back to filename hint.
				res.writeHead(200);
				res.end(PNG_BYTES);
			} else if (url.pathname === "/octet") {
				res.writeHead(200, { "content-type": "application/octet-stream" });
				res.end(PNG_BYTES);
			} else if (url.pathname === "/huge") {
				// Declared length > MAX_DOWNLOAD_BYTES (50 MB); pre-buffer
				// guard must reject before reading the body.
				res.writeHead(200, {
					"content-type": "image/png",
					"content-length": String(60 * 1024 * 1024),
				});
				res.end(PNG_BYTES);
			} else if (url.pathname === "/lying") {
				// Server omits content-length but streams more bytes
				// than the cap allows; the streaming guard must abort
				// without buffering everything first.
				res.writeHead(200, { "content-type": "image/png" });
				const big = Buffer.alloc(1024 * 1024); // 1 MB chunk
				let sent = 0;
				const target = 60 * 1024 * 1024;
				const pump = (): void => {
					while (sent < target) {
						sent += big.length;
						if (!res.write(big)) {
							res.once("drain", pump);
							return;
						}
					}
					res.end();
				};
				pump();
			} else if (url.pathname === "/missing") {
				res.writeHead(404);
				res.end("nope");
			} else {
				res.writeHead(500);
				res.end();
			}
		});
		server.listen(0, "127.0.0.1", () => resolve());
		await promise;
		const addr = server.address() as AddressInfo;
		base = `http://127.0.0.1:${addr.port}`;
	});

	afterAll(async () => {
		for (const p of cleanup) {
			try { rmSync(p); } catch { /* already pruned */ }
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		server.close(() => resolve());
		await promise;
		// Drop the per-run cache root so successive `bun test` runs
		// don't accumulate empty directories under tmpdir.
		try { rmSync(CACHE_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
	});

	test("downloads, writes bytes, and resolves mime from response header", async () => {
		const out = await cacheImageFromUrl(`${base}/photo.png`);
		cleanup.push(out.path);
		expect(out.mimeType).toBe("image/png");
		expect(out.path.endsWith(".png")).toBe(true);
		expect(out.bytes).toBe(PNG_BYTES.length);
		expect(existsSync(out.path)).toBe(true);
		expect(statSync(out.path).size).toBe(PNG_BYTES.length);
		expect(readFileSync(out.path).equals(PNG_BYTES)).toBe(true);
	});

	test("caller hint (Discord Attachment.contentType) wins over response header", async () => {
		// Header says PNG, caller hint says WEBP — hint must win and
		// produce a .webp file. Filename omitted so the test cannot
		// silently pass via the extension-fallback branch.
		const out = await cacheImageFromUrl(`${base}/photo.png`, {
			contentType: "image/webp",
		});
		cleanup.push(out.path);
		expect(out.mimeType).toBe("image/webp");
		expect(out.path.endsWith(".webp")).toBe(true);
	});

	test("unsupported response header is ignored when caller hint is valid", async () => {
		const out = await cacheImageFromUrl(`${base}/octet`, {
			contentType: "image/png",
		});
		cleanup.push(out.path);
		expect(out.mimeType).toBe("image/png");
	});

	test("falls back to filename extension when neither hint nor header carry an image type", async () => {
		const out = await cacheImageFromUrl(`${base}/no-ct`, { filename: "snap.webp" });
		cleanup.push(out.path);
		expect(out.mimeType).toBe("image/webp");
		expect(out.path.endsWith(".webp")).toBe(true);
	});

	test("throws on HTTP error", async () => {
		await expect(cacheImageFromUrl(`${base}/missing`)).rejects.toThrow(/HTTP 404/);
	});

	test("throws on unsupported mime (no hint, no header, no extension)", async () => {
		await expect(cacheImageFromUrl(`${base}/octet`)).rejects.toThrow(/unsupported image type/);
	});

	test("rejects payloads larger than MAX_DOWNLOAD_BYTES via content-length", async () => {
		await expect(cacheImageFromUrl(`${base}/huge`)).rejects.toThrow(/image too large/);
	});

	test("rejects payloads larger than MAX_DOWNLOAD_BYTES via streaming cap when content-length is missing", async () => {
		// Server omits content-length and streams 60MB of zeros — the
		// pre-buffer header check passes (length unknown = 0), so the
		// only thing that can save us is the streaming guard inside
		// readBodyCapped.
		await expect(cacheImageFromUrl(`${base}/lying`)).rejects.toThrow(/image too large/);
	});
});

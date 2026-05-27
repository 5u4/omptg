import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { WebBridge } from "../src/bridge/web/index.ts";
import { startWebServer, type RunningServer } from "../src/bridge/web/server.ts";

const STATIC_APP_JS = join(import.meta.dir, "..", "src", "bridge", "web", "static", "app.js");

let tempDir: string;
let stateFile: string;
let bridge: WebBridge | undefined;
let running: RunningServer | undefined;

beforeAll(async () => {
	// static/app.js is gitignored (built by scripts/build-web.ts).
	// Build it on demand if absent so the test suite stays green on a
	// fresh clone / CI.
	if (!existsSync(STATIC_APP_JS)) {
		await build({
			entryPoints: ["src/bridge/web/frontend/app.tsx"],
			outfile: STATIC_APP_JS,
			bundle: true,
			format: "esm",
			target: "es2022",
			minify: true,
			jsx: "automatic",
			jsxImportSource: "preact",
			logLevel: "silent",
		});
	}
});


beforeEach(() => {
	tempDir = realpathSync(mkdtempSync(join(tmpdir(), "omptg-static-")));
	stateFile = join(tempDir, "web-sessions.json");
	bridge = new WebBridge({ defaultCwd: tempDir, stateFile });
	running = startWebServer({ host: "127.0.0.1", port: 0, bridge });
});

afterEach(async () => {
	try { await running?.stop(); } catch { /* ignore */ }
	try { await bridge?.dispose(); } catch { /* ignore */ }
	rmSync(tempDir, { recursive: true, force: true });
});

function url(path: string): string {
	const u = running!.server.url;
	return `http://${u.hostname}:${u.port}${path}`;
}

describe("web server static handler", () => {
	it("serves index.html at /", async () => {
		const res = await fetch(url("/"));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		const body = await res.text();
		expect(body).toContain("<title>omptg</title>");
		expect(body).toContain("/app.js");
	});

	it("serves /app.js as JS", async () => {
		const res = await fetch(url("/app.js"));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/javascript");
	});

	it("serves /style.css as CSS", async () => {
		const res = await fetch(url("/style.css"));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/css");
	});

	it("returns 404 for unknown paths", async () => {
		const res = await fetch(url("/no-such-file"));
		expect(res.status).toBe(404);
	});

	it("rejects path traversal", async () => {
		const res = await fetch(url("/../package.json"));
		// Either the URL parser collapses ../ before it reaches us (so we
		// hit / and serve index.html), or our `..` filter rejects with 404.
		// Both behaviors are safe; what matters is that package.json
		// contents never appear in the response.
		const body = await res.text();
		expect(body).not.toContain('"name": "omptg"');
	});

	it("health endpoint returns ok", async () => {
		const res = await fetch(url("/health"));
		expect(res.status).toBe(200);
		const body = await res.json() as { ok: boolean; sessions: number };
		expect(body.ok).toBe(true);
	});
});

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { WebBridge } from "../src/bridge/web/index.ts";
import { startWebServer, type RunningServer } from "../src/bridge/web/server.ts";

const STATIC_DIR = join(import.meta.dir, "..", "src", "bridge", "web", "static");
/** Every artifact `vite build` emits. A partial bundle (someone
 *  deleted just app.css, an aborted build, etc.) should still
 *  re-trigger build:web. */
const BUILD_OUTPUTS = ["app.js", "app.css", "index.html"].map(f => join(STATIC_DIR, f));

let tempDir: string;
let stateFile: string;
let bridge: WebBridge | undefined;
let running: RunningServer | undefined;

beforeAll(() => {
	// Built bundle is gitignored; build it on demand so the suite stays
	// green on a fresh clone / CI. `vite build` is the canonical
	// invocation; same script as `bun run build:web`.
	if (!BUILD_OUTPUTS.every(p => existsSync(p))) {
		const r = spawnSync("bun", ["run", "build:web"], {
			cwd: join(import.meta.dir, ".."),
			stdio: "inherit",
		});
		if (r.status !== 0) throw new Error("build:web failed");
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
		expect(body).toContain("app.js");
	});

	it("serves /app.js as JS", async () => {
		const res = await fetch(url("/app.js"));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/javascript");
	});

	it("serves /app.css as CSS", async () => {
		const res = await fetch(url("/app.css"));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/css");
	});

	it("returns 404 for unknown paths", async () => {
		const res = await fetch(url("/no-such-file"));
		expect(res.status).toBe(404);
	});

	it("rejects path traversal", async () => {
		const res = await fetch(url("/../package.json"));
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

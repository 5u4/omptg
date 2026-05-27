import { describe, expect, it } from "bun:test";
import { isOriginAllowed } from "../src/bridge/web/server.ts";

describe("isOriginAllowed", () => {
	it("accepts the loopback Origin forms a browser would send", () => {
		expect(isOriginAllowed("http://127.0.0.1:7878", "127.0.0.1", 7878)).toBe(true);
		expect(isOriginAllowed("http://localhost:7878", "127.0.0.1", 7878)).toBe(true);
	});

	it("accepts IPv6 bracketed Origin (N6)", () => {
		// Browsers format IPv6 origins as http://[::1]:port. The naive
		// string-equality check we shipped first rejected these — and
		// users explicitly setting OMPTG_WEB_HOST=::1 would have been
		// locked out of their own UI.
		expect(isOriginAllowed("http://[::1]:7878", "::1", 7878)).toBe(true);
		expect(isOriginAllowed("http://[::1]:7878", "127.0.0.1", 7878)).toBe(true);
	});

	it("treats missing Origin as a non-browser client (wscat, smoke)", () => {
		expect(isOriginAllowed(null, "127.0.0.1", 7878)).toBe(true);
	});

	it("rejects wrong port", () => {
		expect(isOriginAllowed("http://127.0.0.1:9999", "127.0.0.1", 7878)).toBe(false);
	});

	it("rejects unrelated hosts", () => {
		expect(isOriginAllowed("http://evil.example.com:7878", "127.0.0.1", 7878)).toBe(false);
		expect(isOriginAllowed("http://192.168.1.5:7878", "127.0.0.1", 7878)).toBe(false);
	});

	it("rejects malformed origins", () => {
		expect(isOriginAllowed("not a url", "127.0.0.1", 7878)).toBe(false);
		expect(isOriginAllowed("ftp://127.0.0.1:7878", "127.0.0.1", 7878)).toBe(false);
	});
});

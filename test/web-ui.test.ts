import { describe, expect, it } from "bun:test";
import { WebUI } from "../src/bridge/web/ui.ts";
import type { UiRequestPayload } from "../src/bridge/web/protocol.ts";

interface PostedRequest {
	reqId: string;
	req: UiRequestPayload;
	awaitsText: boolean;
}

function makeUi(): { ui: WebUI; posted: PostedRequest[]; cancelled: string[]; notices: Array<{ level: string; text: string }> } {
	const posted: PostedRequest[] = [];
	const cancelled: string[] = [];
	const notices: Array<{ level: string; text: string }> = [];
	const ui = new WebUI("web:1", {
		postRequest: (reqId, req, awaitsText) => posted.push({ reqId, req, awaitsText }),
		cancelRequest: reqId => cancelled.push(reqId),
		postNotice: (level, text) => notices.push({ level, text }),
	});
	return { ui, posted, cancelled, notices };
}

describe("WebUI dialogs", () => {
	it("select resolves with the chosen option string", async () => {
		const { ui, posted } = makeUi();
		const p = ui.select("pick", ["a", "b", "c"]);
		expect(posted).toHaveLength(1);
		expect(posted[0]?.req).toEqual({ kind: "select", title: "pick", options: ["a", "b", "c"] });
		expect(posted[0]?.awaitsText).toBe(false);
		const ok = ui.resolve({ kind: "callback", requestId: posted[0]!.reqId, value: "b" });
		expect(ok).toBe(true);
		expect(await p).toBe("b");
	});

	it("select accepts a numeric index", async () => {
		const { ui, posted } = makeUi();
		const p = ui.select("pick", ["a", "b"]);
		ui.resolve({ kind: "callback", requestId: posted[0]!.reqId, value: 1 });
		expect(await p).toBe("b");
	});

	it("select returns undefined on null/cancel", async () => {
		const { ui, posted } = makeUi();
		const p = ui.select("pick", ["a"]);
		ui.resolve({ kind: "callback", requestId: posted[0]!.reqId, value: null });
		expect(await p).toBeUndefined();
	});

	it("confirm maps y/yes/true → true", async () => {
		const { ui, posted } = makeUi();
		const p = ui.confirm("ok?", "do it");
		ui.resolve({ kind: "callback", requestId: posted[0]!.reqId, value: true });
		expect(await p).toBe(true);

		const p2 = ui.confirm("ok?", "do it");
		ui.resolve({ kind: "callback", requestId: posted[1]!.reqId, value: "y" });
		expect(await p2).toBe(true);
	});

	it("confirm everything else → false", async () => {
		const { ui, posted } = makeUi();
		const p = ui.confirm("ok?", "do it");
		ui.resolve({ kind: "callback", requestId: posted[0]!.reqId, value: false });
		expect(await p).toBe(false);
	});

	it("input awaitsText and resolves via text payload", async () => {
		const { ui, posted } = makeUi();
		const p = ui.input("name?");
		expect(posted[0]?.awaitsText).toBe(true);
		expect(ui.pending()?.awaitsText).toBe(true);
		const ok = ui.resolve({ kind: "text", text: "Alice" });
		expect(ok).toBe(true);
		expect(await p).toBe("Alice");
	});

	it("rejects text answer for a non-text pending", async () => {
		const { ui, posted } = makeUi();
		const p = ui.select("pick", ["a"]);
		const ok = ui.resolve({ kind: "text", text: "won't work" });
		expect(ok).toBe(false);
		// Still pending; cancel via callback to settle the test.
		ui.resolve({ kind: "callback", requestId: posted[0]!.reqId, value: null });
		expect(await p).toBeUndefined();
	});

	it("supersedes prior pending and emits cancel for it", async () => {
		const { ui, posted, cancelled } = makeUi();
		const first = ui.select("first", ["a"]);
		const second = ui.select("second", ["b"]);
		// First was superseded → cancelled by reqId, resolves undefined.
		expect(cancelled).toEqual([posted[0]!.reqId]);
		expect(await first).toBeUndefined();
		ui.resolve({ kind: "callback", requestId: posted[1]!.reqId, value: "b" });
		expect(await second).toBe("b");
	});

	it("ignores callback with mismatched reqId", async () => {
		const { ui, posted } = makeUi();
		const p = ui.select("pick", ["a"]);
		const ok = ui.resolve({ kind: "callback", requestId: "wrong", value: "a" });
		expect(ok).toBe(false);
		ui.resolve({ kind: "callback", requestId: posted[0]!.reqId, value: null });
		expect(await p).toBeUndefined();
	});

	it("notify emits a notice via the postNotice hook", () => {
		const { ui, notices } = makeUi();
		ui.notify("heads up", "warning");
		ui.notify("plain info");
		expect(notices).toEqual([
			{ level: "warning", text: "heads up" },
			{ level: "info", text: "plain info" },
		]);
	});
});

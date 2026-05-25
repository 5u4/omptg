import { describe, expect, test } from "bun:test";
import { renderToolEnd, renderToolStart } from "../src/tool-render.ts";

describe("renderToolStart", () => {
	test("read uses basename-free path verbatim", () => {
		expect(renderToolStart("read", { path: "src/foo.ts" })).toBe(
			"📖 read src/foo.ts",
		);
	});

	test("read with missing path falls back to ?", () => {
		expect(renderToolStart("read", {})).toBe("📖 read ?");
	});

	test("write reports byte count", () => {
		expect(renderToolStart("write", { path: "x.md", content: "hello" })).toBe(
			"📝 write x.md (5b)",
		);
	});

	test("edit single file uses basename", () => {
		expect(
			renderToolStart("edit", {
				input: "§src/deep/path/foo.ts\n»1ab\nhi\n",
			}),
		).toBe("✏️ edit foo.ts");
	});

	test("edit multi-file reports file count", () => {
		expect(
			renderToolStart("edit", {
				input: "§a.ts\n»1ab\nhi\n§b.ts\n»2cd\nbye\n",
			}),
		).toBe("✏️ edit 2 files");
	});

	test("edit with no §PATH headers falls back", () => {
		expect(renderToolStart("edit", { input: "garbage" })).toBe("✏️ edit");
	});

	test("bash truncates very long commands", () => {
		const cmd = "x".repeat(200);
		const out = renderToolStart("bash", { command: cmd });
		expect(out.startsWith("💻 bash: ")).toBe(true);
		// 80 char detail budget; line includes "💻 bash: " prefix.
		expect(out.length).toBeLessThanOrEqual("💻 bash: ".length + 80);
		expect(out.endsWith("…")).toBe(true);
	});

	test("bash collapses whitespace", () => {
		expect(renderToolStart("bash", { command: "  ls\n  -la  " })).toBe(
			"💻 bash: ls -la",
		);
	});

	test("search reports single-path basename", () => {
		expect(
			renderToolStart("search", { pattern: "foo", paths: ["src/bar.ts"] }),
		).toBe("🔍 search /foo/ in bar.ts");
	});

	test("search reports path count when multi", () => {
		expect(
			renderToolStart("search", {
				pattern: "foo",
				paths: ["a.ts", "b.ts", "c.ts"],
			}),
		).toBe("🔍 search /foo/ in 3 paths");
	});

	test("ast_edit pluralizes correctly", () => {
		expect(
			renderToolStart("ast_edit", {
				ops: [{}],
				paths: ["x"],
			}),
		).toBe("🌳 ast_edit 1 op × 1 path");
		expect(
			renderToolStart("ast_edit", {
				ops: [{}, {}],
				paths: ["x", "y"],
			}),
		).toBe("🌳 ast_edit 2 ops × 2 paths");
	});

	test("task formats agent + count", () => {
		expect(
			renderToolStart("task", { agent: "explore", tasks: [{}, {}] }),
		).toBe("🤖 task → 2 × explore");
	});

	test("unknown tool falls back to generic emoji", () => {
		expect(renderToolStart("weird_thing", {})).toBe("🔧 weird_thing");
	});

	test("null args are handled", () => {
		expect(renderToolStart("read", null)).toBe("📖 read ?");
		expect(renderToolStart("read", undefined)).toBe("📖 read ?");
	});
});

describe("renderToolEnd", () => {
	test("returns empty when not an error", () => {
		expect(renderToolEnd("bash", { content: [] }, false)).toBe("");
		expect(renderToolEnd("bash", { content: [] }, undefined)).toBe("");
	});

	test("extracts text from content array", () => {
		const result = {
			content: [{ type: "text", text: "command failed: ENOENT" }],
		};
		expect(renderToolEnd("bash", result, true)).toBe(
			"❌ bash failed: command failed: ENOENT",
		);
	});

	test("works with no detail text", () => {
		expect(renderToolEnd("bash", { content: [] }, true)).toBe(
			"❌ bash failed",
		);
	});

	test("truncates long error detail", () => {
		const text = "x".repeat(500);
		const out = renderToolEnd("bash", { content: [{ type: "text", text }] }, true);
		expect(out.endsWith("…")).toBe(true);
		expect(out.length).toBeLessThanOrEqual("❌ bash failed: ".length + 100);
	});
});

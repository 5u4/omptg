/**
 * Turn `tool_execution_start` events into a short telegram-friendly status
 * line. Per tool: an emoji + the most useful field from `args`, truncated.
 *
 * Telegram inline edits are throttled, so this string lands on the status
 * tail under the streamed assistant text (TelegramStreamer.pushStatus).
 * Keep it ONE line and bounded — anything longer is just noise.
 */

const MAX_DETAIL = 80;

function truncate(s: string, max = MAX_DETAIL): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function basename(p: string): string {
	const i = p.lastIndexOf("/");
	return i >= 0 ? p.slice(i + 1) : p;
}

/** Best-effort render of one tool invocation. */
export function renderToolStart(toolName: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	switch (toolName) {
		case "read": {
			const path = typeof a.path === "string" ? a.path : "?";
			return `📖 read ${truncate(path)}`;
		}
		case "write": {
			const path = typeof a.path === "string" ? a.path : "?";
			const len = typeof a.content === "string" ? a.content.length : 0;
			return `📝 write ${truncate(path)} (${len}b)`;
		}
		case "edit": {
			// hashline mode bundles every section into one `input` string;
			// pull the §PATH headers out for a quick "files touched" view.
			const input = typeof a.input === "string" ? a.input : "";
			const paths = [...input.matchAll(/^§(\S+)/gm)].map(m => m[1]);
			if (paths.length === 0) return "✏️ edit";
			if (paths.length === 1) return `✏️ edit ${truncate(basename(paths[0]!))}`;
			return `✏️ edit ${paths.length} files`;
		}
		case "ast_edit": {
			const ops = Array.isArray(a.ops) ? a.ops.length : 0;
			const paths = Array.isArray(a.paths) ? a.paths.length : 0;
			return `🌳 ast_edit ${ops} op${ops === 1 ? "" : "s"} × ${paths} path${paths === 1 ? "" : "s"}`;
		}
		case "bash": {
			const cmd = typeof a.command === "string" ? a.command : "?";
			return `💻 bash: ${truncate(cmd)}`;
		}
		case "search": {
			const pattern = typeof a.pattern === "string" ? a.pattern : "?";
			const paths = Array.isArray(a.paths) ? a.paths : [];
			const where =
				paths.length === 0
					? ""
					: paths.length === 1
						? ` in ${basename(String(paths[0]))}`
						: ` in ${paths.length} paths`;
			return `🔍 search /${truncate(pattern, 40)}/${where}`;
		}
		case "find": {
			const paths = Array.isArray(a.paths) ? a.paths : [];
			const first = paths.length > 0 ? String(paths[0]) : "?";
			const more = paths.length > 1 ? ` +${paths.length - 1}` : "";
			return `🔎 find ${truncate(first)}${more}`;
		}
		case "ast_grep": {
			const pat = typeof a.pat === "string" ? a.pat : "?";
			const paths = Array.isArray(a.paths) ? a.paths.length : 0;
			return `🌳 ast_grep ${truncate(pat, 40)} (${paths} path${paths === 1 ? "" : "s"})`;
		}
		case "lsp": {
			const action = typeof a.action === "string" ? a.action : "?";
			const file = typeof a.file === "string" ? ` ${basename(a.file)}` : "";
			return `🔧 lsp ${action}${file}`;
		}
		case "debug": {
			const action = typeof a.action === "string" ? a.action : "?";
			return `🐛 debug ${action}`;
		}
		case "task": {
			const tasks = Array.isArray(a.tasks) ? a.tasks.length : 0;
			const agent = typeof a.agent === "string" ? a.agent : "agent";
			return `🤖 task → ${tasks} × ${agent}`;
		}
		case "todo_write": {
			const ops = Array.isArray(a.ops) ? a.ops.length : 0;
			return `✅ todos (${ops} op${ops === 1 ? "" : "s"})`;
		}
		case "eval": {
			const cells = Array.isArray(a.cells) ? a.cells.length : 0;
			return `🧮 eval ${cells} cell${cells === 1 ? "" : "s"}`;
		}
		case "web_search": {
			const q = typeof a.query === "string" ? a.query : "?";
			return `🌐 web_search "${truncate(q, 60)}"`;
		}
		case "browser": {
			const action = typeof a.action === "string" ? a.action : "?";
			const url = typeof a.url === "string" ? ` ${truncate(a.url, 40)}` : "";
			return `🌐 browser ${action}${url}`;
		}
		case "ask": {
			const q = typeof a.question === "string" ? a.question : "?";
			return `❓ ask "${truncate(q, 60)}"`;
		}
		case "resolve": {
			return `✔️ resolve`;
		}
		case "github": {
			const action = typeof a.action === "string" ? a.action : "?";
			return `🐙 github ${action}`;
		}
		default:
			return `🔧 ${toolName}`;
	}
}

/** End-of-execution: only meaningful when the tool errored. */
export function renderToolEnd(
	toolName: string,
	result: unknown,
	isError: boolean | undefined,
): string {
	if (!isError) return "";
	const r = (result ?? {}) as Record<string, unknown>;
	// Errors usually arrive as {content: [{type:"text", text:"..."}]}.
	let detail = "";
	if (Array.isArray(r.content)) {
		const first = r.content.find(
			(c: any) => c && typeof c === "object" && c.type === "text",
		) as { text?: string } | undefined;
		if (first?.text) detail = first.text;
	} else if (typeof r === "string") {
		detail = r;
	}
	const head = detail ? `: ${truncate(detail, 100)}` : "";
	return `❌ ${toolName} failed${head}`;
}

/** Trimmed description label shown in the subagent block. */
const SUBAGENT_LABEL_MAX = 28;

/**
 * Render one row in the parent `task`'s subagent block. Format:
 *
 *   `  └ [i] <agent> "<label>"  <currentTool render>  · N tools`
 *
 * Designed to be replace-in-place by `TelegramStreamer.subagentLine`:
 * subagent progress events fire ~10Hz per child, so every visible field
 * must come from the latest snapshot (no monotonic counters that would
 * disagree across edits) and the line shape stays stable so the eye
 * tracks the same row across replacements.
 *
 * `currentTool` may be undefined between tool boundaries — we fall back
 * to a `⏳ <lastIntent or "idle">` heartbeat so a slot is never blank.
 */
export function renderSubagentProgress(
	index: number,
	agent: string,
	description: string | undefined,
	currentTool: string | undefined,
	/** AgentProgress.currentToolArgs is a pre-flattened *string* preview
	 *  produced by `extractToolArgsPreview` in the harness — NOT a
	 *  structured args object. Passing it through `renderToolStart`
	 *  would lose the preview entirely (the renderers read `a.path` /
	 *  `a.command` on an empty object cast). Render it directly. */
	currentToolArgs: string | undefined,
	lastIntent: string | undefined,
	toolCount: number,
): string {
	const label = description
		? ` "${truncate(description, SUBAGENT_LABEL_MAX)}"`
		: "";
	let action: string;
	if (currentTool) {
		const preview = currentToolArgs ? ` ${truncate(currentToolArgs, 40)}` : "";
		action = `🔧 ${currentTool}${preview}`;
	} else {
		action = `⏳ ${truncate(lastIntent ?? "idle", 40)}`;
	}
	const counter = toolCount > 0 ? `  · ${toolCount} tool${toolCount === 1 ? "" : "s"}` : "";
	return `  └ [${index}] ${agent}${label}  ${action}${counter}`;
}

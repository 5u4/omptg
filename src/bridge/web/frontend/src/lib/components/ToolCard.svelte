<script lang="ts">
import type { Session } from "$lib/store/index.svelte";
import { cn } from "$lib/utils";
import { ChevronRight, Check, X, Loader2 } from "@lucide/svelte";

let { toolCallId, session }: { toolCallId: string; session: Session } = $props();

// Re-render when the in-place tools Map changes (subagents added, tool finishes).
const tool = $derived.by(() => {
	void session.eventsVersion;
	return session.tools.get(toolCallId);
});

// `expanded` is purely UI state; keep it local to the card so the
// store's ToolState stays a pure data record and Svelte's reactivity
// tracks property access on `$state` instead of arbitrary plain objects.
let expanded = $state(false);

const statusBorder = $derived(
	!tool?.done ? "border-l-amber-500"
	: tool.isError ? "border-l-destructive"
	: "border-l-emerald-500",
);

function fmt(v: unknown): string {
	if (typeof v === "string") return v;
	try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function toggle(): void {
	expanded = !expanded;
}
</script>

{#if tool}
	<div class={cn("overflow-hidden rounded-md border border-l-2 bg-card", statusBorder)}>
		<button
			type="button"
			aria-expanded={expanded}
			onclick={toggle}
			class="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
		>
			{#if !tool.done}
				<Loader2 class="size-3.5 animate-spin text-amber-500" />
			{:else if tool.isError}
				<X class="size-3.5 text-destructive" />
			{:else}
				<Check class="size-3.5 text-emerald-500" />
			{/if}
			<div class="flex-1 truncate font-mono text-xs">{tool.line}</div>
			<ChevronRight class={cn("size-3 text-muted-foreground transition-transform", expanded && "rotate-90")} />
		</button>

		{#if tool.subagents.size > 0}
			<div class="px-3 pb-2">
				{#each [...tool.subagents.entries()] as [k, line] (k)}
					<div class="border-l-2 border-border pl-2 py-0.5 font-mono text-[11px] text-muted-foreground">
						{line}
					</div>
				{/each}
			</div>
		{/if}

		{#if expanded}
			<div class="max-h-96 overflow-auto border-t border-border bg-muted/30 px-3 py-2 font-mono text-[11px] text-muted-foreground">
				{#if tool.args !== undefined}
					<div class="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground/70">args</div>
					<pre class="whitespace-pre-wrap break-words">{fmt(tool.args)}</pre>
				{/if}
				{#if tool.done && tool.result !== undefined}
					<div class="mb-1 mt-2 text-[10px] uppercase tracking-wider text-muted-foreground/70">result</div>
					<pre class="whitespace-pre-wrap break-words">{fmt(tool.result)}</pre>
				{/if}
			</div>
		{/if}
	</div>
{/if}

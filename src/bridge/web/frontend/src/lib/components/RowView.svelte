<script lang="ts">
import type { Row, Session } from "$lib/store/index.svelte";
import ToolCard from "./ToolCard.svelte";
import { md } from "$lib/md";

let { row, session }: { row: Row; session: Session } = $props();
</script>

{#if row.kind === "user"}
	<div class="ml-auto max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground">
		{row.text}
	</div>
{:else if row.kind === "assistant"}
	<div class="msg-assistant max-w-full text-sm">
		{@html md(row.text)}
	</div>
{:else if row.kind === "preamble"}
	<div class="border-l-2 border-border pl-3 text-xs text-muted-foreground">
		💭 {row.text}
	</div>
{:else if row.kind === "notice"}
	<div class="border-l-2 border-border pl-3 text-xs text-muted-foreground">
		{row.text}
	</div>
{:else if row.kind === "replace"}
	<div class="border-l-2 border-destructive pl-3 text-sm font-medium text-destructive">
		{row.text}
	</div>
{:else if row.kind === "tool"}
	<ToolCard toolCallId={row.toolCallId} {session} />
{/if}

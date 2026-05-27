<script lang="ts">
import { store, type Session } from "$lib/store/index.svelte";
import Badge from "$lib/components/ui/Badge.svelte";
import { cn } from "$lib/utils";

let { session }: { session: Session } = $props();

const active = $derived(store.activeKey === session.key);

const cwdLabel = $derived.by(() => {
	const parts = session.cwd.split(/[/\\]/).filter(Boolean);
	return parts.slice(-2).join("/") || session.cwd;
});

const title = $derived(session.title || session.key);
</script>

<button
	type="button"
	aria-current={active ? "true" : "false"}
	onclick={() => store.select(session.key)}
	class={cn(
		"flex w-full items-start gap-2 rounded-md border border-transparent px-2 py-2 text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
		active && "bg-accent text-accent-foreground border-border",
	)}
>
	<div class="flex min-w-0 flex-1 flex-col">
		<div class="truncate text-sm font-medium">{title}</div>
		<div class="truncate font-mono text-[11px] text-muted-foreground">{cwdLabel}</div>
	</div>
	{#if session.unread > 0 && !active}
		<Badge variant="default" class="mt-0.5">{session.unread}</Badge>
	{/if}
	{#if session.turnActive}
		<div class="turn-pulse mt-2" aria-label="turn active" title="turn active"></div>
	{/if}
</button>

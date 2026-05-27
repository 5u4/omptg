<script lang="ts">
import { store, openNewSession } from "$lib/store/index.svelte";
import SessionItem from "./SessionItem.svelte";
import Button from "$lib/components/ui/Button.svelte";

const statusColor = $derived(
	store.connState === "live" ? "text-emerald-500"
	: store.connState === "down" ? "text-destructive"
	: "text-muted-foreground",
);
</script>

<aside class="flex min-h-0 flex-col border-r border-border bg-card">
	<header class="flex items-center justify-between gap-2 border-b border-border p-3">
		<div class="font-semibold">omptg</div>
		<div class="text-[10px] uppercase tracking-wider {statusColor}">{store.connState}</div>
	</header>

	<div class="border-b border-border p-2">
		<Button variant="secondary" size="sm" class="w-full" onclick={openNewSession}>
			+ new session
		</Button>
	</div>

	<div class="flex-1 overflow-y-auto p-1" style="scrollbar-gutter: stable;">
		{#if store.sessions.length === 0}
			<div class="p-6 text-center text-sm text-muted-foreground">no sessions yet</div>
		{:else}
			{#each store.sessions as s (s.key)}
				<SessionItem session={s} />
			{/each}
		{/if}
	</div>
</aside>

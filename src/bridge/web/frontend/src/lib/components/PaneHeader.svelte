<script lang="ts">
import type { Session } from "$lib/store/index.svelte";
import { abortTurn, closeSession } from "$lib/store/index.svelte";
import Button from "$lib/components/ui/Button.svelte";

let { session }: { session: Session } = $props();
</script>

<header class="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
	<div class="min-w-0">
		<div class="truncate text-base font-semibold">{session.title || session.key}</div>
		<div class="truncate font-mono text-[11px] text-muted-foreground">
			{session.cwd}{session.modelId ? ` · ${session.modelId}` : ""}
		</div>
	</div>
	<div class="flex gap-1.5">
		{#if session.turnActive}
			<Button variant="outline" size="sm" onclick={() => abortTurn(session.key)}>abort</Button>
		{/if}
		<Button variant="ghost" size="sm" onclick={() => closeSession(session.key)}>close</Button>
	</div>
</header>

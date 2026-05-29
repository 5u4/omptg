<script lang="ts">
import type { Session } from "$lib/store/index.svelte";
import { abortTurn, closeSession, renameSession } from "$lib/store/index.svelte";
import Button from "$lib/components/ui/Button.svelte";
import RenameSessionDialog from "./RenameSessionDialog.svelte";

let { session }: { session: Session } = $props();

let renaming = $state(false);

function submitRename(title: string): void {
	renameSession(session.key, title);
	renaming = false;
}
</script>

<header class="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
	<div class="group flex min-w-0 items-center gap-1.5">
		<div class="min-w-0">
			<div class="truncate text-base font-semibold">{session.title || session.key}</div>
			<div class="truncate font-mono text-[11px] text-muted-foreground">
				{session.cwd}{session.modelId ? ` · ${session.modelId}` : ""}
			</div>
		</div>
		<button
			type="button"
			class="rounded p-0.5 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
			title="Rename session"
			aria-label="Rename session"
			onclick={() => (renaming = true)}
		>✎</button>
	</div>
	<div class="flex gap-1.5">
		{#if session.turnActive}
			<Button variant="outline" size="sm" onclick={() => abortTurn(session.key)}>abort</Button>
		{/if}
		<Button variant="ghost" size="sm" onclick={() => closeSession(session.key)}>close</Button>
	</div>
</header>

{#if renaming}
	<RenameSessionDialog
		initial={session.title || ""}
		onSubmit={submitRename}
		onCancel={() => (renaming = false)}
	/>
{/if}

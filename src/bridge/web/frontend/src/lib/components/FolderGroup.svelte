<script lang="ts">
import {
	store,
	openNewSession,
	renameFolder,
	type Folder,
	type Session,
} from "$lib/store/index.svelte";
import SessionItem from "./SessionItem.svelte";
import RenameFolderDialog from "./RenameFolderDialog.svelte";

let {
	folder,
	sessions,
}: {
	folder: Folder;
	sessions: Session[];
} = $props();

const collapsed = $derived(store.collapsed.has(folder.id));
const cwdLabel = $derived.by(() => {
	const parts = folder.cwd.split(/[/\\]/).filter(Boolean);
	return parts.slice(-1).join("/") || folder.cwd;
});

let renaming = $state(false);

function toggle(): void { store.toggleFolder(folder.id); }
function add(): void {
	openNewSession({ folderId: folder.id });
}
function startRename(): void {
	renaming = true;
}
function submitRename(name: string): void {
	renameFolder(folder.id, name);
	renaming = false;
}
</script>

<div class="mb-1">
	<div
		class="group flex items-center gap-1 rounded-md px-1.5 py-1 text-xs uppercase tracking-wider text-muted-foreground hover:bg-accent/40"
	>
		<button
			type="button"
			class="flex min-w-0 flex-1 items-center gap-1.5 text-left"
			onclick={toggle}
			title={folder.cwd}
		>
			<span class="inline-block w-3 text-center">{collapsed ? "▸" : "▾"}</span>
			<span class="truncate font-semibold text-foreground">{folder.name}</span>
			<span class="truncate font-mono text-[10px] normal-case text-muted-foreground">{cwdLabel}</span>
			<span class="ml-auto pl-1 text-[10px] tabular-nums">{sessions.length}</span>
		</button>
		<button
			type="button"
			class="rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100"
			title="Rename folder"
			aria-label="Rename folder"
			onclick={startRename}
		>✎</button>
		<button
			type="button"
			class="rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100"
			title="New session in folder"
			aria-label="New session in folder"
			onclick={add}
		>+</button>
	</div>

	{#if !collapsed}
		<div class="ml-2 border-l border-border/60 pl-1">
			{#if sessions.length === 0}
				<div class="px-2 py-1 text-[11px] italic text-muted-foreground">empty</div>
			{:else}
				{#each sessions as s (s.key)}
					<SessionItem session={s} />
				{/each}
			{/if}
		</div>
	{/if}
</div>

{#if renaming}
	<RenameFolderDialog
		initial={folder.name}
		onSubmit={submitRename}
		onCancel={() => (renaming = false)}
	/>
{/if}

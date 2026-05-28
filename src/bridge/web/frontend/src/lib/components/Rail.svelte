<script lang="ts">
import {
	store,
	openNewSession,
	createFolder,
} from "$lib/store/index.svelte";
import SessionItem from "./SessionItem.svelte";
import FolderGroup from "./FolderGroup.svelte";
import NewFolderDialog from "./NewFolderDialog.svelte";
import Button from "$lib/components/ui/Button.svelte";

const statusColor = $derived(
	store.connState === "live" ? "text-emerald-500"
	: store.connState === "down" ? "text-destructive"
	: "text-muted-foreground",
);

const grouped = $derived(store.groupedSessions);

/** Best-effort default cwd for the dialogs. The server doesn't push
 *  its `defaultCwd` over the wire, so we crib whatever cwd the user
 *  most recently saw — first folder's cwd, else first session's cwd,
 *  else empty (forces the user to type). */
const dialogDefaultCwd = $derived(
	store.folders[0]?.cwd
	?? store.sessions[0]?.cwd
	?? "",
);

type DialogMode = null | "folder" | "session";
let dialog = $state<DialogMode>(null);

function openSessionDialog(): void { dialog = "session"; }
function openFolderDialog(): void { dialog = "folder"; }
function closeDialog(): void { dialog = null; }

function submitDialog(name: string, cwd: string): void {
	if (dialog === "folder") {
		createFolder(name, cwd);
	} else if (dialog === "session") {
		openNewSession({ cwd });
	}
	dialog = null;
}
</script>

<aside class="flex min-h-0 flex-col border-r border-border bg-card">
	<header class="flex items-center justify-between gap-2 border-b border-border p-3">
		<div class="font-semibold">omptg</div>
		<div class="text-[10px] uppercase tracking-wider {statusColor}">{store.connState}</div>
	</header>

	<div class="flex gap-2 border-b border-border p-2">
		<Button variant="secondary" size="sm" class="flex-1" onclick={openSessionDialog}>
			+ session
		</Button>
		<Button variant="ghost" size="sm" class="flex-1" onclick={openFolderDialog}>
			+ folder
		</Button>
	</div>

	<div class="flex-1 overflow-y-auto p-1" style="scrollbar-gutter: stable;">
		{#if store.folders.length === 0 && grouped.ungrouped.length === 0}
			<div class="p-6 text-center text-sm text-muted-foreground">no sessions yet</div>
		{:else}
			{#each store.folders as folder (folder.id)}
				<FolderGroup
					{folder}
					sessions={grouped.byFolder.get(folder.id) ?? []}
				/>
			{/each}

			{#if grouped.ungrouped.length > 0}
				<div class="mt-1">
					{#if store.folders.length > 0}
						<div class="px-1.5 py-1 text-xs uppercase tracking-wider text-muted-foreground">
							Ungrouped
						</div>
					{/if}
					{#each grouped.ungrouped as s (s.key)}
						<SessionItem session={s} />
					{/each}
				</div>
			{/if}
		{/if}
	</div>
</aside>

{#if dialog !== null}
	<NewFolderDialog
		mode={dialog === "folder" ? "folder" : "cwd"}
		defaultCwd={dialogDefaultCwd}
		onSubmit={submitDialog}
		onCancel={closeDialog}
	/>
{/if}

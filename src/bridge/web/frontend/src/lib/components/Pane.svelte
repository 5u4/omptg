<script lang="ts">
import { store, openNewSession } from "$lib/store/index.svelte";
import Button from "$lib/components/ui/Button.svelte";
import PaneHeader from "./PaneHeader.svelte";
import Stream from "./Stream.svelte";
import Composer from "./Composer.svelte";

const session = $derived(store.activeSession);
</script>

{#if session}
	<div class="flex min-h-0 flex-col">
		<PaneHeader {session} />
		<Stream {session} />
		<Composer {session} />
	</div>
{:else}
	<div class="flex flex-col items-center justify-center gap-3 p-10 text-center text-muted-foreground">
		<div>Open a session to get started.</div>
		<Button variant="default" onclick={openNewSession}>+ new session</Button>
	</div>
{/if}

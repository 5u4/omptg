<script lang="ts">
import { store } from "$lib/store/index.svelte";
import Rail from "./Rail.svelte";
import Pane from "./Pane.svelte";

// Window title: (N) <session title>, mirrors the prior implementation.
$effect(() => {
	const n = store.totalUnread;
	const a = store.activeSession;
	const base = a ? (a.title || a.key) : "omptg";
	document.title = (n > 0 ? `(${n}) ` : "") + base;
});
</script>

<div class="grid h-screen min-h-0 grid-cols-[260px_1fr]">
	<Rail />
	<Pane />
</div>

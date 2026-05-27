<script lang="ts">
import type { Session } from "$lib/store/index.svelte";
import RowView from "./RowView.svelte";
import UiForm from "./UiForm.svelte";
import { md } from "$lib/md";

let { session }: { session: Session } = $props();

let scrollEl: HTMLDivElement | undefined = $state();
let stick = $state(true);

function onScroll(): void {
	if (!scrollEl) return;
	const atBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 32;
	stick = atBottom;
}

// Auto-scroll on content change while sticky. Subscribe to rows length
// and liveText so streaming + new rows both trigger a check.
$effect(() => {
	void session.rows.length;
	void session.liveText;
	void session.eventsVersion;
	if (scrollEl && stick) {
		queueMicrotask(() => {
			if (scrollEl && stick) scrollEl.scrollTop = scrollEl.scrollHeight;
		});
	}
});
</script>

<div
	bind:this={scrollEl}
	onscroll={onScroll}
	class="flex flex-1 flex-col gap-3 overflow-y-auto px-5 pb-1 pt-4"
	style="scrollbar-gutter: stable;"
>
	{#if session.rows.length === 0 && !session.liveText && !session.liveActive}
		<div class="m-auto text-sm text-muted-foreground">No messages yet. Say something.</div>
	{/if}

	{#each session.rows as row, i (i)}
		<RowView {row} {session} />
	{/each}

	{#if session.liveActive || session.liveText}
		<div class="msg-assistant streaming-cursor">
			{@html md(session.liveText || " ")}
		</div>
	{/if}

	{#if session.pendingUi}
		<UiForm {session} req={session.pendingUi} />
	{/if}
</div>

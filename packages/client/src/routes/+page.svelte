<script lang="ts">
	import { openRoom } from '$lib/room/index.js';

	function send() {}

	let room = openRoom({
		url: 'ws://localhost:8787/api/public/room/test/ws',
		account: {
			subscribe() {
				return () => {};
			}
		} as any
	});
</script>

<div>
	{#if !$room || $room?.loading}
		loading..
	{:else}
		{#each $room.messages as message}
			<p>{message.message}</p>
		{/each}
	{/if}
</div>

<div>
	<input type="text" />
	<button onclick={send}>send</button>
</div>

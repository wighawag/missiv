<script lang="ts">
	import { openRoom } from '$lib/room';

	function send() {}

	let room = openRoom('conquest.game');
</script>

<div>
	{#each $room.messages as message}
		<p>{message.content}</p>
	{/each}
</div>

<div>
	<input type="text" />
	<button onclick={send}>send</button>
</div>

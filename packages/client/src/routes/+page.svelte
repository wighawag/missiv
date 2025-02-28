<script lang="ts">
	import { openRoom } from '$lib/room/index.js';
	import { onMount } from 'svelte';

	let messagesContainer: HTMLDivElement;
	let messageInput: HTMLInputElement;
	function send() {
		if (messageInput.value.trim()) {
			room.sendMessage(messageInput.value);
			messageInput.value = '';
		}
	}

	function scrollToBottom() {
		if (messagesContainer) {
			messagesContainer.scrollTop = messagesContainer.scrollHeight;
		}
	}

	onMount(() => {
		scrollToBottom();
	});

	let room = openRoom({
		url: 'ws://localhost:8787/api/public/room/test/ws',
		account: {
			subscribe() {
				return () => {};
			}
		} as any
	});

	// Auto-scroll when new messages arrive
	$effect(() => {
		if ($room && 'messages' in $room && $room?.messages) {
			setTimeout(scrollToBottom, 0);
		}
	});
</script>

<div class="chat-container">
	<div class="messages-container" bind:this={messagesContainer}>
		{#if !$room || $room?.loading}
			<p class="loading">loading..</p>
		{:else}
			{#each $room.messages as message}
				<p class="message">{message.message}</p>
			{/each}
		{/if}
	</div>

	<div class="input-container">
		<input type="text" bind:this={messageInput} onkeydown={(e) => e.key === 'Enter' && send()} />
		<button onclick={send}>send</button>
	</div>
</div>

<style>
	.chat-container {
		display: flex;
		flex-direction: column;
		height: 100vh;
		max-height: 100vh;
	}

	.messages-container {
		flex: 1;
		overflow-y: auto;
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.input-container {
		display: flex;
		padding: 1rem;
		border-top: 1px solid #eee;
		gap: 0.5rem;
	}

	input {
		flex: 1;
		padding: 0.5rem;
	}

	button {
		padding: 0.5rem 1rem;
	}

	.message {
		margin: 0;
		padding: 0.5rem;
		background-color: #f5f5f5;
		border-radius: 4px;
	}

	.loading {
		text-align: center;
		opacity: 0.7;
	}
</style>

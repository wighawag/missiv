<script lang="ts">
	import { openRoom, type Account } from '$lib/room/index.js';
	import { onMount } from 'svelte';
	import { writable } from 'svelte/store';

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

	const account = writable<Account>({
		address:
			'0x' +
			Array.from(crypto.getRandomValues(new Uint8Array(20)))
				.map((b) => b.toString(16).padStart(2, '0'))
				.join(''),
		signer: {
			address: 'signer',
			privateKey: '0xff'
		}
	});

	let room = openRoom({
		url: 'ws://localhost:8787/api/public/room/test/ws',
		account,
		autoLogin: true
	});

	// Auto-scroll when new messages arrive
	$effect(() => {
		if ($room && 'messages' in $room && $room?.messages) {
			setTimeout(scrollToBottom, 0);
		}
	});
</script>

<div class="chat-container">
	<div class="app-layout">
		<div class="messages-container" bind:this={messagesContainer}>
			{#if !$room || $room?.loading}
				<p class="loading">loading..</p>
			{:else}
				{#each $room.messages as message}
					<p class="message">{message.message}</p>
				{/each}
			{/if}
		</div>

		<div class="users-panel">
			<h3>Connected Users</h3>
			{#if !$room || $room?.loading}
				<p class="loading">loading..</p>
			{:else}
				<ul class="users-list">
					{#each $room.users as user}
						<li class="user-item">
							<span class="user-address">{user.address}</span>
						</li>
					{/each}
				</ul>
				{#if $room.users.length === 0}
					<p class="no-users">No users connected</p>
				{/if}
			{/if}
		</div>
	</div>

	<div class="input-container">
		<input
			disabled={!$room || !('loggedIn' in $room) || !$room.loggedIn}
			type="text"
			bind:this={messageInput}
			onkeydown={(e) => e.key === 'Enter' && send()}
		/>
		{#if !$room || !('loggedIn' in $room) || !$room.loggedIn}
			<button onclick={() => room.login()}>connect</button>
		{:else}<button onclick={send}>send</button>{/if}
	</div>
</div>

<style>
	.chat-container {
		display: flex;
		flex-direction: column;
		height: 100vh;
		max-height: 100vh;
	}

	.app-layout {
		display: flex;
		flex: 1;
		overflow: hidden;
	}

	.messages-container {
		flex: 1;
		overflow-y: auto;
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.users-panel {
		width: 250px;
		border-left: 1px solid #eee;
		padding: 1rem;
		overflow-y: auto;
	}

	.users-panel h3 {
		margin-top: 0;
		margin-bottom: 1rem;
		font-size: 1.1rem;
		color: #333;
	}

	.users-list {
		list-style: none;
		padding: 0;
		margin: 0;
	}

	.user-item {
		padding: 0.5rem;
		margin-bottom: 0.5rem;
		background-color: #f9f9f9;
		border-radius: 4px;
		font-size: 0.9rem;
	}

	.user-address {
		word-break: break-all;
		font-family: monospace;
	}

	.no-users {
		color: #888;
		font-style: italic;
		text-align: center;
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

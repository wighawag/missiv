<script lang="ts">
	import { openRoom, type Account } from '$lib/room/index.js';
	import { derived, writable } from 'svelte/store';
	import Chat from '../app/chat/Chat.svelte';
	import { connection } from '../app/flow/connection.js';
	import { onMount } from 'svelte';

	const account = derived(connection, ($connection) => {
		console.log(`connection updated: `, $connection.step);
		if ($connection.step === 'SignedIn') {
			return $connection.account;
		}
		return undefined;
	});

	let room = openRoom({
		url: 'ws://localhost:8787/api/public/room/test/ws',
		account,
		autoLogin: true
	});

	onMount(() => {
		if (typeof window !== 'undefined') {
			(window as any).room = room;
		}
	});
</script>

<main>
	<div class="menu">
		{#if $connection.step === 'Idle'}
			<button
				onclick={() =>
					connection.connect({
						type: 'wallet'
					})}>connect</button
			>
		{:else if $connection.step === 'NeedWalletSignature'}
			<button onclick={() => connection.requestSignature()}>sign-in</button>
		{:else if $connection.step === 'WaitingForSignature'}
			<p>sign...</p>
		{:else if $connection.step === 'WaitingForWalletConnection'}
			<p>connecting...</p>
		{:else if $connection.step === 'MechanismToChoose'}
			<p>choice TODO</p>
		{:else if $connection.step === 'PopupLaunched'}
			<p>popup TODO</p>
		{:else if $connection.step === 'WalletToChoose'}
			{#if $connection.wallets.length > 0}
				{#each $connection.wallets as wallet}
					<button
						onclick={() =>
							connection.connect({
								type: 'wallet',
								name: wallet.info.name
							})}>{wallet.info.name}</button
					>
				{/each}
			{:else}
				<p>no wallet</p>
			{/if}
		{:else if $connection.step === 'SignedIn'}
			<p>${$connection.account.address}</p>
			<button onclick={() => connection.disconnect()}>disconnect</button>
		{:else}
			<p>{($connection as any).step}</p>
		{/if}
	</div>
	<Chat {room} />
</main>

<style>
	main {
		position: relative;
	}

	div {
		position: absolute;
		top: 0;
		right: 0;
	}
</style>

<script lang="ts">
	import { openRoom } from '$lib/room/index.js';
	import { derived, get } from 'svelte/store';
	import Chat from '../app/chat/Chat.svelte';
	import { connection } from '../app/flow/connection.js';
	import { onMount } from 'svelte';
	import { createMissivRegistration } from '$lib/registration/index.js';
	import { createRegistrationFlow } from '../app/flow/registration.js';

	const account = derived(connection, (currentConnection) => {
		console.log(`connection updated: `, currentConnection.step);
		if (currentConnection.step === 'SignedIn') {
			return currentConnection.account;
		}
		return undefined;
	});

	const registration = createMissivRegistration({
		account,
		domain: 'localhost',
		endpoint: 'http://localhost:8787'
	});

	const registrationFlow = createRegistrationFlow(registration, {
		requestSignature: connection.getSignatureForPublicKeyPublication
	});

	let room = openRoom({
		url: 'ws://localhost:8787/api/public/room/test/ws',
		registration,
		autoLogin: true
	});

	onMount(() => {
		const unsubscribeFromConnection = registration.subscribe((currentRegistration) => {
			if (currentRegistration.settled && !currentRegistration.registered) {
				const currentConnection = get(connection);
				if (currentConnection.step === 'SignedIn' && !currentRegistration.error) {
					if (currentConnection.account.savedPublicKeyPublicationSignature) {
						registration.register(currentConnection.account.savedPublicKeyPublicationSignature);
					}
				}
			}
		});
		if (typeof window !== 'undefined') {
			(window as any).room = room;
			(window as any).registration = registration;
			(window as any).account = account;
		}

		return () => {
			unsubscribeFromConnection();
		};
	});

	$inspect($registration);
	$inspect($account);
	$inspect($room);
	$inspect($registrationFlow);
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
			<!-- {:else if $connection.step === 'MechanismToChoose'}
			<p>choice TODO</p> -->
		{:else if $connection.step === 'PopupLaunched'}
			<p>popup TODO</p>
		{:else if $connection.step === 'WalletToChoose' || $connection.step === 'MechanismToChoose'}
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
				<button
					onclick={() =>
						connection.connect({
							type: 'email',
							mode: 'otp',
							email: undefined
						})}>email</button
				>
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
	<Chat
		{room}
		{registration}
		register={() => registrationFlow.execute()}
		connect={() => connection.connect()}
	/>
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

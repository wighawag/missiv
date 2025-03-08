<script lang="ts">
	import { openRoom } from '$lib/room/index.js';
	import { derived, get, type Readable } from 'svelte/store';
	import Chat from '../app/chat/Chat.svelte';
	import { connection } from '../app/flow/connection.js';
	import { onMount } from 'svelte';
	import { type Account, createMissivRegistration } from '$lib/registration/index.js';
	import { createRegistrationFlow } from '../app/flow/registration.js';
	import Modal from '../app/ui/modal/Modal.svelte';
	import type { Connection } from '@etherplay/connect';
	import ImgBlockie from '../app/utils/ethereum/ImgBlockie.svelte';

	const account = derived<Readable<Connection>, Account>(connection, (currentConnection) => {
		// console.log(`connection updated: `, currentConnection.step);
		if (currentConnection.step === 'SignedIn') {
			return currentConnection.account;
		} else if (currentConnection.step === 'WaitingForSignature') {
			return undefined;
			// TODO ? show new address
			// the following show the current one:
			// return {
			// 	address: currentConnection.mechanism.address,
			// 	signer: undefined
			// };
		}
		return undefined;
	});

	const registration = createMissivRegistration({
		account,
		domain: 'localhost:5173',
		endpoint: 'http://localhost:8787'
	});

	const registrationFlow = createRegistrationFlow(registration, {
		requestSignature: connection.getSignatureForPublicKeyPublication
	});

	let room = openRoom({
		url: 'ws://localhost:8787/api/public/room/@localhost:5173/ws',
		registration,
		autoLogin: true
	});

	onMount(() => {
		const unsubscribeFromConnection = registration.subscribe((currentRegistration) => {
			if (currentRegistration.step === 'Unregistered' && !currentRegistration.registering) {
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

	$inspect($registrationFlow);
	$inspect($registration);
	$inspect($account);
	$inspect($room);
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
			<button onclick={() => connection.cancel()}>cancel</button>
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
			<ImgBlockie address={$connection.account.address} style="width: 24px; height: 24px;" />
			<button onclick={() => connection.disconnect()}>disconnect</button>
			{#if $connection.walletAccountChanged}
				<button
					onclick={() =>
						connection.connectOnCurrentWalletAccount($connection.walletAccountChanged!)}
					>switch</button
				>
			{/if}
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

{#if $registrationFlow}
	<Modal oncancel={() => registrationFlow.cancel()} title="Registration" description="">
		<div class="modal-content">
			{#if $registrationFlow.step === 'Done'}
				<p>Registration complete</p>
				<button onclick={() => registrationFlow.acknowledgeCompletion()}>continue</button>
			{:else}
				<button onclick={() => registrationFlow.completeRegistration()}>sign</button>
			{/if}
		</div>
	</Modal>
{/if}

<style>
	.menu {
		position: absolute;
		top: 0;
		left: 0;
		background-color: white;
	}

	.modal-content {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 1rem;
	}
</style>

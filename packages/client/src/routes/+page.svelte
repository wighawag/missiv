<script lang="ts">
	import Chat from '../app/chat/Chat.svelte';
	import Modal from '../app/ui/modal/Modal.svelte';
	import ImgBlockie from '../app/utils/ethereum/ImgBlockie.svelte';
	import {
		registration,
		registrationFlow,
		room,
		connection,
		conversationList,
		profileShown,
		listShown,
		account
	} from '../app/state.js';
	import Conversation from '../app/conversations/Conversation.svelte';

	function showProfile(otherUser: { address: string }) {
		profileShown.show(otherUser);
	}

	function showConversationList() {
		listShown.show();
	}
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
			<button onclick={() => connection.cancel()}>cancel</button>
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
			{#if $conversationList.step === 'Fetched'}
				<button onclick={() => showConversationList()}
					><span style="color: red;">{$conversationList.numUnread}</span></button
				>
			{/if}
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
		{showProfile}
	/>
</main>

{#if $listShown && $conversationList.step === 'Fetched'}
	<Modal oncancel={() => listShown.hide()} title="Conversations" description="">
		<div class="modal-content">
			{#each $conversationList.conversations as conversation}
				{#if conversation.members.length === 2}
					{#each conversation.members.filter((m) => m != $account?.address) as member}
						{#if $account?.address}
							<button onclick={() => profileShown.show({ address: member })}
								><ImgBlockie address={member} style="width: 24px; height: 24px;" /></button
							>
						{/if}
					{/each}
				{:else}
					<p>group conversation not supported for now</p>
				{/if}
			{/each}
		</div>
	</Modal>
{/if}

{#if $profileShown && $account && $account.signer}
	<Modal oncancel={() => profileShown.hide()} title="Profile" description="">
		<div class="modal-content">
			<Conversation account={$account} otherUser={$profileShown} />
		</div>
	</Modal>
{/if}

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

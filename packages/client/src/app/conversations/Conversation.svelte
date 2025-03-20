<script lang="ts">
	import { openOneConversation } from '$lib/index.js';
	import { registration } from '../state.js';
	import ImgBlockie from '../utils/ethereum/ImgBlockie.svelte';

	export type ChatProps = {
		account: {
			address: `0x${string}`;
			signer: { address: `0x${string}`; privateKey: string; publicKey: string };
		};
		otherUser: { address: `0x${string}` }; // TODO publicKey
	};

	let { account, otherUser }: ChatProps = $props();

	const conversation = openOneConversation({
		registration: registration,
		account,
		domain: 'localhost:5173',
		otherUser,
		endpoint: 'http://localhost:8787',
		namespace: 'default', // TODO remove
		markAsAcceptedAndRead: false,
		pollingInterval: 2
	});

	let message = $state('');

	$inspect(conversation);
</script>

<ImgBlockie address={otherUser.address} style="width: 24px; height: 24px;" />

{#if $conversation.step === 'Fetched'}
	{#each $conversation.messages as message}
		<p>{message.content}</p>
	{/each}
{:else}
	<p>{$conversation.step}</p>
{/if}

<input type="text" bind:value={message} />
<button onclick={() => conversation.sendMessage(message)}>send</button>

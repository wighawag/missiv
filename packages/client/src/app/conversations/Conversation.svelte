<script lang="ts">
	import { openOneConversation } from '$lib/conversation/index.js';
	import { registration } from '../state.js';
	import ImgBlockie from '../utils/ethereum/ImgBlockie.svelte';

	export type ChatProps = {
		account: {
			address: string;
			signer: { address: string; privateKey: string; publicKey: string };
		};
		otherUser: { address: string };
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
		pollingInterval: 2000
	});

	let message = $state('');
</script>

<ImgBlockie address={otherUser.address} style="width: 24px; height: 24px;" />

<input type="text" bind:value={message} />
<button onclick={() => conversation.sendMessage(message)}>send</button>

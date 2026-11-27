<script lang="ts">
	import { openOneConversation } from '$lib/index.js';
	import { registration } from '../state.js';
	import { MISSIV_DOMAIN, PUBLIC_MISSIV_HTTP_ENDPOINT } from '../config.js';
	import ImgBlockie from '../utils/ethereum/ImgBlockie.svelte';

	export type ChatProps = {
		otherUser: { address: `0x${string}` };
	};

	let { otherUser }: ChatProps = $props();

	const conversation = openOneConversation({
		registration,
		domain: MISSIV_DOMAIN,
		otherUser,
		endpoint: PUBLIC_MISSIV_HTTP_ENDPOINT,
		namespace: 'default',
		markAsAcceptedAndRead: false
	});

	let message = $state('');
	let sendError = $state<string | undefined>();

	async function send(inClear: boolean) {
		sendError = undefined;
		try {
			if (inClear) {
				await conversation.sendIntroduction(message);
			} else {
				await conversation.sendMessage(message);
			}
			message = '';
		} catch (err) {
			sendError = err instanceof Error ? err.message : String(err);
		}
	}
</script>

<ImgBlockie address={otherUser.address} style="width: 24px; height: 24px;" />

{#if $conversation.step === 'Fetched'}
	{#each $conversation.messages as message (message.seq)}
		{#if message.error}
			<p class="error">({message.error.message})</p>
		{:else}
			<p>{message.scheme === 'clear' ? '(in clear) ' : ''}{message.content}</p>
		{/if}
	{/each}
{:else}
	<p>{$conversation.step}</p>
{/if}
{#if $conversation.error}
	<p class="error">{$conversation.error.message}</p>
{/if}

<input type="text" bind:value={message} />
{#if $conversation.otherUser.keySet}
	<button onclick={() => send(false)}>send</button>
{:else if $conversation.otherUser.unverifiedKey}
	<p class="error">their key is not proven by their wallet: messaging is disabled</p>
{:else}
	<button onclick={() => send(true)}>send an introduction in clear</button>
{/if}
{#if sendError}
	<p class="error">{sendError}</p>
{/if}

<style>
	.error {
		color: darkred;
	}
</style>

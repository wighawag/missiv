<script lang="ts">
	export let address: string;
	export let offset: number = 0;
	export let style: string | undefined = undefined;
	export let rootClass = '';

	import { Blockie } from './/blockie.js';

	$: uri = Blockie.getURI(address, offset);
</script>

<!-- svelte-ignore a11y-click-events-have-key-events -->
<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
<img class={rootClass} {style} src={uri} alt={address} on:click />

<style>
	img {
		image-rendering: -moz-crisp-edges;
		image-rendering: -webkit-crisp-edges;
		image-rendering: crisp-edges;
		image-rendering: pixelated;
	}
</style>

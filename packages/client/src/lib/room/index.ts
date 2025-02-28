import { derivedWithStartStopNotifier } from '$lib/utils/store.js';
import type { Readable } from 'svelte/store';

type Signer = { address: string; privateKey: string };
type AccountWithSigner = { address: string; signer: Signer };
type Account = AccountWithSigner | { address: string; signer: undefined } | undefined;

export type Message = { message: string };

export type Room = { error?: { message: string; cause?: any } } & (
	| {
			address?: string;
			loading: true;
	  }
	| { messages: Message[]; address?: string; loading: false }
);

export function openRoom(params: { url: string; account: Readable<Account> }) {
	let $room: Room | undefined = undefined;
	let _set: (value: Room | undefined) => void;
	let _account: Account | undefined;

	function set(room: Room | undefined) {
		$room = room;
		_set($room);
		return $room;
	}
	function setError(error: { message: string; cause?: any }) {
		if ($room) {
			set({
				...$room,
				error
			});
		} else {
			throw new Error(`no room`);
		}
	}

	function onWebsocketOpened(event: Event) {
		websocketEstablished = true;
		set({
			...$room,
			messages: [],
			loading: false
		});
	}
	function onWebsocketClosed(event: CloseEvent) {
		websocketEstablished = false;
		set(undefined);

		// TODO
		if (running) {
			// try again
		}
	}
	function onWebsocketMessage(event: MessageEvent) {
		if ($room && 'messages' in $room) {
			set({
				...$room,
				messages: [...$room.messages, JSON.parse(event.data)]
			});
		} else {
			console.error(`no room`);
		}
	}

	let running = false;
	let websocket: WebSocket | undefined;
	let websocketEstablished: boolean = false;
	function onStart() {
		running = true;
		websocketEstablished = false;
		websocket = new WebSocket(params.url);
		websocket.addEventListener('open', onWebsocketOpened);
		websocket.addEventListener('close', onWebsocketClosed);
		websocket.addEventListener('message', onWebsocketMessage);
	}

	function onAccountChanged() {
		const address = _account?.address;

		if (!$room || ('loading' in $room && $room.loading)) {
			set({
				address,
				loading: true
			});
		} else {
			set({
				address,
				messages: $room.messages,
				loading: false
			});
		}
	}

	function onStop() {
		running = false;
		if (websocket) {
			websocket.removeEventListener('open', onWebsocketOpened);
			websocket.addEventListener('close', onWebsocketClosed);
			websocket.addEventListener('message', onWebsocketMessage);
			websocket.close();
			websocketEstablished = false;
			websocket = undefined;
		}
	}

	const { subscribe } = derivedWithStartStopNotifier<Readable<Account>, Room | undefined>(
		params.account,
		($account) => {
			const changes =
				($account?.signer && !_account?.signer) ||
				(!$account?.signer && _account?.signer) ||
				$account?.signer?.address !== _account?.signer?.address;

			if (changes) {
				_account = $account;
				onAccountChanged();
			}
		},
		$room,
		(set) => {
			_set = set;
			onStart();
			return onStop;
		}
	);

	function sendMessage(message: string) {}

	return {
		subscribe,
		sendMessage
	};
}

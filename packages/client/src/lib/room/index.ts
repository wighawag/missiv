import { derivedWithStartStopNotifier } from '$lib/utils/store.js';
import type { ClientMessageType, ServerMessageType } from 'missiv-common';
import type { Readable } from 'svelte/store';

type Signer = { address: string; privateKey: string };
type AccountWithSigner = { address: string; signer: Signer };
type Account = AccountWithSigner | { address: string; signer: undefined } | undefined;

// TODO use ServerMessageType
export type Message = { message: string };
export type User = { address: string };

export type Room = { error?: { message: string; cause?: any } } & (
	| {
			loading: true;
			address?: string;
	  }
	| { loading: false; messages: Message[]; address?: string; users: User[] } // & ({loggedIn: false} | {loggedInd: true})
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
			users: [],
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
		const msgFromServer: ServerMessageType = JSON.parse(event.data);
		if ($room && 'messages' in $room) {
			if ('message' in msgFromServer) {
				set({
					...$room,
					messages: [...$room.messages, msgFromServer]
				});
			} else if ('joined' in msgFromServer) {
				set({
					...$room,
					users: [...$room.users, { address: msgFromServer.joined }]
				});
			} else if ('quit' in msgFromServer) {
				set({
					...$room,
					users: $room.users.filter((v) => v.address != msgFromServer.quit)
				});
			}
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
				...$room,
				address
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

	function sendMessage(message: string) {
		if (!$room || $room?.loading) {
			throw new Error(`not loaded`);
		}

		if (!websocket) {
			throw new Error(`no websocket`);
		}

		let address = _account?.address;
		if (!address) {
			// TODO
			// throw new Error(`no account`);
			address = 'fsadfs';
		}

		const msg: ClientMessageType = { message, address, signature: '0x' };

		websocket.send(JSON.stringify(msg));
	}

	return {
		subscribe,
		sendMessage
	};
}

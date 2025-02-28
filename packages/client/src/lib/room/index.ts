import { derivedWithStartStopNotifier } from '$lib/utils/store.js';
import { wait } from '$lib/utils/time.js';
import type { ClientMessageType, ServerMessageType } from 'missiv-common';
import type { Readable } from 'svelte/store';

type Signer = { address: string; privateKey: string };
type AccountWithSigner = { address: string; signer: Signer };
export type Account = AccountWithSigner | { address: string; signer: undefined } | undefined;

// TODO use ServerMessageType
export type Message = { message: string; pending?: boolean };
export type User = { address: string };

export type Room = { error?: { message: string; cause?: any } } & (
	| {
			loading: true;
			address?: string;
	  }
	| {
			loading: false;
			messages: Message[];
			address?: string;
			users: User[];
			loggedIn: boolean;
			loggingIn: boolean;
	  } // & ({loggedIn: false} | {loggedInd: true})
);

export function openRoom(params: { url: string; account: Readable<Account>; autoLogin?: boolean }) {
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
			loading: false,
			loggedIn: false,
			loggingIn: false
		});

		if (params.autoLogin && _account?.signer) {
			login();
		}
	}
	function onWebsocketClosed(event: CloseEvent) {
		websocketEstablished = false;
		set(undefined);

		// TODO
		if (running) {
			// try again
			// onStart();
		}
	}
	function onWebsocketMessage(event: MessageEvent) {
		const msgFromServer: ServerMessageType = JSON.parse(event.data);
		if ($room && 'messages' in $room) {
			if ('message' in msgFromServer) {
				set({
					...$room,
					messages: [
						...$room.messages.filter((v) => !(v.pending && v.message === msgFromServer.message)),
						msgFromServer
					]
				});
			} else if ('joined' in msgFromServer) {
				const justLoggedIn = msgFromServer.joined === _account?.address;

				set({
					...$room,
					users: [...$room.users, { address: msgFromServer.joined }],
					loggingIn: justLoggedIn ? false : $room.loggingIn,
					loggedIn: justLoggedIn ? true : $room.loggedIn
				});
			} else if ('quit' in msgFromServer) {
				const justLoggedOut = msgFromServer.quit === _account?.address;
				set({
					...$room,
					users: $room.users.filter((v) => v.address != msgFromServer.quit),
					loggingIn: justLoggedOut ? false : $room.loggingIn,
					loggedIn: justLoggedOut ? false : $room.loggedIn
				});
			} else if ('error' in msgFromServer) {
				// id for message or message.message + address is the id ?
				// rate limit erro should then return the message
				// or any other error too
				// so maybe best is to pass a message field for message failure
				// now handling multiple of these failed message in the frontend would require flaging them as to retry
				// else we can wait to allow further message until last one is acknowledge,much eaiser that way
				// if (msgFromServer.type === 'RATE_LIMITED') {
				// 	// TODO return message to input
				// }
				// set({
				// 	...$room,
				// 	loggingIn: false,
				// 	loggedIn: false,
				// 	error: msgFromServer.error
				// });
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
			if (params.autoLogin && _account?.signer) {
				login();
			}
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

	async function sendMessage(message: string) {
		if (!$room || $room?.loading) {
			throw new Error(`not loaded`);
		}

		if (!websocket) {
			throw new Error(`no websocket`);
		}

		const address = _account?.address;
		if (!address) {
			throw new Error(`no account`);
		}

		const msg: ClientMessageType = { message, signature: '0x' };

		set({
			...$room,
			messages: [...$room.messages, { ...msg, pending: true }]
		});
		// await wait(3);
		websocket.send(JSON.stringify(msg));
	}

	function login() {
		if (!$room || $room?.loading) {
			throw new Error(`not loaded`);
		}

		if (!websocket) {
			throw new Error(`no websocket`);
		}

		const address = _account?.address;
		if (!address) {
			throw new Error(`no account`);
		}

		const msg: ClientMessageType = { address, signature: '0x' };

		set({
			...$room,
			loggedIn: false,
			loggingIn: true
		});
		websocket.send(JSON.stringify(msg));
	}

	function debug_forceClose() {
		websocket?.close();
	}

	return {
		subscribe,
		sendMessage,
		login,
		debug_forceClose
	};
}

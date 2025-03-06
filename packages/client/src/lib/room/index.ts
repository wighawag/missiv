import type { MissivRegistration, MissivRegistrationStore } from '$lib/registration/index.js';
import { derivedWithStartStopNotifier } from '$lib/utils/store.js';
import { wait } from '$lib/utils/time.js';
import type { ClientMessageType, ServerMessageType } from 'missiv-common';
import { get } from 'svelte/store';

// TODO use ServerMessageType
export type ChatMessage = { message: string; pending?: boolean };
export type ChatUser = { address: string };

export type Room = { error?: { message: string; cause?: any } } & (
	| {
			loading: true;
			address?: string;
			registration: { settled: false; registered: false; registering: false };
	  }
	| {
			loading: false;
			messages: ChatMessage[];
			address?: string;
			registration: { settled: boolean; registered: boolean; registering: boolean };
			users: ChatUser[];
			loggedIn: boolean;
			loggingIn: boolean;
	  } // & ({loggedIn: false} | {loggedInd: true})
);

// auto-login works only if user us registered
// TODO
// we need to set a registration store
// shared between chat and async conversations
// both should be able to trigger the registration
export function openRoom(params: {
	url: string;
	registration: MissivRegistrationStore;
	autoLogin?: boolean;
}) {
	let $room: Room | undefined = undefined;
	let _set: (value: Room | undefined) => void;
	let _registration: MissivRegistration = get(params.registration);

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
			registration: _registration,
			loading: false,
			loggedIn: false,
			loggingIn: false
		});

		if (params.autoLogin && _registration.registered && _registration.signer) {
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
				const justLoggedIn =
					_registration.registered && msgFromServer.joined === _registration.address;

				set({
					...$room,
					users: [...$room.users, { address: msgFromServer.joined }],
					loggingIn: justLoggedIn ? false : $room.loggingIn,
					loggedIn: justLoggedIn ? true : $room.loggedIn
				});
			} else if ('quit' in msgFromServer) {
				const justLoggedOut =
					_registration.registered && msgFromServer.quit === _registration.address;
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

	function onRegistrationChanged(
		oldRegistration: MissivRegistration,
		newRegistration: MissivRegistration
	) {
		const newAddress = newRegistration.registered ? newRegistration.address : undefined;
		const oldAddress = oldRegistration.registered ? oldRegistration.address : undefined;

		const addressChanged =
			(newAddress && !oldAddress) || (!newAddress && oldAddress) || newAddress !== oldAddress;

		const address = newRegistration.registered ? newRegistration.address : undefined;
		if (addressChanged) {
			if (!$room || ('loading' in $room && $room.loading)) {
				set({
					address,
					loading: true,
					registration: { registered: false, registering: false, settled: false }
				});
			} else {
				set({
					...$room,
					registration: _registration,
					address
				});
				if (params.autoLogin && address) {
					login();
				} else {
					logout();
				}
			}
		} else if (
			$room &&
			(newRegistration.settled !== oldRegistration.settled ||
				newRegistration.registered != oldRegistration.registered ||
				newRegistration.registering != oldRegistration.registering)
		) {
			if (!$room || ('loading' in $room && $room.loading)) {
				set({
					address,
					loading: true,
					registration: { registered: false, registering: false, settled: false }
				});
			} else {
				set({
					...$room,
					registration: _registration
				});
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

	const { subscribe } = derivedWithStartStopNotifier<MissivRegistrationStore, Room | undefined>(
		params.registration,
		($registration) => {
			const oldRegistration = _registration;
			_registration = $registration;
			onRegistrationChanged(oldRegistration, $registration);
			return $room;
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

		const address = _registration.registered && _registration?.address;
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

		const address = _registration.registered && _registration?.address;
		if (!address) {
			throw new Error(`no account`);
		}

		const msg: ClientMessageType = { address, signature: '0x' };

		set({
			...$room,
			loggedIn: false,
			loggingIn: true,
			registration: _registration
		});
		websocket.send(JSON.stringify(msg));
	}

	function logout() {
		if (!$room || $room?.loading) {
			throw new Error(`not loaded`);
		}

		if (!websocket) {
			throw new Error(`no websocket`);
		}

		const msg: ClientMessageType = { logout: true };

		set({
			...$room,
			loggedIn: false,
			loggingIn: true,
			registration: _registration
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

export type RoomStore = ReturnType<typeof openRoom>;

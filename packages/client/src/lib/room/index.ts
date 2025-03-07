import type { MissivRegistration, MissivRegistrationStore } from '$lib/registration/index.js';
import { derivedWithStartStopNotifier } from '$lib/utils/store.js';
import { wait } from '$lib/utils/time.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { signAsync } from '@noble/secp256k1';
import type { ClientMessageType, ServerMessageType } from 'missiv-common';
import { get } from 'svelte/store';

// TODO use ServerMessageType
export type ChatMessage = { message: string; pending?: boolean };
export type ChatUser = { address: string };

export type Room = { error?: { message: string; cause?: any } } & (
	| {
			step: 'Connecting';
			address: string | undefined;
	  }
	| {
			step: 'Connected';
			address: undefined;
			loginStatus: 'NoAccount';
			messages: ChatMessage[];
			users: ChatUser[];
	  }
	| {
			step: 'Connected';
			address: string;
			loginStatus: 'LoggedOut';
			messages: ChatMessage[];
			users: ChatUser[];
			challenge: string;
			loggingIn: boolean;
	  }
	| {
			step: 'Connected';
			address: string;
			loginStatus: 'LoggedOut';
			messages: ChatMessage[];
			users: ChatUser[];
			challenge: undefined;
	  }
	| {
			step: 'Connected';
			address: string;
			loginStatus: 'LoggedIn';
			messages: ChatMessage[];
			users: ChatUser[];
			loggingOut: boolean;
	  }
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
	// we reuse the same challenge
	let savedChallenge: string | undefined;
	let loginOnChallengeReceived: boolean = false;

	let $room: Room = {
		step: 'Connecting',
		address: undefined
	};
	let _set: (value: Room) => void;
	let _registration: MissivRegistration = get(params.registration);

	function set(room: Room) {
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

		if ($room.address) {
			set({
				step: 'Connected',
				loginStatus: 'LoggedOut',
				address: $room.address,
				messages: [],
				users: [],
				challenge: undefined
			});
			if (params.autoLogin) {
				login();
			}
		} else {
			set({
				step: 'Connected',
				loginStatus: 'NoAccount',
				address: undefined,
				messages: [],
				users: []
			});
		}
	}
	function onWebsocketClosed(event: CloseEvent) {
		websocketEstablished = false;
		set({ step: 'Connecting', address: $room.address, error: { message: 'disconnected' } });

		// TODO
		if (running) {
			// try again
			// onStart();
		}
	}
	function onWebsocketMessage(event: MessageEvent) {
		const msgFromServer: ServerMessageType = JSON.parse(event.data);

		if ($room.step === 'Connected') {
			if ('challenge' in msgFromServer) {
				savedChallenge = msgFromServer.challenge;
				if ($room.loginStatus === 'LoggedOut') {
					set({
						step: 'Connected',
						loginStatus: 'LoggedOut',
						address: $room.address,
						messages: $room.messages,
						users: $room.users,
						challenge: msgFromServer.challenge,
						loggingIn: false
					});
					if (loginOnChallengeReceived) {
						loginOnChallengeReceived = false;
						login();
					}
				}
			} else if ('message' in msgFromServer) {
				set({
					...$room,
					messages: [
						...$room.messages.filter((v) => !(v.pending && v.message === msgFromServer.message)),
						msgFromServer
					]
				});
			} else if ('joined' in msgFromServer) {
				const justLoggedIn =
					_registration.step === 'Registered' && msgFromServer.joined === _registration.address;

				if (justLoggedIn) {
					set({
						step: 'Connected',
						loginStatus: 'LoggedIn',
						address: msgFromServer.joined,
						messages: $room.messages,
						users: [...$room.users, { address: msgFromServer.joined }],
						loggingOut: false
					});
				} else {
					set({
						...$room,
						users: [...$room.users, { address: msgFromServer.joined }]
					});
				}
			} else if ('quit' in msgFromServer) {
				const justLoggedOut =
					_registration.step === 'Registered' && msgFromServer.quit === _registration.address;

				if (justLoggedOut) {
					if ($room.loginStatus === 'LoggedIn') {
						if (!savedChallenge) {
							set({
								step: 'Connected',
								loginStatus: 'LoggedOut',
								address: $room.address,
								users: $room.users.filter((v) => v.address != msgFromServer.quit),
								messages: $room.messages,
								challenge: undefined,
								error: { message: 'no challenge save' }
							});
						} else {
							set({
								step: 'Connected',
								loginStatus: 'LoggedOut',
								address: $room.address,
								users: $room.users.filter((v) => v.address != msgFromServer.quit),
								messages: $room.messages,
								challenge: savedChallenge,
								loggingIn: false
							});
						}
					} else {
						console.error(`quit but not LoggedIn`);
					}
				} else {
					set({
						...$room,
						users: $room.users.filter((v) => v.address != msgFromServer.quit)
					});
				}
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
			console.error(`not connected`);
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

	async function onRegistrationChanged(
		oldRegistration: MissivRegistration,
		newRegistration: MissivRegistration
	) {
		const newAddress = newRegistration.step === 'Registered' ? newRegistration.address : undefined;
		const oldAddress = oldRegistration.step === 'Registered' ? oldRegistration.address : undefined;

		const addressChanged =
			(newAddress && !oldAddress) || (!newAddress && oldAddress) || newAddress !== oldAddress;

		if (addressChanged) {
			if ($room.step === 'Connecting') {
				set({
					step: 'Connecting',
					address: newAddress
				});
			} else {
				if (newAddress) {
					if (oldAddress) {
						logout();
					}

					if (params.autoLogin) {
						if (!savedChallenge) {
							loginOnChallengeReceived = true;
						} else {
							login();
						}
					}
				} else {
					if ($room.loginStatus === 'LoggedIn') {
						logout();
					}
				}
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

	const { subscribe } = derivedWithStartStopNotifier<MissivRegistrationStore, Room>(
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
		if ($room.step !== 'Connected' || $room.loginStatus !== 'LoggedIn') {
			throw new Error(`not logged in`);
		}

		if (!websocket) {
			throw new Error(`no websocket`);
		}

		const address = _registration.step === 'Registered' && _registration?.address;
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

	async function login() {
		if (!savedChallenge) {
			throw new Error(`no challenge to sign`);
		}
		if (
			$room.step !== 'Connected' ||
			($room.loginStatus !== 'LoggedOut' && $room.loginStatus !== 'NoAccount')
		) {
			throw new Error(`not Logged Out`);
		}

		if (!websocket) {
			throw new Error(`no websocket`);
		}

		const address = _registration.step == 'Registered' && _registration.address;
		if (!address) {
			throw new Error(`no account`);
		}

		const signer = _registration.step == 'Registered' && _registration.signer;
		if (!signer) {
			throw new Error(`no signer`);
		}

		const privateKey =
			typeof signer.privateKey == 'string' && signer.privateKey.startsWith('0x')
				? signer.privateKey.slice(2)
				: signer.privateKey;

		set({
			step: 'Connected',
			loginStatus: 'LoggedOut',
			address,
			messages: $room.messages,
			users: $room.users,
			loggingIn: true,
			challenge: savedChallenge
		});
		const signatureObject = await signAsync(keccak_256(savedChallenge), privateKey); // Sync methods below
		const signature = `${signatureObject.toCompactHex()}:${signatureObject.recovery}`;
		const msg: ClientMessageType = { address, signature };

		websocket.send(JSON.stringify(msg));
	}

	function logout() {
		loginOnChallengeReceived = false;
		if ($room.step !== 'Connected' || $room.loginStatus !== 'LoggedIn') {
			throw new Error(`not Logged In`);
		}

		if (!websocket) {
			throw new Error(`no websocket`);
		}

		const msg: ClientMessageType = { logout: true };

		set({
			step: 'Connected',
			loginStatus: 'LoggedIn',
			address: $room.address,
			messages: $room.messages,
			users: $room.users,
			loggingOut: true
		});
		try {
			websocket.send(JSON.stringify(msg));
		} catch (err) {
			// TODO ?
			console.error(err);
		}

		set({
			step: 'Connected',
			loginStatus: 'LoggedOut',
			address: $room.address,
			messages: $room.messages,
			users: $room.users,
			loggingIn: false,
			challenge: savedChallenge
		});
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

import type { Connection } from '@etherplay/connect';
import { derived, get, writable, type Readable } from 'svelte/store';
import { connection } from './flow/connection.js';
import { createRegistrationFlow } from './flow/registration.js';
import {
	openRoom,
	openConversationList,
	createMissivRegistration,
	type Account
} from '$lib/index.js';

export const account = derived<Readable<Connection>, Account>(connection, (currentConnection) => {
	// console.log(`connection updated: `, currentConnection.step);
	if (currentConnection.step === 'SignedIn') {
		return currentConnection.account;
	} else if (currentConnection.step === 'WaitingForSignature') {
		return undefined;
		// TODO ? show new address
		// the following show the current one:
		// return {
		// 	address: currentConnection.mechanism.address,
		// 	signer: undefined
		// };
	}
	return undefined;
});

export const registration = createMissivRegistration({
	account,
	domain: 'localhost:5173',
	endpoint: 'http://localhost:8787'
});

export const registrationFlow = createRegistrationFlow(registration, {
	requestSignature: connection.getSignatureForPublicKeyPublication
});

export const conversationList = openConversationList({
	registration,
	endpoint: 'http://localhost:8787',
	domain: 'localhost:5173',
	namespace: 'default' // TODO remove domain from missiv ?
});

export const room = openRoom({
	url: 'ws://localhost:8787/api/public/room/@localhost:5173/ws',
	registration,
	autoLogin: true
});

export { connection };

const _listShown = writable<boolean>(false);
export const listShown = {
	subscribe: _listShown.subscribe,
	show() {
		_listShown.set(true);
	},
	hide() {
		_listShown.set(false);
	}
};

const _profileShown = writable<{ address: string } | undefined>(undefined);
export const profileShown = {
	subscribe: _profileShown.subscribe,
	show(user: { address: string }) {
		_profileShown.set(user);
	},
	hide() {
		_profileShown.set(undefined);
	}
};

// TODO setup a callback in registration or in co
// or maybe simply add an auto-registration option with a mechanism to fetch savedPublicKeyPublicationSignature
registration.subscribe((currentRegistration) => {
	if (currentRegistration.step === 'Unregistered' && !currentRegistration.registering) {
		const currentConnection = get(connection);
		if (currentConnection.step === 'SignedIn' && !currentRegistration.error) {
			if (currentConnection.account.savedPublicKeyPublicationSignature) {
				registration.register(currentConnection.account.savedPublicKeyPublicationSignature);
			}
		}
	}
});

if (typeof window !== 'undefined') {
	const w = window as any;
	w.conversationList = conversationList;
	w.room = room;
	w.registration = registration;
	w.account = account;
	w.connection = connection;
	w.profileShown = profileShown;
	w.listShown = listShown;
	w.get = get;
}

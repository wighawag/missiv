import { derivedWithStartStopNotifier } from '$lib/utils/store.js';
import type { Readable } from 'svelte/store';

type Signer = { address: string; privateKey: string };
type LoadedPrivateAccount = { signer: Signer };
type PrivateAccount = LoadedPrivateAccount | { signer: undefined } | undefined;

export type Message = { content: string }[];

export type Room = { error?: { message: string; cause?: any } } & (
	| {
			loading: true;
	  }
	| { messages: Message[] }
);

export function openRoom(params: { roomID: string; account: Readable<PrivateAccount> }) {
	let $room: Room | undefined = undefined;
	let _set: (value: Room | undefined) => void;
	let _account: PrivateAccount | undefined;

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

	function onStart() {}

	function onAccountChanged() {}

	function onStop() {}

	const { subscribe } = derivedWithStartStopNotifier<Readable<PrivateAccount>, Room | undefined>(
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

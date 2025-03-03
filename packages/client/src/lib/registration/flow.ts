import { derived, writable, type Readable } from 'svelte/store';
import type { MissivAccountStore } from './index.js';

export type RegistrationFlow = {
	step: 'FillOutForm' | 'WaitForSignature' | 'Done';
	error?: { message: string; cause?: any };
};

export function createRegistrationFlow(missivAccount: MissivAccountStore) {
	let $flow: RegistrationFlow | undefined = undefined;
	const _store = writable<RegistrationFlow | undefined>($flow);
	function set(flow: RegistrationFlow | undefined) {
		$flow = flow;
		_store.set($flow);
		return $flow;
	}
	function setError(error: { message: string; cause?: any }) {
		if ($flow) {
			set({
				...$flow,
				error
			});
		} else {
			throw new Error(`no room`);
		}
	}

	// const _store = derived<MissivAccountStore, RegistrationFlow | undefined>(
	// 	missivAccount,
	// 	($missivAccount, set) => {
	// 		if ($missivAccount.error) {
	// 			set({
	// 				step: 'start',
	// 				error: $missivAccount.error.message
	// 			});
	// 		} else if ($missivAccount.registered) {
	// 			set({
	// 				step: 'done'
	// 			});
	// 		} else {
	// 			set({
	// 				step: 'start'
	// 			});
	// 		}
	// 	},
	// 	undefined
	// );

	function start() {
		set({
			step: 'FillOutForm'
		});
	}

	function requestSignature() {
		set({
			step: 'WaitForSignature'
		});
	}

	async function completeRegistration(
		signature: string,
		options?: {
			name?: string;
			domainUsername?: string;
			domainDescription?: string;
			description?: string;
			closeOnComplete?: boolean;
		}
	) {
		try {
			await missivAccount.register(signature, options);
			if (options?.closeOnComplete) {
				set(undefined);
			} else {
				set({
					step: 'Done'
				});
			}
		} catch (err) {
			setError({ message: 'failed to complete registration', cause: err });
		}
	}

	return {
		subscribe: _store.subscribe,
		start,
		requestSignature,
		completeRegistration
	};
}

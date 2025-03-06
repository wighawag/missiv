import { derived, writable, type Readable } from 'svelte/store';
import type {
	CompleteUser,
	MissivRegistration,
	MissivRegistrationStore
} from '$lib/registration/index.js';
import { publicKeyAuthorizationMessage } from 'missiv-common';

export type RegistrationFlow = {
	step: 'NeedInformation' | 'WaitingForSignature' | 'Registering' | 'Interupted' | 'Done';
	address: string;
	error?: { message: string; cause?: any };
};

export function createRegistrationFlow(
	missivRegistration: MissivRegistrationStore,
	params: { requestSignature: (address: string, msg: string) => Promise<string> }
) {
	let $flow: RegistrationFlow | undefined = undefined;
	let $missivRegistration: MissivRegistration | undefined = undefined;
	const _store = writable<RegistrationFlow | undefined>($flow, () => {
		const unsubscribeFromAccount = missivRegistration.subscribe(($newMissivRegistration) => {
			const $oldMissivRegistration = $missivRegistration;
			$missivRegistration = $newMissivRegistration;
			if ($flow) {
				let interuptedByChangeOfAccount = false;
				if (!$newMissivRegistration.settled && $newMissivRegistration.loading) {
					if ($flow?.address && $flow.address != $newMissivRegistration.address) {
						interuptedByChangeOfAccount = true;
					}
				} else {
					interuptedByChangeOfAccount = true;
				}
				if (interuptedByChangeOfAccount) {
					// we close
					// TODO intermediary state to warn user of flow interuption ?
					set({
						...$flow,
						step: 'Interupted'
					});
				}
			}
		});
		return () => {
			unsubscribeFromAccount();
		};
	});
	function set(flow: RegistrationFlow) {
		$flow = flow;
		_store.set($flow);
		return $flow;
	}
	function rejectFlow() {
		$flow = undefined;
		_store.set($flow);
		if (_promise) {
			_promise.reject({ message: 'cancelled' });
			_promise = undefined;
		} else {
			throw new Error(`no promise`);
		}
	}

	function resolveFlow() {
		const missivRegistration = $missivRegistration;
		if (!missivRegistration?.registered) {
			throw new Error(`not registered`);
		}
		$flow = undefined;
		_store.set($flow);
		if (_promise) {
			_promise.resolve(missivRegistration.user);
			_promise = undefined;
		} else {
			throw new Error(`no promise`);
		}
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

	let _promise:
		| {
				resolve: (user: CompleteUser) => void;
				reject: (error: { message: string; cause?: any }) => void;
		  }
		| undefined;

	function execute(): Promise<CompleteUser> {
		if (!$missivRegistration?.settled && !$missivRegistration?.loading) {
			throw new Error(`not settled`);
		}

		if (_promise) {
			// cancel existing flow
			cancel();
		}

		set({
			step: 'NeedInformation',
			address: $missivRegistration.address
		});
		return new Promise((resolve, reject) => {
			_promise = { resolve, reject };
		});
	}

	async function completeRegistration(options?: {
		name?: string;
		domainUsername?: string;
		domainDescription?: string;
		description?: string;
		closeOnComplete?: boolean;
	}) {
		if (!$missivRegistration?.settled && !$missivRegistration?.loading) {
			throw new Error(`not settled`);
		}

		if ($flow?.step !== 'NeedInformation') {
			throw new Error(`not in WaitingForSignature step`);
		}

		set({
			step: 'WaitingForSignature',
			address: $flow.address
		});

		let signature: string;
		try {
			signature = await params.requestSignature(
				$flow.address,
				publicKeyAuthorizationMessage({
					address: $missivRegistration.address,
					publicKey: $missivRegistration.signer.publicKey
				})
			);
		} catch (err) {
			set({
				step: 'NeedInformation',
				address: $flow.address,
				error: { message: 'failed to get signature', cause: err }
			});
			throw new Error(`failed to get signature`);
		}

		set({
			step: 'Registering',
			address: $flow.address
		});
		try {
			await missivRegistration.register(signature, options);
			if (options?.closeOnComplete) {
				resolveFlow();
			} else {
				set({
					step: 'Done',
					address: $flow.address
				});
			}
		} catch (err) {
			set({
				step: 'NeedInformation',
				address: $flow.address,
				error: { message: 'failed to complete registration', cause: err }
			});
		}
	}

	function cancel() {
		rejectFlow();
	}

	function acknowledgeCompletion() {
		resolveFlow();
	}

	return {
		subscribe: _store.subscribe,
		execute,
		completeRegistration,
		cancel,
		acknowledgeCompletion
	};
}

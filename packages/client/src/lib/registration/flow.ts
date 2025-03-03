import { derived, writable, type Readable } from 'svelte/store';
import type { MissivAccount, MissivAccountStore } from './index.js';
import { publicKeyAuthorizationMessage } from 'missiv-common';

export type RegistrationFlow = {
	step: 'NeedInformation' | 'WaitingForSignature' | 'Registering' | 'Interupted' | 'Done';
	address: string;
	error?: { message: string; cause?: any };
};

export function createRegistrationFlow(
	missivAccount: MissivAccountStore,
	params: { requestSignature: (address: string, msg: string) => Promise<string> }
) {
	let $flow: RegistrationFlow | undefined = undefined;
	let $missivAccount: MissivAccount | undefined = undefined;
	const _store = writable<RegistrationFlow | undefined>($flow, () => {
		const unsubscribeFromAccount = missivAccount.subscribe(($newMissivAccount) => {
			const $oldMissivAccount = $missivAccount;
			$missivAccount = $newMissivAccount;
			if ($flow) {
				let interuptedByChangeOfAccount = false;
				if (!$newMissivAccount.settled && $newMissivAccount.loading) {
					if ($flow?.address && $flow.address != $newMissivAccount.address) {
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

	function start() {
		if (!$missivAccount?.settled && !$missivAccount?.loading) {
			throw new Error(`not settled`);
		}
		set({
			step: 'NeedInformation',
			address: $missivAccount.address
		});
	}

	async function completeRegistration(options?: {
		name?: string;
		domainUsername?: string;
		domainDescription?: string;
		description?: string;
		closeOnComplete?: boolean;
	}) {
		if (!$missivAccount?.settled && !$missivAccount?.loading) {
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
					address: $missivAccount.address,
					publicKey: $missivAccount.signer.publicKey
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
			await missivAccount.register(signature, options);
			if (options?.closeOnComplete) {
				set(undefined);
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
		set(undefined);
	}

	return {
		subscribe: _store.subscribe,
		start,
		completeRegistration,
		cancel
	};
}

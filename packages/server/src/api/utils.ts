import {Address, PublicKey} from 'missiv-common';

export function getConversationID(accountA: Address, accountB: Address) {
	accountA = accountA.toLowerCase() as PublicKey;
	accountB = accountB.toLowerCase() as PublicKey;
	if (accountA > accountB) {
		return `${accountA}${accountB}`;
	} else {
		return `${accountB}${accountA}`;
	}
}

export function publicKeyAuthorizationMessage({
	address,
	publicKey,
}: {
	address: `0x${string}`;
	publicKey: `0x${string}`;
}): string {
	return `I authorize the following Public Key to represent me:\n ${publicKey}\n\n  Others can use this key to write me messages`;
}

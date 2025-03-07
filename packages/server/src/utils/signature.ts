import {keccak_256} from '@noble/hashes/sha3';
import {Signature} from '@noble/secp256k1';
import {PublicKey} from 'missiv-common';

export function recoverPublicKey(signatureString: string, message: string) {
	const splitted = signatureString.split(':');
	const recoveryBit = Number(splitted[1]);
	const signature = Signature.fromCompact(splitted[0]).addRecoveryBit(recoveryBit);
	const msgHash = keccak_256(message);
	const recoveredPubKey = signature.recoverPublicKey(msgHash);
	return `0x${recoveredPubKey.toHex().toLowerCase()}` as PublicKey;
}

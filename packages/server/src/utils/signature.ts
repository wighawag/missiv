// missiv's own request signature: keccak256 over the raw body (or the room's
// challenge), with no envelope. delegated-identity's signRequest / recoverRequestSigner
// is its successor (server origin, route, timestamp); adopting it at missiv's
// routes and the room login is step S3's (S3-6), so this stays until then.
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

// The KeyDirectory over `remote-sql` (ADR-0005): `KeySets` (every key set
// registered in a domain by keyRef, current or replaced), `DomainUsers` (each
// account's current one and its profile) and the replay set of `/session` and
// `register` (`RequestSignatures`).
import type {RemoteSQL} from 'remote-sql';
import type {
	ActionEditDomainUser,
	ActionRegisterDomainUser,
	Address,
	DomainUser,
	PublicKey,
	PublicKeySet,
	RegisteredKeySet,
	ResponseGetDomainUser,
	ResponseGetKeySet,
	String0x,
} from '@missiv/common';
import {MissivError} from '../../errors.js';
import type {KeyDirectory} from '../ports.js';
import {isUniqueViolation} from './util.js';

type KeySetRow = {
	domain: string;
	keyRef: String0x;
	user: Address;
	signingKey: PublicKey;
	encryptionKey: PublicKey;
	ownershipSignature: String0x;
	appOrigin: string;
	registered: number;
};

type DomainUserRow = KeySetRow & {
	name: string | null;
	description: string | null;
	added: number;
	lastPresence: number;
};

function keySetOf(row: {signingKey: PublicKey; encryptionKey: PublicKey}): PublicKeySet {
	return {signing: {publicKey: row.signingKey}, encryption: {publicKey: row.encryptionKey}};
}

function formatKeySet(row: KeySetRow): RegisteredKeySet {
	return {
		user: row.user,
		domain: row.domain,
		keyRef: row.keyRef,
		keySet: keySetOf(row),
		ownershipSignature: row.ownershipSignature,
		appOrigin: row.appOrigin,
		registered: row.registered,
	};
}

function formatDomainUser(row: DomainUserRow): DomainUser {
	return {
		user: row.user,
		domain: row.domain,
		keyRef: row.keyRef,
		keySet: keySetOf(row),
		ownershipSignature: row.ownershipSignature,
		appOrigin: row.appOrigin,
		name: row.name,
		description: row.description,
		added: row.added,
		lastPresence: row.lastPresence,
	};
}

/** A domain user with its current key set: the key set is the one its row names, of the same user. */
const DOMAIN_USERS_SELECT = `
	SELECT d.user AS user, d.domain AS domain, d.keyRef AS keyRef, d.name AS name, d.description AS description,
		d.added AS added, d.lastPresence AS lastPresence, k.signingKey AS signingKey, k.encryptionKey AS encryptionKey,
		k.ownershipSignature AS ownershipSignature, k.appOrigin AS appOrigin, k.registered AS registered
	FROM DomainUsers d
	JOIN KeySets k ON k.domain = d.domain AND k.keyRef = d.keyRef AND k.user = d.user`;

export class SQLKeyDirectory implements KeyDirectory {
	constructor(private db: RemoteSQL) {}

	/**
	 * Register a key set (checked by the caller) as the current one of (address,
	 * domain), or REPLACE the current one there: the replaced key set stays
	 * stored (`getKeySet`), so messages it signed stay verifiable, and only its
	 * keys can read what was encrypted to it. Registering the current key set
	 * again (another device of the account derives the same) keeps it. A key set,
	 * or a key of it, registered for another (user, domain) is a 409.
	 */
	async register(
		address: Address,
		keyRef: String0x,
		timestampMS: number,
		action: ActionRegisterDomainUser,
	): Promise<void> {
		const signingKey = action.keySet.signing.publicKey;
		const encryptionKey = action.keySet.encryption.publicKey;
		const {results: owners} = await this.db
			.prepare(`SELECT user, domain FROM KeySets WHERE signingKey = ?1 OR encryptionKey = ?2`)
			.bind(signingKey, encryptionKey)
			.all<{user: Address; domain: string}>();
		if (owners.some((owner) => owner.user !== address || owner.domain !== action.domain)) {
			throw new MissivError('conflict', 'this key set is already registered for another account or domain');
		}
		try {
			await this.db.batch([
				this.db
					.prepare(
						`INSERT INTO KeySets (domain, keyRef, user, signingKey, encryptionKey, ownershipSignature, appOrigin, registered)
						VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
						ON CONFLICT (domain, keyRef) DO UPDATE SET
							ownershipSignature = excluded.ownershipSignature,
							appOrigin = excluded.appOrigin
						WHERE KeySets.user = excluded.user`,
					)
					.bind(
						action.domain,
						keyRef,
						address,
						signingKey,
						encryptionKey,
						action.ownershipSignature,
						action.appOrigin,
						timestampMS,
					),
				this.db
					.prepare(
						`INSERT INTO DomainUsers (user, domain, keyRef, name, description, added, lastPresence)
						VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
						ON CONFLICT (user, domain) DO UPDATE SET
							keyRef = excluded.keyRef,
							name = coalesce(excluded.name, name),
							description = coalesce(excluded.description, description),
							lastPresence = excluded.lastPresence`,
					)
					.bind(address, action.domain, keyRef, action.name ?? null, action.description ?? null, timestampMS),
			]);
		} catch (err) {
			if (isUniqueViolation(err)) {
				throw new MissivError('conflict', 'this key set is already registered for another account or domain');
			}
			throw err;
		}
	}

	/**
	 * Record a request signature until `expiresAt`, dropping the expired ones;
	 * false when it was already recorded (a replay).
	 */
	async acceptRequestSignature(signature: string, expiresAt: number, now: number): Promise<boolean> {
		await this.db.prepare(`DELETE FROM RequestSignatures WHERE expiresAt < ?1`).bind(now).all();
		try {
			await this.db
				.prepare(`INSERT INTO RequestSignatures (signature, expiresAt) VALUES (?1, ?2)`)
				.bind(signature, expiresAt)
				.all();
			return true;
		} catch (err) {
			if (isUniqueViolation(err)) {
				return false;
			}
			throw err;
		}
	}

	async editUser(address: Address, timestampMS: number, action: ActionEditDomainUser) {
		await this.db
			.prepare(
				`UPDATE DomainUsers SET name = coalesce(?1, name), description = coalesce(?2, description), lastPresence = ?3
				WHERE user = ?4 AND domain = ?5`,
			)
			.bind(action.name ?? null, action.description ?? null, timestampMS, address, action.domain)
			.all();
	}

	/** The account's current key set in the domain and its profile there. */
	async getDomainUser(domain: string, address: Address): Promise<ResponseGetDomainUser> {
		const {results} = await this.db
			.prepare(`${DOMAIN_USERS_SELECT} WHERE d.user = ?1 AND d.domain = ?2`)
			.bind(address, domain)
			.all<DomainUserRow>();
		return {domainUser: results[0] && formatDomainUser(results[0])};
	}

	/** The domain user whose CURRENT key set has this signing key: none for a replaced one. */
	async getDomainUserBySigningKey(signingKey: PublicKey): Promise<ResponseGetDomainUser> {
		const {results} = await this.db
			.prepare(`${DOMAIN_USERS_SELECT} WHERE k.signingKey = ?1`)
			.bind(signingKey)
			.all<DomainUserRow>();
		return {domainUser: results[0] && formatDomainUser(results[0])};
	}

	/** A key set registered in the domain, current or replaced. */
	async getKeySet(domain: string, keyRef: String0x): Promise<ResponseGetKeySet> {
		const {results} = await this.db
			.prepare(`SELECT * FROM KeySets WHERE domain = ?1 AND keyRef = ?2`)
			.bind(domain, keyRef)
			.all<KeySetRow>();
		return {keySet: results[0] && formatKeySet(results[0])};
	}
}

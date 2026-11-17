import {AbstractServerObject, ServerObject, ServerObjectId, Services} from './types.js';
import {RemoteSQLStorage} from './storage/RemoteSQLStorage.js';
import {RateLimiterClient} from './RateLimiter.js';
import {ClientMessageType, ServerMessageType} from '@missiv/common';
import {recoverRequestSigner} from 'delegated-identity';
import {Env} from './env.js';
import {createCurriedJSONRPC} from 'remote-procedure-call';
import {Methods} from 'eip-1193';
import {RemoteSQL} from 'remote-sql';

export type Session = {
	/** what a login signature names: the server's origin and the room's path */
	serverOrigin: string;
	path: string;
	address?: `0x${string}`;
	publicKey?: `0x${string}`;
	id: string;
	challenge: string;
	quit?: boolean;
	blockedMessages?: string[];
	limiter?: RateLimiterClient;
	domain: string;
	authorization: string | undefined;
	authorized: boolean;
};

type HybernatedData = Record<string, unknown> & {
	/** what a login signature names: the server's origin and the room's path */
	serverOrigin: string;
	path: string;
	address?: `0x${string}`;
	publicKey?: `0x${string}`;
	domain: string;
	authorization: string | undefined;
	authorized: boolean;
	challenge: string;
	id: string;
};

export abstract class Room<CustomEnv extends Env> extends AbstractServerObject {
	lastTimestamp: number = 0;
	sessions: Map<WebSocket, Session> = new Map();

	dbStorage!: RemoteSQLStorage; // set in instantiate
	env: CustomEnv;
	identifier:
		| {name: string; domain: string; authorization: string | undefined; serverOrigin: string; path: string}
		| undefined;

	abstract getDB(env: Env): RemoteSQL;
	abstract getRateLimiter(env: Env, idOrName: ServerObjectId | string): ServerObject;

	constructor(env: CustomEnv) {
		super();
		this.env = env;
	}

	// as this is an abstract class, we defer instantiation logic to the subclass
	instantiate() {
		const db = this.getDB(this.env);
		this.dbStorage = new RemoteSQLStorage(db);

		this.getWebSockets().forEach((webSocket) => {
			// The constructor may have been called when waking up from hibernation,
			// so get previously serialized metadata for any existing WebSockets.
			// this apply to system like cloudflare worker that can recover from hibernation
			// other implementation like bun, do nothing here, but it is fine since they do not hibernate
			// TODO implement hibernation for bun ?
			let hibernatedData = this.retrieveSocketData(webSocket) as HybernatedData;

			// Set up our rate limiter client.
			// The client itself can't have been in the attachment, because structured clone doesn't work on functions.
			// DO ids aren't cloneable, restore the ID from its hex string
			let limiter = hibernatedData
				? new RateLimiterClient(
						() => this.getRateLimiter(this.env, hibernatedData.limiterId as string),
						(err: any) => webSocket.close(1011, err.stack),
					)
				: undefined;

			// We don't send any messages to the client until it has sent us the initial user info
			// message. Until then, we will queue messages in `session.blockedMessages`.
			// This could have been arbitrarily large, so we won't put it in the attachment.
			let blockedMessages: string[] = [];
			this.sessions.set(webSocket, {...hibernatedData, limiter, blockedMessages});
		});
	}

	/**
	 * Check a connection request for this room and learn the room from it (its
	 * name, domain, authorization, the server's origin and the path a login
	 * signs): an error response, or undefined when the socket may be upgraded.
	 */
	prepareConnection(request: Request): Response | undefined {
		const name = request.url.split('/').slice(-2)[0];
		if (!this.identifier) {
			if (!name.startsWith('@')) {
				return new Response(`Invalid Room Name: ${name} (needs to start with "@")`, {status: 400});
			}
			const [domain, authorization] = name.slice(1).split('!');
			const url = new URL(request.url);
			// the host the client addressed: an upgrade's URL may be rebuilt on a default
			// host by the platform (node-ws does), its Host header is not
			const host = request.headers.get('host') || url.host;
			this.identifier = {
				name,
				domain,
				authorization: authorization || undefined,
				serverOrigin: this.env.SERVER_ORIGIN || `${url.protocol}//${host}`,
				path: url.pathname,
			};
		} else if (this.identifier.name !== name) {
			return new Response(`Room name mismatch: ${this.identifier.name} !== ${name}`, {status: 400});
		}
		return undefined;
	}

	// Handle HTTP requests from clients.
	async fetch(request: Request): Promise<Response> {
		if (request.url.endsWith('/ws')) {
			const refused = this.prepareConnection(request);
			if (refused) {
				return refused;
			}
			return this.upgradeWebsocket(request);
		}

		return new Response('not found', {status: 404});
	}

	pendingSessionSend(session: Session, ws: WebSocket, message: string | ServerMessageType) {
		if (typeof message !== 'string') {
			message = JSON.stringify(message);
		}
		if (session.authorization && !session.authorized) {
			if (!session.blockedMessages) {
				session.blockedMessages = [];
			}
			session.blockedMessages.push(message);
		} else {
			ws.send(message);
		}
	}

	async webSocketOpen(ws: WebSocket, metadata: {ip?: string}) {
		if (!this.identifier) {
			throw new Error(`Room identifier is not set`);
		}
		const storage = this.getStorage();

		const challenge: string = Array.from(crypto.getRandomValues(new Uint8Array(32)))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
		const id: string = Array.from(crypto.getRandomValues(new Uint8Array(32)))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');

		// Set up our rate limiter client.
		const limiterId = metadata.ip || 'no-ip';
		if (!metadata.ip) {
			console.warn(`no ip`);
		}

		// TODO find another mechanism if ip is not available for some reason ?
		let limiter = limiterId
			? new RateLimiterClient(
					() => this.getRateLimiter(this.env, limiterId),
					(err: any) => ws.close(1011, err.stack),
				)
			: undefined;

		// Create our session and add it to the sessions map.
		let session: Session & {blockedMessages: string[]} = {
			blockedMessages: [],
			limiter,
			challenge,
			id,
			domain: this.identifier.domain,
			authorization: this.identifier.authorization,
			authorized: false,
			serverOrigin: this.identifier.serverOrigin,
			path: this.identifier.path,
		};
		if (limiterId) {
			this.saveSocketData(ws, {
				limiterId,
				domain: session.domain,
				authorization: session.authorization,
				authorized: false,
				challenge: session.challenge,
				id: session.id,
				serverOrigin: session.serverOrigin,
				path: session.path,
			});
		} else {
			this.saveSocketData(ws, {
				domain: session.domain,
				authorization: session.authorization,
				authorized: false,
				challenge: session.challenge,
				id: session.id,
				serverOrigin: session.serverOrigin,
				path: session.path,
			});
		}
		this.sessions.set(ws, session);

		// Queue "join" messages for all online users, to populate the client's roster.
		for (let otherSession of this.sessions.values()) {
			if (otherSession.address && otherSession.publicKey) {
				this.pendingSessionSend(session, ws, {
					joined: otherSession.address,
					publicKey: otherSession.publicKey,
					id: otherSession.id,
				});
			}
		}

		// Load the last 100 messages from the chat history stored on disk, and send them to the
		// client.
		let fromStorage = await storage.list<string>({reverse: true, limit: 100});
		let backlog = [...fromStorage.values()];
		backlog.reverse();
		backlog.forEach((value) => {
			this.pendingSessionSend(session, ws, value);
		});

		// the challenge a login signs (fresh per socket, so a login cannot be replayed)
		this.send(ws, {challenge, id});
	}

	async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
		try {
			const storage = this.getStorage();

			let session = this.sessions.get(ws);
			if (!session) {
				// This should never happen.
				console.error('WebSocket message received for unknown client.');
				this.send(ws, {error: 'WebSocket message received for unknown client.'});
				ws.close(1011, 'WebSocket broken.');
				return;
			}
			if (session.quit) {
				// Whoops, when trying to send to this WebSocket in the past, it threw an exception and
				// we marked it broken. But somehow we got another message? I guess try sending a
				// close(), which might throw, in which case we'll try to send an error, which will also
				// throw, and whatever, at least we won't accept the message. (This probably can't
				// actually happen. This is defensive coding.)
				ws.close(1011, 'WebSocket broken.');
				return;
			}

			// Check if the user is over their rate limit and reject the message if so.
			if (session.limiter && !session.limiter.checkLimit()) {
				this.send(ws, {
					error: 'Your IP is being rate-limited, please try again later.',
					code: 'rate_limited',
				});
				return;
			}

			const data: ClientMessageType = JSON.parse(
				typeof message === 'string' ? message : new TextDecoder().decode(message),
			);

			if ('logout' in data) {
				if (session.address) {
					this.broadcast({quit: session.address, id: session.id});
					this.saveSocketData(ws, {address: undefined, publicKey: undefined});
					delete session.address;
					delete session.publicKey;
				} else {
					console.warn(`no address while logging out`);
					// ignore
					return;
				}
			} else if ('address' in data) {
				await this.login(ws, session, data);
				return;
			}

			if (!session.address) {
				this.send(ws, {error: 'Not Logged In!', code: 'unauthenticated'});
				return;
			}
			if (session.authorization && !session.authorized) {
				// a contract-gated room: only a session the contract admitted may write
				this.send(ws, {error: 'Not authorized in this room', code: 'forbidden'});
				return;
			}

			if (!('message' in data && data.message)) {
				this.send(ws, {error: 'Expected message field', code: 'invalid_request'});
				return;
			}

			// Block people from sending overly long messages. This is also enforced on the client,
			// so to trigger this the user must be bypassing the client code.
			if (data.message.length > 256) {
				this.send(ws, {error: 'Message too long.', code: 'invalid_request'});
				return;
			}

			// Add timestamp. Here's where this.lastTimestamp comes in -- if we receive a bunch of
			// messages at the same time (or if the clock somehow goes backwards????), we'll assign
			// them sequential timestamps, so at least the ordering is maintained.
			const messageReformated: ServerMessageType = {
				timestamp: Math.max(Date.now(), this.lastTimestamp + 1),
				message: data.message,
				from: session.address,
			};
			this.lastTimestamp = messageReformated.timestamp;

			let dataStr = JSON.stringify(messageReformated);
			this.broadcast(dataStr);

			let key = new Date(messageReformated.timestamp).toISOString();
			await storage.put(key, dataStr);
		} catch (err: any) {
			// Report any exceptions directly back to the client. As with our handleErrors() this
			// probably isn't what you'd want to do in production, but it's convenient when testing.
			console.error(err);
			this.send(ws, {error: 'internal error', code: 'internal'});
		}
	}

	/**
	 * A login: the key registered for the address in the room's domain signed the
	 * challenge (delegated-identity's envelope), and, in a contract-gated room, the
	 * contract admits the address. Nothing about the session changes unless both
	 * hold: a refused login leaves it as it was.
	 */
	async login(ws: WebSocket, session: Session, data: {address: `0x${string}`; signature: string}) {
		if (!data.signature) {
			this.send(ws, {error: 'Expected signature', code: 'invalid_request'});
			return;
		}
		const address = data.address.toLowerCase() as `0x${string}`;
		const {domainUser} = await this.dbStorage.getDomainUser(session.domain, address);
		if (!domainUser) {
			this.send(ws, {error: `User not found on domain: ${session.domain}`, code: 'unauthenticated'});
			return;
		}
		const recovered = recoverRequestSigner({
			serverOrigin: session.serverOrigin,
			method: 'GET',
			path: session.path,
			body: session.challenge,
			signature: data.signature,
		});
		if (!recovered.ok || recovered.publicKey !== domainUser.publicKey) {
			this.send(ws, {error: 'Invalid signature', code: 'unauthenticated'});
			return;
		}
		if (session.address === domainUser.user) {
			return;
		}

		let authorized = false;
		if (session.authorization) {
			authorized = await this.isAuthorized(session.authorization, domainUser.user);
			if (!authorized) {
				this.send(ws, {error: 'authorization not passed', code: 'forbidden'});
				return;
			}
		}

		if (session.address) {
			this.broadcast({quit: session.address, id: session.id});
		}
		session.address = domainUser.user;
		session.publicKey = domainUser.publicKey;
		session.authorized = authorized;
		// attached to the socket so it survives hibernation
		this.saveSocketData(ws, {address: session.address, publicKey: session.publicKey, authorized});

		// deliver what was queued while the session could not read
		if (session.blockedMessages) {
			session.blockedMessages.forEach((queued) => ws.send(queued));
			delete session.blockedMessages;
		}
		this.broadcast({joined: session.address, id: session.id, publicKey: session.publicKey});
	}

	/**
	 * Whether the room's contract admits `address`: an `eth_call` of the
	 * authorization's call data, `(address)` replaced by the address, against the
	 * chain configured as `CHAIN_<chainId>`, must return the expected result. Any
	 * failure is a refusal; its detail goes to the log, not to the client.
	 */
	async isAuthorized(authorization: string, address: `0x${string}`): Promise<boolean> {
		const [chainId, contractAddress, callData, expectedResult] = authorization.split(':');
		const chainURL = this.env[`CHAIN_${chainId}`];
		if (!chainURL || !contractAddress || !callData || !expectedResult) {
			console.error(`room authorization: chain ${chainId} not configured or authorization malformed`);
			return false;
		}
		try {
			const rpc = createCurriedJSONRPC<Methods>(chainURL);
			const response = await rpc.call('eth_call')([
				{
					to: contractAddress as `0x${string}`,
					data: callData.replaceAll('(address)', address.slice(2)) as `0x${string}`,
				},
			]);
			if (!response.success) {
				console.error(`room authorization: eth_call failed`, response.error);
				return false;
			}
			return String(response.value).toLowerCase() === expectedResult.toLowerCase();
		} catch (err) {
			console.error(`room authorization: eth_call failed`, err);
			return false;
		}
	}

	send(ws: WebSocket, msg: ServerMessageType) {
		ws.send(JSON.stringify(msg));
	}

	// On "close" and "error" events, remove the WebSocket from the sessions list and broadcast
	// a quit message.
	async closeOrErrorHandler(ws: WebSocket) {
		let session = this.sessions.get(ws);
		if (session) {
			session.quit = true;
			this.sessions.delete(ws);
			if (session.address) {
				this.broadcast({quit: session.address, id: session.id});
			}
		}
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
		this.closeOrErrorHandler(ws);
	}

	async webSocketError(ws: WebSocket, error: unknown) {
		console.error(`websocket error`, error);
		this.closeOrErrorHandler(ws);
	}

	// broadcast() broadcasts a message to all clients.
	broadcast(message: string | ServerMessageType) {
		// Apply JSON if we weren't given a string to start with.
		if (typeof message !== 'string') {
			message = JSON.stringify(message);
		}

		// Iterate over all the sessions sending them messages.
		let quitters: Session[] = [];
		this.sessions.forEach((session, ws) => {
			try {
				this.pendingSessionSend(session, ws, message);
			} catch (err) {
				// Whoops, this connection is dead. Remove it from the map and arrange to notify
				// everyone below.
				session.quit = true;
				quitters.push(session);
				this.sessions.delete(ws);
			}
		});

		quitters.forEach((quitter) => {
			if (quitter.address) {
				this.broadcast({quit: quitter.address, id: quitter.id});
			}
		});
	}
}

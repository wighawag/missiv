import {Bindings} from 'hono/types';
import {AbstractServerObject, Services} from './types.js';
import {RemoteSQLStorage} from './storage/RemoteSQLStorage.js';
import {RateLimiterClient} from './RateLimiter.js';
import {ClientMessageType, ServerMessageType} from 'missiv-common';
import {recoverPublicKey} from './utils/signature.js';

export type Session = {
	address?: string;
	challenge: string;
	quit?: boolean;
	blockedMessages?: string[];
	limiter?: RateLimiterClient;
	domain: string;
};

type HybernatedData = Record<string, unknown> & {domain: string; challenge: string};

export abstract class Room<Env extends Bindings = Bindings> extends AbstractServerObject {
	lastTimestamp: number = 0;
	sessions: Map<WebSocket, Session> = new Map();

	dbStorage: RemoteSQLStorage;
	requireLogin: boolean;
	env: Env;
	identifier: {name: string; domain: string} | undefined;

	static services: Services<any>; // need to be static as cloudflare worker does not let us pass them through any other way

	constructor(env: Env) {
		super();
		this.env = env;
		this.requireLogin = false; // TODO env ?
		const db = Room.services.getDB(env);
		this.dbStorage = new RemoteSQLStorage(db);
	}

	// as this is an abstract class, we defer instantiation logic to the subclass
	instantiate() {
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
						() => Room.services.getRateLimiter(this.env, hibernatedData.limiterId as string),
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

	// Handle HTTP requests from clients.
	async fetch(request: Request): Promise<Response> {
		if (request.url.endsWith('/ws')) {
			const name = request.url.split('/').slice(-2)[0];
			if (!this.identifier) {
				console.log({name});
				let domain: string;
				if (name.startsWith('@')) {
					domain = name.slice(1);
				} else {
					return new Response(`Invalid Room Name: ${name} (needs to start with "@")`, {status: 400});
				}
				this.identifier = {name, domain};
			} else if (this.identifier.name !== name) {
				return new Response(`Room name mismatch: ${this.identifier.name} !== ${name}`, {status: 400});
			}
			return this.upgradeWebsocket(request);
		} else if (request.url.endsWith('/getCurrentConnections')) {
			// TODO cors ?
			// Retrieves all currently connected websockets accepted via `acceptWebSocket()`.
			let numConnections: number = this.getWebSockets().length;
			if (numConnections == 1) {
				return new Response(`There is ${numConnections} WebSocket client connected to this Server Object instance.`);
			}
			return new Response(`There are ${numConnections} WebSocket clients connected to this Server Object instance.`);
		}

		// Unknown path, reply with usage info.
		return new Response(`
  This Server Object supports the following endpoints:
    /websocket
      - Creates a WebSocket connection. Any messages sent to it are echoed with a prefix.
    /getCurrentConnections
      - A regular HTTP GET endpoint that returns the number of currently connected WebSocket clients.
  `);
	}

	pendingSessionSend(session: Session, ws: WebSocket, message: string | ServerMessageType) {
		if (typeof message !== 'string') {
			message = JSON.stringify(message);
		}
		if (this.requireLogin) {
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

		// Set up our rate limiter client.
		const limiterId = metadata.ip || 'no-ip';
		if (!metadata.ip) {
			console.warn(`no ip`);
		}

		// TODO find another mechanism if ip is not available for some reason ?
		let limiter = limiterId
			? new RateLimiterClient(
					() => Room.services.getRateLimiter(this.env, limiterId),
					(err: any) => ws.close(1011, err.stack),
				)
			: undefined;

		// Create our session and add it to the sessions map.
		let session: Session & {blockedMessages: string[]} = {
			blockedMessages: [],
			limiter,
			challenge,
			domain: this.identifier.domain,
		};
		if (limiterId) {
			this.saveSocketData(ws, {limiterId, domain: session.domain, challenge: session.challenge});
		} else {
			this.saveSocketData(ws, {domain: session.domain, challenge: session.challenge});
		}
		this.sessions.set(ws, session);

		// Queue "join" messages for all online users, to populate the client's roster.
		for (let otherSession of this.sessions.values()) {
			if (otherSession.address) {
				this.pendingSessionSend(session, ws, {joined: otherSession.address});
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

		// TODO use this message as replay protection to require signing
		this.send(ws, {challenge});
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
				});
				return;
			}

			const data: ClientMessageType = JSON.parse(
				typeof message === 'string' ? message : new TextDecoder().decode(message),
			);

			if ('logout' in data) {
				if (session.address) {
					this.broadcast({quit: session.address});
					delete session.address;
				} else {
					// ignore
					return;
				}
			} else if ('address' in data) {
				if (!('signature' in data && data.signature)) {
					this.send(ws, {error: 'Expected signature'});
					return;
				}

				let newAddress: string;
				// TODO remove
				const DEBUG = false;
				if (DEBUG && data.signature === '0x') {
					newAddress = data.address;
				} else {
					const user = await this.dbStorage.getCompleteUser(session.domain, data.address);
					if (!user || !user.completeUser) {
						this.send(ws, {error: 'User not found'});
						return;
					}
					const publicKey = user.completeUser.publicKey;
					console.log({signature: data.signature, challenge: session.challenge});
					const recoveredPublicKey = recoverPublicKey(data.signature, session.challenge);
					if (recoveredPublicKey !== publicKey) {
						this.send(ws, {error: 'Invalid signature'});
						return;
					}

					newAddress = user.completeUser.address;
				}

				if (!session.address) {
					session.address = newAddress;
				} else if (session.address === newAddress) {
					// we ignore this request
					return;
				} else {
					this.broadcast({quit: session.address});
					session.address = newAddress;
				}

				// TODO use signature prevent replay ?

				// The first message the client sends is the user info message with their name. Save it
				// into their session object.

				// attach name to the webSocket so it survives hibernation
				this.saveSocketData(ws, {address: session.address});

				// Deliver all the messages we queued up since the user connected.
				if (session.blockedMessages) {
					session.blockedMessages.forEach((queued) => {
						ws.send(queued);
					});
					delete session.blockedMessages;
				}

				// Broadcast to all other connections that this user has joined.
				this.broadcast({joined: session.address});

				this.send(ws, {ready: true});
				return;
			}

			if (!session.address) {
				this.send(ws, {error: 'Not Logged In!'});
				return;
			}

			if (!('message' in data && data.message)) {
				this.send(ws, {error: 'Expected message field'});
				return;
			}

			// Block people from sending overly long messages. This is also enforced on the client,
			// so to trigger this the user must be bypassing the client code.
			if (data.message.length > 256) {
				this.send(ws, {error: 'Message too long.'});
				return;
			}

			// Add timestamp. Here's where this.lastTimestamp comes in -- if we receive a bunch of
			// messages at the same time (or if the clock somehow goes backwards????), we'll assign
			// them sequential timestamps, so at least the ordering is maintained.
			const messageReformated: ServerMessageType = {
				timestamp: Math.max(Date.now(), this.lastTimestamp + 1),
				message: data.message,
				from: session.address,
				signature: data.signature,
			};
			this.lastTimestamp = messageReformated.timestamp;

			let dataStr = JSON.stringify(messageReformated);
			this.broadcast(dataStr);

			let key = new Date(messageReformated.timestamp).toISOString();
			await storage.put(key, dataStr);
		} catch (err: any) {
			// Report any exceptions directly back to the client. As with our handleErrors() this
			// probably isn't what you'd want to do in production, but it's convenient when testing.
			this.send(ws, {error: 'failed to establish connection', cause: err.message || err, stack: err.stack});
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
				this.broadcast({quit: session.address});
			}
		}
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
		console.log(`closing...`, code, reason, wasClean);
		this.closeOrErrorHandler(ws);
	}

	// TODO
	// async webSocketError(ws: WebSocket, error: any) {
	// 	this.closeOrErrorHandler(ws);
	// }

	// broadcast() broadcasts a message to all clients.
	broadcast(message: string | ServerMessageType) {
		// Apply JSON if we weren't given a string to start with.
		if (typeof message !== 'string') {
			message = JSON.stringify(message);
		}

		// Iterate over all the sessions sending them messages.
		let quitters: Session[] = [];
		this.sessions.forEach((session, ws) => {
			if (session.address) {
				try {
					ws.send(message);
				} catch (err) {
					// Whoops, this connection is dead. Remove it from the map and arrange to notify
					// everyone below.
					session.quit = true;
					quitters.push(session);
					this.sessions.delete(ws);
				}
			} else {
				this.pendingSessionSend(session, ws, message);
			}
		});

		quitters.forEach((quitter) => {
			if (quitter.address) {
				this.broadcast({quit: quitter.address});
			}
		});
	}
}

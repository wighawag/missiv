import { handleErrors } from '../utils';
import { Env } from '../env';

import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex as toHex } from '@noble/hashes/utils';
import { Signature } from '@noble/secp256k1';
import { getUserAddressByPublicKey } from '../api';
import { Address } from 'missiv';

type JoinMessage = { type: 'join'; address: Address; signature: string };
type ContentMessage = { type: 'message'; content: string };
export type Message = JoinMessage | ContentMessage;

export type Session = { address?: string; publicKey?: string; webSocket: WebSocket; blockedMessages: string[]; quit?: boolean };

function pubToAddress(pub: string): string {
	return toHex(keccak_256(pub).slice(-40));
}

// =======================================================================================
// The ChatRoom Durable Object Class

// ChatRoom implements a Durable Object that coordinates an individual chat room. Participants
// connect to the room using WebSockets, and the room broadcasts messages from each participant
// to all others.
export class ChatRoom {
	private storage: DurableObjectStorage;
	private env: Env;
	private sessions: Session[];
	private lastTimestamp: number;

	constructor(controller: DurableObjectState, env: Env) {
		// `controller.storage` provides access to our durable storage. It provides a simple KV
		// get()/put() interface.
		this.storage = controller.storage;

		// `env` is our environment bindings (discussed earlier).
		this.env = env;

		// We will put the WebSocket objects for each client, along with some metadata, into
		// `sessions`.
		this.sessions = [];

		// We keep track of the last-seen message's timestamp just so that we can assign monotonically
		// increasing timestamps even if multiple messages arrive simultaneously (see below). There's
		// no need to store this to disk since we assume if the object is destroyed and recreated, much
		// more than a millisecond will have gone by.
		this.lastTimestamp = 0;
	}

	// The system will call fetch() whenever an HTTP request is sent to this Object. Such requests
	// can only be sent from other Worker code, such as the code above; these requests don't come
	// directly from the internet. In the future, we will support other formats than HTTP for these
	// communications, but we started with HTTP for its familiarity.
	async fetch(request: Request) {
		return await handleErrors(request, async () => {
			let url = new URL(request.url);

			switch (url.pathname) {
				case '/websocket': {
					// The request is to `/api/room/<name>/websocket`. A client is trying to establish a new
					// WebSocket session.
					if (request.headers.get('Upgrade') != 'websocket') {
						return new Response('expected websocket', { status: 400 });
					}

					// Get the client's IP address for use with the rate limiter.
					let ip = request.headers.get('CF-Connecting-IP') as string;

					// To accept the WebSocket request, we create a WebSocketPair (which is like a socketpair,
					// i.e. two WebSockets that talk to each other), we return one end of the pair in the
					// response, and we operate on the other end. Note that this API is not part of the
					// Fetch API standard; unfortunately, the Fetch API / Service Workers specs do not define
					// any way to act as a WebSocket server today.
					let pair = new WebSocketPair();

					// We're going to take pair[1] as our end, and return pair[0] to the client.
					await this.handleSession(pair[1], ip);

					// Now we return the other end of the pair to the client.
					return new Response(null, { status: 101, webSocket: pair[0] });
				}

				default:
					return new Response('Not found', { status: 404 });
			}
		});
	}

	// handleSession() implements our WebSocket-based chat protocol.
	async handleSession(webSocket: WebSocket, ip: string) {
		// Accept our end of the WebSocket. This tells the runtime that we'll be terminating the
		// WebSocket in JavaScript, not sending it elsewhere.
		webSocket.accept();

		// Set up our rate limiter client.
		let limiterId = this.env.LIMITERS.idFromName(ip);
		let limiter = new RateLimiterClient(
			() => this.env.LIMITERS.get(limiterId),
			(err) => webSocket.close(1011, err.stack),
		);

		// Create our session and add it to the sessions list.
		// We don't send any messages to the client until it has sent us the initial user info
		// message. Until then, we will queue messages in `session.blockedMessages`.
		let session: Session = { webSocket, blockedMessages: [] };
		this.sessions.push(session);

		// Queue "join" messages for all online users, to populate the client's roster.
		this.sessions.forEach((otherSession) => {
			if (otherSession.address) {
				session.blockedMessages.push(JSON.stringify({ joined: otherSession.address }));
			}
		});

		// Load the last 100 messages from the chat history stored on disk, and send them to the
		// client.
		let storage = await this.storage.list<string>({ reverse: true, limit: 100 });
		let backlog = [...storage.values()];
		backlog.reverse();
		backlog.forEach((value) => {
			session.blockedMessages.push(value);
		});

		// Set event handlers to receive messages.
		let receivedUserInfo = false;
		webSocket.addEventListener('message', async (msg) => {
			try {
				if (session.quit) {
					// Whoops, when trying to send to this WebSocket in the past, it threw an exception and
					// we marked it broken. But somehow we got another message? I guess try sending a
					// close(), which might throw, in which case we'll try to send an error, which will also
					// throw, and whatever, at least we won't accept the message. (This probably can't
					// actually happen. This is defensive coding.)
					webSocket.close(1011, 'WebSocket broken.');
					return;
				}

				// Check if the user is over their rate limit and reject the message if so.
				if (!limiter.checkLimit()) {
					webSocket.send(
						JSON.stringify({
							error: 'Your IP is being rate-limited, please try again later.',
						}),
					);
					return;
				}

				const rawMessage = msg.data.toString();
				const [signatureString, dataString] = rawMessage.split(/\.(.*)/s);
				if (!dataString) {
					webSocket.send(
						JSON.stringify({
							error: 'Invalid Message, no Data',
						}),
					);
					return;
				}

				if (!receivedUserInfo) {
					const message: Message = JSON.parse(dataString);
					if (message.type !== 'join') {
						webSocket.send(
							JSON.stringify({
								error: 'Invalid Message, expect type join',
							}),
						);
						return;
					}

					console.log({ dataString, signatureString });
					const splitted = signatureString.split(':');
					const recoveryBit = Number(splitted[1]);
					const signature = Signature.fromCompact(splitted[0]).addRecoveryBit(recoveryBit);
					const msgHash = keccak_256(dataString);
					const publicKey = signature.recoverPublicKey(msgHash).toHex() as `0x${string}`;

					if (!publicKey) {
						webSocket.send(
							JSON.stringify({
								error: 'Invalid Message, cannot recover',
							}),
						);
						return;
					}

					const { domainUser: user } = await getUserAddressByPublicKey(this.env, publicKey);

					if (!user) {
						webSocket.send(
							JSON.stringify({
								error: `No User found with publicKey: ${publicKey}`,
							}),
						);
						return;
					}

					if (user.address.toLowerCase() !== message.address.toLowerCase()) {
						webSocket.send(
							JSON.stringify({
								error: 'Invalid Message, addresses mismatch',
							}),
						);
						return;
					}

					session.address = user.address;
					session.publicKey = publicKey;

					// Deliver all the messages we queued up since the user connected.
					session.blockedMessages.forEach((queued) => {
						webSocket.send(queued);
					});
					session.blockedMessages = [];

					// Broadcast to all other connections that this user has joined.
					// this.broadcast({joined: session.address});
					this.broadcast({ joined: user.address, publicKey, rawMessage }); // client need to check for themselves

					// we tell the client it is ready to send message
					webSocket.send(JSON.stringify({ ready: true }));

					// Note that we've now received the user info message.
					receivedUserInfo = true;

					return;
				}

				const splitted = signatureString.split(':');
				const recoveryBit = Number(splitted[1]);
				const signature = Signature.fromCompact(splitted[0]).addRecoveryBit(recoveryBit);
				const msgHash = keccak_256(dataString);
				const publicKey = signature.recoverPublicKey(msgHash).toHex();

				if (!publicKey) {
					webSocket.send(
						JSON.stringify({
							error: 'Invalid Message, cannot recover',
						}),
					);
					return;
				}

				if (session.publicKey != publicKey) {
					webSocket.send(
						JSON.stringify({
							error: `Invalid Message, different public key (session: ${session.publicKey} vs ${publicKey})`,
						}),
					);
					return;
				}

				if (!session.address) {
					webSocket.send(
						JSON.stringify({
							error: 'Invalid Message, session has no associated address',
						}),
					);
					return;
				}

				if (!session.publicKey) {
					webSocket.send(
						JSON.stringify({
							error: 'Invalid Message, session has no associated public key',
						}),
					);
					return;
				}

				const message: ContentMessage = JSON.parse(dataString);

				// Add timestamp. Here's where this.lastTimestamp comes in -- if we receive a bunch of
				// messages at the same time (or if the clock somehow goes backwards????), we'll assign
				// them sequential timestamps, so at least the ordering is maintained.
				const timestamp = Math.max(Date.now(), this.lastTimestamp + 1);
				this.lastTimestamp = timestamp;

				// TODO check timestamp
				// if (!data.timestamp) {
				// 	webSocket.send(JSON.stringify({error: "No timestamp specified"}));
				//   return;
				// }

				// if (data.timestamp > timestamp) {
				// 	webSocket.send(JSON.stringify({error: "Future timestamp"}));
				//   return;
				// }
				// if (timestamp - data.timestamp)
				// TODO

				// // Construct sanitized message for storage and broadcast.
				// data = { name: session.name, message: "" + data.message, timestamp };

				// Block people from sending overly long messages. This is also enforced on the client,
				// so to trigger this the user must be bypassing the client code.
				if (message.content.length > 256) {
					webSocket.send(JSON.stringify({ error: 'Message too long.' }));
					return;
				}

				const webSocketMessage = { rawMessage, address: session.address };

				// Broadcast the message to all other WebSockets.
				// let dataStr = JSON.stringify(data);
				this.broadcast(webSocketMessage);

				// Save message.
				let key = new Date(timestamp).toISOString();
				await this.storage.put(key, JSON.stringify(webSocketMessage));
			} catch (err: any) {
				// Report any exceptions directly back to the client. As with our handleErrors() this
				// probably isn't what you'd want to do in production, but it's convenient when testing.
				webSocket.send(JSON.stringify({ error: err.stack }));
			}
		});

		// On "close" and "error" events, remove the WebSocket from the sessions list and broadcast
		// a quit message.
		let closeOrErrorHandler = (evt: CloseEvent | ErrorEvent) => {
			session.quit = true;
			this.sessions = this.sessions.filter((member) => member !== session);
			if (session.address) {
				this.broadcast({ quit: session.address });
			}
		};
		webSocket.addEventListener('close', closeOrErrorHandler);
		webSocket.addEventListener('error', closeOrErrorHandler);
	}

	// broadcast() broadcasts a message to all clients.
	broadcast(message: any) {
		// Apply JSON if we weren't given a string to start with.
		if (typeof message !== 'string') {
			message = JSON.stringify(message);
		}

		// Iterate over all the sessions sending them messages.
		let quitters: Session[] = [];
		this.sessions = this.sessions.filter((session) => {
			if (session.address) {
				try {
					session.webSocket.send(message);
					return true;
				} catch (err) {
					// Whoops, this connection is dead. Remove it from the list and arrange to notify
					// everyone below.
					session.quit = true;
					quitters.push(session);
					return false;
				}
			} else {
				// This session hasn't sent the initial user info message yet, so we're not sending them
				// messages yet (no secret lurking!). Queue the message to be sent later.
				session.blockedMessages.push(message);
				return true;
			}
		});

		quitters.forEach((quitter) => {
			if (quitter.address) {
				this.broadcast({ quit: quitter.address });
			}
		});
	}
}

// =======================================================================================
// The RateLimiter Durable Object class.

// RateLimiter implements a Durable Object that tracks the frequency of messages from a particular
// source and decides when messages should be dropped because the source is sending too many
// messages.
//
// We utilize this in ChatRoom, above, to apply a per-IP-address rate limit. These limits are
// global, i.e. they apply across all chat rooms, so if a user spams one chat room, they will find
// themselves rate limited in all other chat rooms simultaneously.
export class RateLimiter {
	private nextAllowedTime: number;

	constructor(controller: DurableObjectState, env: Env) {
		// Timestamp at which this IP will next be allowed to send a message. Start in the distant
		// past, i.e. the IP can send a message now.
		this.nextAllowedTime = 0;
	}

	// Our protocol is: POST when the IP performs an action, or GET to simply read the current limit.
	// Either way, the result is the number of seconds to wait before allowing the IP to perform its
	// next action.
	async fetch(request: Request) {
		return await handleErrors(request, async () => {
			let now = Date.now() / 1000;

			this.nextAllowedTime = Math.max(now, this.nextAllowedTime);

			if (request.method == 'POST') {
				// POST request means the user performed an action.
				// We allow one action per 5 seconds.
				this.nextAllowedTime += 5;
			}

			// Return the number of seconds that the client needs to wait.
			//
			// We provide a "grace" period of 20 seconds, meaning that the client can make 4-5 requests
			// in a quick burst before they start being limited.
			let cooldown = Math.max(0, this.nextAllowedTime - now - 20); // toString or JSON.stringify ?
			return new Response(cooldown as any);
		});
	}
}

// RateLimiterClient implements rate limiting logic on the caller's side.
class RateLimiterClient {
	private getLimiterStub: () => DurableObjectStub;
	private reportError: (err: any) => void;
	private limiter: DurableObjectStub;
	private inCooldown: boolean;
	// The constructor takes two functions:
	// * getLimiterStub() returns a new Durable Object stub for the RateLimiter object that manages
	//   the limit. This may be called multiple times as needed to reconnect, if the connection is
	//   lost.
	// * reportError(err) is called when something goes wrong and the rate limiter is broken. It
	//   should probably disconnect the client, so that they can reconnect and start over.
	constructor(getLimiterStub: () => DurableObjectStub, reportError: (err: any) => void) {
		this.getLimiterStub = getLimiterStub;
		this.reportError = reportError;

		// Call the callback to get the initial stub.
		this.limiter = getLimiterStub();

		// When `inCooldown` is true, the rate limit is currently applied and checkLimit() will return
		// false.
		this.inCooldown = false;
	}

	// Call checkLimit() when a message is received to decide if it should be blocked due to the
	// rate limit. Returns `true` if the message should be accepted, `false` to reject.
	checkLimit() {
		if (this.inCooldown) {
			return false;
		}
		this.inCooldown = true;
		this.callLimiter();
		return true;
	}

	// callLimiter() is an internal method which talks to the rate limiter.
	async callLimiter() {
		try {
			let response;
			try {
				// Currently, fetch() needs a valid URL even though it's not actually going to the
				// internet. We may loosen this in the future to accept an arbitrary string. But for now,
				// we have to provide a dummy URL that will be ignored at the other end anyway.
				response = await this.limiter.fetch('https://dummy-url', { method: 'POST' });
			} catch (err) {
				// `fetch()` threw an exception. This is probably because the limiter has been
				// disconnected. Stubs implement E-order semantics, meaning that calls to the same stub
				// are delivered to the remote object in order, until the stub becomes disconnected, after
				// which point all further calls fail. This guarantee makes a lot of complex interaction
				// patterns easier, but it means we must be prepared for the occasional disconnect, as
				// networks are inherently unreliable.
				//
				// Anyway, get a new limiter and try again. If it fails again, something else is probably
				// wrong.
				this.limiter = this.getLimiterStub();
				response = await this.limiter.fetch('https://dummy-url', { method: 'POST' });
			}

			// The response indicates how long we want to pause before accepting more requests.
			let cooldown = +(await response.text());
			await new Promise((resolve) => setTimeout(resolve, cooldown * 1000));

			// Done waiting.
			this.inCooldown = false;
		} catch (err) {
			this.reportError(err);
		}
	}
}

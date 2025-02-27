import {AbstractServerObject} from './types.js';

export type Session = {
	address?: string;
	quit?: boolean;
	blockedMessages?: string[];
};

export abstract class Room extends AbstractServerObject {
	lastTimestamp: number = 0;
	sessions: Map<WebSocket, Session> = new Map();

	instantiate() {
		this.getWebSockets().forEach((webSocket) => {
			// The constructor may have been called when waking up from hibernation,
			// so get previously serialized metadata for any existing WebSockets.
			// this apply to system like service worker that can recover
			// other implementation like bun, do nothing here, but it is fine sicne they do not hibernate
			// TODO implement hibernation for bun ?
			let meta = this.retrieveSocketData(webSocket);

			// We don't send any messages to the client until it has sent us the initial user info
			// message. Until then, we will queue messages in `session.blockedMessages`.
			// This could have been arbitrarily large, so we won't put it in the attachment.
			let blockedMessages: string[] = [];
			this.sessions.set(webSocket, {...meta, blockedMessages});
		});
	}

	// Handle HTTP requests from clients.
	async fetch(request: Request): Promise<Response> {
		if (request.url.endsWith('/ws')) {
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

	async webSocketOpen(ws: WebSocket, metadata: {ip?: string}) {
		const storage = this.getStorage();

		// Create our session and add it to the sessions map.
		let session: Session & {blockedMessages: string[]} = {blockedMessages: []};
		this.sessions.set(ws, session);

		// Queue "join" messages for all online users, to populate the client's roster.
		for (let otherSession of this.sessions.values()) {
			if (otherSession.address) {
				session.blockedMessages.push(JSON.stringify({joined: otherSession.address}));
			}
		}

		// Load the last 100 messages from the chat history stored on disk, and send them to the
		// client.
		let fromStorage = await storage.list<string>({reverse: true, limit: 100});
		let backlog = [...fromStorage.values()];
		backlog.reverse();
		backlog.forEach((value) => {
			session.blockedMessages.push(value);
		});

		// TODO use this message as replay protection to require signing
		ws.send(JSON.stringify({type: 'welcome'}));
	}

	async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
		try {
			const storage = this.getStorage();

			let session = this.sessions.get(ws);
			if (!session) {
				// This should never happen.
				console.error('WebSocket message received for unknown client.');
				ws.send(JSON.stringify({error: 'WebSocket message received for unknown client.'}));
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

			const data: {address: string} | {message: string} = JSON.parse(
				typeof message === 'string' ? message : new TextDecoder().decode(message),
			);

			if (!session.address) {
				// TODO check signature (address
				if (!('address' in data && data.address)) {
					ws.send(JSON.stringify({error: 'Expected address'}));
					return;
				}
				// TODO use signature prevent replay ?

				// The first message the client sends is the user info message with their name. Save it
				// into their session object.
				session.address = data.address;
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

				ws.send(JSON.stringify({ready: true}));
				return;
			}

			if (!('message' in data && data.message)) {
				ws.send(JSON.stringify({error: 'Expected message field'}));
				return;
			}

			// Block people from sending overly long messages. This is also enforced on the client,
			// so to trigger this the user must be bypassing the client code.
			if (data.message.length > 256) {
				ws.send(JSON.stringify({error: 'Message too long.'}));
				return;
			}

			// Add timestamp. Here's where this.lastTimestamp comes in -- if we receive a bunch of
			// messages at the same time (or if the clock somehow goes backwards????), we'll assign
			// them sequential timestamps, so at least the ordering is maintained.
			const messageReformated = {
				timestamp: Math.max(Date.now(), this.lastTimestamp + 1),
				message: data.message,
			};
			this.lastTimestamp = messageReformated.timestamp;

			let dataStr = JSON.stringify(messageReformated);
			this.broadcast(dataStr);

			let key = new Date(messageReformated.timestamp).toISOString();
			await storage.put(key, dataStr);
		} catch (err: any) {
			// Report any exceptions directly back to the client. As with our handleErrors() this
			// probably isn't what you'd want to do in production, but it's convenient when testing.
			ws.send(JSON.stringify({error: 'failed to establish connection', cause: err.message || err, stack: err.stack}));
		}
	}

	// On "close" and "error" events, remove the WebSocket from the sessions list and broadcast
	// a quit message.
	async closeOrErrorHandler(ws: WebSocket) {
		let session = this.sessions.get(ws) || {};
		session.quit = true;
		this.sessions.delete(ws);
		if (session.address) {
			this.broadcast({quit: session.address});
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
	broadcast(message: string | Record<string, unknown>) {
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
				const blockedMessages = (session.blockedMessages = session.blockedMessages || []);
				// This session hasn't sent the initial user info message yet, so we're not sending them
				// messages yet (no secret lurking!). Queue the message to be sent later.
				blockedMessages.push(message);
			}
		});

		quitters.forEach((quitter) => {
			if (quitter.address) {
				this.broadcast({quit: quitter.address});
			}
		});
	}
}

// The seam between the scenarios and a version of missiv's API. A scenario
// speaks only this interface; each API version is one adapter (`v0-5.ts` for
// missiv 0.5), so a new API is a new adapter, not a new harness. What a call
// costs on the client (signing, and in later APIs encrypting) is part of what
// the harness measures, since a real client pays it too.

/** A simulated user: whatever the adapter needs to act as it (keys, a session). */
export type LoadUser = {readonly address: `0x${string}`};

/** A conversation of two users, as the adapter names it. */
export type LoadConversation = {readonly id: string; readonly members: readonly [LoadUser, LoadUser]};

/** A socket in a room, logged in as its user. */
export interface RoomConnection {
	/** send a room message (its text is the caller's) */
	send(text: string): void;
	/** every room message this socket receives (text as sent, the time it arrived) */
	onMessage(listener: (text: string, receivedAt: number) => void): void;
	/** every error the room answers this socket with (its code, e.g. `rate_limited`) */
	onError(listener: (code: string) => void): void;
	close(): Promise<void>;
}

export type Target = {
	/** the server's HTTP origin, e.g. `http://127.0.0.1:2000` */
	url: string;
};

export interface Adapter {
	/** the API version, as `--api` names it */
	readonly name: string;
	/** the public room the room scenarios join */
	readonly room: string;
	/** a new user with fresh keys, not yet registered */
	createUser(): Promise<LoadUser>;
	register(user: LoadUser): Promise<void>;
	/** start the conversation of two registered users (its first message), accepted by both */
	openConversation(a: LoadUser, b: LoadUser): Promise<LoadConversation>;
	/** send one direct message of `content` from a member */
	send(from: LoadUser, conversation: LoadConversation, content: string): Promise<void>;
	/**
	 * Read a conversation as an open conversation view does: in 0.5 the newest
	 * page (the 2 s poll); an API with a cursor fetches only what is new since this
	 * user's last read. Returns how many messages came back.
	 */
	read(user: LoadUser, conversation: LoadConversation): Promise<number>;
	/** fetch the user's conversation list as the list view does; returns its length */
	listConversations(user: LoadUser): Promise<number>;
	/** open a socket to a room, log in as the user, resolve once logged in */
	joinRoom(user: LoadUser, room: string, options?: {localAddress?: string}): Promise<RoomConnection>;
}

export type AdapterFactory = (target: Target) => Adapter;

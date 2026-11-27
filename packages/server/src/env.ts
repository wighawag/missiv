export type Env = {
	/** the bearer token of /api/admin; the admin routes refuse every request when it is unset */
	ADMIN_TOKEN?: string;
	/**
	 * the HMAC-SHA256 key of session tokens (a long random secret); every route that
	 * authenticates its caller is refused while it is unset
	 */
	SESSION_SECRET?: string;
	/**
	 * the previous SESSION_SECRET during a rotation: tokens signed with it are
	 * accepted until they expire (an hour), new ones are signed with SESSION_SECRET
	 */
	SESSION_SECRET_PREVIOUS?: string;
	/** `true` to return an internal error's cause and stack to the caller (never in production) */
	EXPOSE_ERRORS?: string;
	/**
	 * the server's own origin as clients address it (`https://missiv.example`), which
	 * every request signature names; defaults to the origin of the request's URL, so
	 * set it behind a proxy that rewrites the host or the scheme
	 */
	SERVER_ORIGIN?: string;
	/** push-notification-server's URL: a new direct message is pushed to its recipients when set */
	PUSH_SERVER_URL?: string;
	/** the token push-notification-server issued for each domain: `<domain>=<token>,...` (secrets) */
	PUSH_TOKENS?: string;
	/**
	 * `true` to send no Web Push to a recipient who has the live channel open
	 * (`/api/inbox/ws`) in the message's domain, where the message is pushed on
	 * the socket already; unset, every recipient is pushed, online or not
	 */
	PUSH_SKIP_WHEN_ONLINE?: string;
	/** the JSON-RPC endpoint of a chain, for contract-gated rooms */
	[chainId: `CHAIN_${string}`]: string | undefined;
};

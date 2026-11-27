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
	 * the token bucket of each account's sends (per domain): how many messages at
	 * once (default 20) and how many a second it refills (default 1). Beyond it a
	 * send is refused `rate_limited` with the wait (`retryAfterMs`, `Retry-After`)
	 */
	RATE_LIMIT_SEND_BURST?: string;
	RATE_LIMIT_SEND_REFILL_PER_SECOND?: string;
	/**
	 * the token bucket of each client IP on `/session` and `register` together
	 * (default 30 at once, 0.5 a second); not applied where the platform does not
	 * know the IP
	 */
	RATE_LIMIT_IP_BURST?: string;
	RATE_LIMIT_IP_REFILL_PER_SECOND?: string;
	/**
	 * `true` to send no Web Push to a recipient who has the live channel open
	 * (`/api/inbox/ws`) in the message's domain, where the message is pushed on
	 * the socket already; unset, every recipient is pushed, online or not
	 */
	PUSH_SKIP_WHEN_ONLINE?: string;
	/** the JSON-RPC endpoint of a chain, for contract-gated rooms */
	[chainId: `CHAIN_${string}`]: string | undefined;
};

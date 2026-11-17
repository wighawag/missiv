export type Env = {
	/** the bearer token of /api/admin; the admin routes refuse every request when it is unset */
	ADMIN_TOKEN?: string;
	/** `true` to return an internal error's cause and stack to the caller (never in production) */
	EXPOSE_ERRORS?: string;
	/**
	 * the server's own origin as clients address it (`https://missiv.example`), which
	 * every request signature names; defaults to the origin of the request's URL, so
	 * set it behind a proxy that rewrites the host or the scheme
	 */
	SERVER_ORIGIN?: string;
	/** the JSON-RPC endpoint of a chain, for contract-gated rooms */
	[chainId: `CHAIN_${string}`]: string | undefined;
};

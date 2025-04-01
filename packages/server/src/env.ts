export type Env = {
	DEV?: string;
	[chainId: `CHAIN_${string}`]: string | undefined;
};

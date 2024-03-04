export type User = {
	delegatePrivateKey: `0x${string}`;
	address: `0x${string}`;
};

export type APIConfig = {
	endpoint: string;
	namespace: string;
	pollingInterval?: number;
};

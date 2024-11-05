export type User = {
	delegatePrivateKey: string;
	address: `0x${string}`;
};

export type APIConfig = {
	endpoint: string;
	domain: string;
	namespace: string;
	pollingInterval?: number;
};

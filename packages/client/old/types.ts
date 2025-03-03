import type { Address } from 'missiv-common';

export type User = {
	delegatePrivateKey: string;
	address: Address;
};

export type APIConfig = {
	endpoint: string;
	domain: string;
	namespace: string;
	pollingInterval?: number;
};

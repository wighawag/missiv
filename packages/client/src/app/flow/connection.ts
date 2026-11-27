import { createConnection } from '@etherplay/connect';

// The demo signs in through the etherplay wallet host; connect asks for a chain, which the
// demo never transacts on (missiv needs only the account and its key set).
export const connection = createConnection({
	walletHost: 'https://accounts.etherplay.io',
	chainInfo: {
		id: 1,
		name: 'Ethereum',
		rpcUrls: { default: { http: ['https://ethereum-rpc.publicnode.com'] } },
		nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' }
	}
});

import { createConnection } from '@etherplay/connect';

export const connection = createConnection({
	walletHost: 'https://accounts.etherplay.io'
});

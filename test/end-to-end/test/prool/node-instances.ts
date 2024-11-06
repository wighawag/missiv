import {ANVIL_URL, FUZD_URL} from './pool';
import {createCommand} from 'prool-any';

export const fuzd = createCommand(FUZD_URL, {
	command: 'pnpm missiv-server-bun',
	readyMessage: 'Server is running on',
});

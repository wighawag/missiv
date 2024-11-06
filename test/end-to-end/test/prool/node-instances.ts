import {MISSIV_URL} from './pool';
import {createCommand} from 'prool-any';

export const fuzd = createCommand(MISSIV_URL, {
	command: 'pnpm missiv-server-bun',
	readyMessage: 'Server is running on',
	redirectToFile: './log.txt'
});

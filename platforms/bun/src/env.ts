import {Env} from 'missiv-server';

export type BunEnv = Env & {
	DB: string;
	// NAMED_LOGS?: string;
	// NAMED_LOGS_LEVEL?: string;
};

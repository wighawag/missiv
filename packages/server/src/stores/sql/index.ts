import type {RemoteSQL} from 'remote-sql';
import type {Stores} from '../ports.js';
import {SQLKeyDirectory} from './KeyDirectory.js';
import {SQLConversationStore, SQLInbox} from './messaging.js';

export {SQLKeyDirectory, SQLConversationStore, SQLInbox};

/**
 * The three ports over one SQL database (ADR-0005's Node.js and Bun
 * implementation; Cloudflare uses its KeyDirectory on D1): a send is one transaction.
 */
export function createSQLStores(db: RemoteSQL): Stores {
	return {
		keys: new SQLKeyDirectory(db),
		conversations: new SQLConversationStore(db),
		inbox: new SQLInbox(db),
	};
}

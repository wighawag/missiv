import {membersOfConversationID, type Address} from '@missiv/common';
import {MissivError} from '../errors.js';

/**
 * The other member of a 1:1 conversation `account` is in. 1:1 only (ADR-0006):
 * a conversationID of another form (a group's) is refused `invalid_request`
 * until a group scheme exists, and one `account` is not a member of `forbidden`.
 * The members are the conversationID itself, so this reads nothing.
 */
export function otherMemberOf(conversationID: string, account: Address): Address {
	const members = membersOfConversationID(conversationID);
	if (!members) {
		throw new MissivError('invalid_request', 'a conversation is between two accounts (conversationIDOf of the two)');
	}
	if (!members.includes(account)) {
		throw new MissivError('forbidden', 'the account is not a member of this conversation');
	}
	return members[0] === account ? members[1] : members[0];
}

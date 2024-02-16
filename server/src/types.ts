import { object, string, literal, Output, special, variant, number, toLowerCase, BaseTransformation, BaseValidation, Pipe } from 'valibot';
export { parse } from 'valibot';

const string0x = (...args: (BaseValidation<`0x${string}`> | BaseTransformation<`0x${string}`>)[]) =>
	special<`0x${string}`>((val) => (typeof val === 'string' ? val.startsWith('0x') : false), 'do not start with 0x', [
		toLowerCase() as BaseTransformation<`0x${string}`>,
		...args,
	]);

export const SchemaAddress = string0x();
export type Address = Output<typeof SchemaAddress>;

export const SchemaActionSendMessage = object({
	type: literal('sendMessage'),
	to: string0x(),
	message: string(),
});

export type ActionSendMessage = Output<typeof SchemaActionSendMessage>;

export const SchemaAction = variant('type', [
	SchemaActionSendMessage,
	object({
		type: literal('getConversations'),
	}),
	object({
		type: literal('markAsRead'),
		lastMessageTimestampMS: number(),
	}),
	object({
		type: literal('getMessages'),
		with: string0x(),
	}),
	object({
		type: literal('kv:list'),
	}),
	object({
		type: literal('kv:delete'),
	}),
]);

export type Action = Output<typeof SchemaAction>;

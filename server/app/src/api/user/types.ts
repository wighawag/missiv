import {z} from 'zod';
import {DomainUser, MissivUser, string0x} from '../types';

export const SchemaActionRegisterDomainUser = z.object({
	domain: z.string(),
	signature: string0x(),
	address: string0x(),
	name: z.string().optional(),
	domainUsername: z.string().optional(),
});
export type ActionRegisterDomainUser = z.infer<typeof SchemaActionRegisterDomainUser>;
export type ResponseRegisterDomainUser = {timestampMS: number};

export const SchemaActionGetMissivUser = z.object({
	address: string0x(),
});
export type ActionGetMissivUser = z.infer<typeof SchemaActionGetMissivUser>;
export type ResponseGetMissivUser = {user: MissivUser | undefined};

// export const SchemaActionGetDomainUser = object({
// 	type: literal('getDomainUser'),
// 	domain: string(),
// 	address: string0x(),
// });
// export type ActionGetDomainUser = z.infer<typeof SchemaActionGetDomainUser>;
export type ResponseGetDomainUser = {domainUser: DomainUser | undefined};

export const SchemaActionGetCompleteUser = z.object({
	domain: z.string(),
	address: string0x(),
});
export type ActionGetCompleteUser = z.infer<typeof SchemaActionGetCompleteUser>;
export type ResponseGetCompleteUser = {completeUser: (DomainUser & MissivUser) | undefined};

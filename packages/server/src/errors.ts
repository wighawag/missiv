import {ERROR_STATUS, type ErrorCode, type ErrorResponse} from 'missiv-common';
import {zValidator} from '@hono/zod-validator';
import type {ZodSchema} from 'zod';

/** An error the API answers with its code's status and `{error: {code, message}}`. */
export class MissivError extends Error {
	readonly status: (typeof ERROR_STATUS)[ErrorCode];
	constructor(
		readonly code: ErrorCode,
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = 'MissivError';
		this.status = ERROR_STATUS[code];
	}

	toResponseBody(): ErrorResponse {
		return {error: {code: this.code, message: this.message, ...(this.details ? {details: this.details} : {})}};
	}
}

/** The JSON body validated by a missiv-common schema; an invalid body is a 400 `invalid_request`. */
export function validateJSON<S extends ZodSchema>(schema: S) {
	return zValidator('json', schema, (result) => {
		if (!result.success) {
			throw new MissivError('invalid_request', 'the request body does not match its schema', result.error.issues);
		}
	});
}

/** Whether a SQL error is a UNIQUE (or primary key) constraint violation, on any of the platforms' drivers. */
export function isUniqueViolation(err: unknown): boolean {
	const message = String((err as any)?.message ?? err) + String((err as any)?.cause?.message ?? '');
	return /UNIQUE constraint failed/i.test(message);
}

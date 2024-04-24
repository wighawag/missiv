export type SQLStatement = {sql: string; args: any[]} | string;

export type SQLResult<T = any> = {rows: T[]};

export interface SQLPreparedStatement {
	bind(...values: any[]): SQLPreparedStatement;
	all<T = any>(): Promise<SQLResult<T>>;
}

export type ValidSQLExecution = SQLStatement;

export interface RemoteSQL {
	prepare(sql: string): SQLPreparedStatement;
	// execute(sql: ValidSQLExecution): Promise<SQLResult>;
	batch<T = any>(list: SQLPreparedStatement[]): Promise<SQLResult<T>[]>;
}

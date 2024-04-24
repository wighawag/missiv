import { RemoteSQL, SQLPreparedStatement, SQLResult, SQLStatement } from 'missiv-server-app';
import type { Client } from '@libsql/client';

export class LibSQLPreparedStatement implements SQLPreparedStatement {
	public readonly args: any[];
	constructor(
		private client: Client,
		public readonly sql: string,
		args?: any[],
	) {
		this.args = [];
	}
	bind(...values: any[]): SQLPreparedStatement {
		return new LibSQLPreparedStatement(this.client, this.sql, this.args.concat(values));
	}
	all<T = any>(): Promise<SQLResult<T>> {
		if (this.args.length > 0) {
			return this.client.execute({ sql: this.sql, args: this.args }) as unknown as Promise<SQLResult<T>>;
		} else {
			return this.client.execute(this.sql) as unknown as Promise<SQLResult<T>>;
		}
	}
}

export class RemoteLibSQL implements RemoteSQL {
	constructor(private client: Client) {}
	prepare(sql: string): SQLPreparedStatement {
		return new LibSQLPreparedStatement(this.client, sql);
	}
	async batch<T = any>(list: SQLPreparedStatement[]): Promise<SQLResult<T>[]> {
		return this.client.batch(
			list.map((v) => {
				const p = v as LibSQLPreparedStatement;
				return p.args.length > 0 ? { sql: p.sql, args: p.args } : p.sql;
			}),
		) as unknown as Promise<SQLResult<T>[]>;
	}
}

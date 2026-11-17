import {RemoteSQL, SQLPreparedStatement, SQLResult, SQLStatement} from 'remote-sql';
import {Database, Statement} from 'bun:sqlite';

export class BunSQLPreparedStatement implements SQLPreparedStatement {
	public readonly args: any[];
	public readonly query: Statement;
	constructor(
		private client: Database,
		public readonly sql: string,
		args: any[] = [],
	) {
		this.args = args;
		// console.log({sql});
		this.query = client.query(sql);
	}
	bind(...values: any[]): SQLPreparedStatement {
		return new BunSQLPreparedStatement(this.client, this.sql, this.args.concat(values));
	}
	async all<T = any>(): Promise<SQLResult<T>> {
		let resultSet: any[];
		if (this.args.length > 0) {
			resultSet = this.query.all(...this.args);
		} else {
			resultSet = this.query.all();
		}
		return {
			results: resultSet, // TODO check
		} as SQLResult<T>;
	}
}

export class RemoteBunSQL implements RemoteSQL {
	constructor(private client: Database) {}
	prepare(sql: string): SQLPreparedStatement {
		return new BunSQLPreparedStatement(this.client, sql);
	}
	/**
	 * All statements in one transaction. bun:sqlite's transactions are synchronous,
	 * so the statements run synchronously inside it (an async callback would let
	 * the transaction commit at its first await, before the rest had run).
	 */
	async batch<T = any>(list: SQLPreparedStatement[]): Promise<SQLResult<T>[]> {
		const transact = this.client.transaction((statements: BunSQLPreparedStatement[]) =>
			statements.map((statement) => statement.query.all(...statement.args)),
		);
		const response = transact(list as BunSQLPreparedStatement[]);
		return response.map((res: any) => ({results: res})) as SQLResult<T>[];
	}
}

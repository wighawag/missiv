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
	async batch<T = any>(list: SQLPreparedStatement[]): Promise<SQLResult<T>[]> {
		const transact = this.client.transaction(async (list: SQLPreparedStatement[]) => {
			const result: any[] = [];
			for (const statement of list) {
				result.push(await statement.all());
			}
			return result;
		});
		const response = await transact(list);
		// console.log({response});
		return response.map((res: any) => ({results: res})) as SQLResult<T>[];
	}
}

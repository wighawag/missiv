import { RemoteSQL, SQLPreparedStatement, SQLResult } from 'missiv-server-app';

export class D1SQLPreparedStatement implements SQLPreparedStatement {
	constructor(public statement: D1PreparedStatement) {}
	bind(...values: any[]): SQLPreparedStatement {
		return new D1SQLPreparedStatement(this.statement.bind(...values));
	}
	async all<T = any>(): Promise<SQLResult<T>> {
		const response = await this.statement.all();
		return {
			rows: response.results,
		} as SQLResult<T>;
	}
}

export class RemoteD1 implements RemoteSQL {
	constructor(private d1: D1Database) {}
	prepare(sql: string): SQLPreparedStatement {
		return new D1SQLPreparedStatement(this.d1.prepare(sql));
	}
	// async execute(sql: SQLStatement): Promise<SQLResult> {
	// 	if (typeof sql === 'string') {
	// 		return this.d1.exec(sql);
	// 	} else {
	// 		let prepareStatement = this.d1.prepare(sql.sql);
	// 		if (sql.args) {
	// 			prepareStatement = prepareStatement.bind(...sql.args);
	// 		}
	// 		return prepareStatement.run();
	// 	}
	// }
	async batch<T = any>(list: SQLPreparedStatement[]): Promise<SQLResult<T>[]> {
		const response = await this.d1.batch(
			list.map((v) => {
				const p = v as D1SQLPreparedStatement;
				return p.statement;
			}),
		);
		return response.map((res) => ({ rows: res.results })) as SQLResult<T>[];
	}
}

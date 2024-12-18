const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const folder = args[0];
const files = fs.readdirSync(folder);
for (const file of files) {
	const SQLFilePath = path.join(folder, file);
	const TSFilePath = `./src/schema/ts/${file}.ts`;
	const sqlText = fs.readFileSync(SQLFilePath);
	fs.mkdirSync('./src/schema/ts', {recursive: true});
	fs.writeFileSync(TSFilePath, `export default \`${sqlText}\``);
}

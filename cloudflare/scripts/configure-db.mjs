import {readFile, writeFile} from 'node:fs/promises';
const id = process.argv[2];
if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id || '') || /^0+(?:-0+)*$/.test(id)) {
  console.error('Usage: npm run configure-db -- YOUR-DATABASE-ID (copy the UUID from d1 create)');
  process.exit(1);
}
const path = new URL('../wrangler.jsonc', import.meta.url);
const config = JSON.parse(await readFile(path, 'utf8'));
config.d1_databases[0].database_id = id;
await writeFile(path, JSON.stringify(config, null, 2) + '\n');
console.log('D1 binding saved. Next: npm run cf -- secret put ADMIN_PASSWORD');

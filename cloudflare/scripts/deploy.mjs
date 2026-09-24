import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
if (config.d1_databases[0].database_id === '00000000-0000-0000-0000-000000000000') {
  console.error('Create the D1 database and run npm run configure-db -- YOUR-DATABASE-ID first. See CLOUD_SETUP.md.');
  process.exit(1);
}
const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
function run(args, capture = false) {
  const result = spawnSync(process.execPath, [cli, ...args], {stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8'});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
  return result.stdout;
}
// Refuse to expose a dashboard without its secret. Secret values are never read.
const secrets = JSON.parse(run(['secret', 'list'], true));
if (!secrets.some(s => s.name === 'ADMIN_PASSWORD')) {
  console.error('Set your password first: npm run cf -- secret put ADMIN_PASSWORD');
  process.exit(1);
}
run(['deploy', '--dry-run']);
run(['d1', 'migrations', 'apply', 'simonsealsapi-db', '--remote']);
run(['deploy']);
console.log('Open https://simonsealsapi.dev and sign in, then pair one device to verify live sync.');

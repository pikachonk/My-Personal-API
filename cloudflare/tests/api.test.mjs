import {test, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';

const origin = 'https://simonsealsapi.dev';
const password = 'test-password-only-not-for-deployment';
let mf, db, cookie;
async function call(path, {method = 'GET', data, headers = {}, signed = true} = {}) {
  const response = await mf.dispatchFetch(origin + path, {method, redirect: 'manual',
    headers: {...(signed && cookie ? {Cookie: cookie} : {}), ...(data !== undefined ? {'Content-Type': 'application/json'} : {}), ...headers},
    ...(data !== undefined ? {body: JSON.stringify(data)} : {})});
  const body = response.headers.get('Content-Type')?.includes('application/json') ? await response.json() : await response.text();
  return {status: response.status, headers: response.headers, body};
}
async function pair(name = 'PC', platform = 'windows') {
  const r = await call('/api/devices', {method: 'POST', data: {name, platform}});
  assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body;
}
function event(id = 'one', changes = {}) {
  return {event_id: id, app: 'chrome.exe', started_at: '2026-09-20T10:00:00Z', ended_at: '2026-09-20T11:00:00Z', ...changes};
}
function upload(device, events, changes = {}) {
  return call('/api/sync', {method: 'POST', signed: false, headers: {Authorization: 'Bearer ' + device.token},
    data: {device_id: device.device_id, events, ...changes}});
}
before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({name: 'simonsealsapi', modules: true, scriptPath: 'src/worker.js', compatibilityDate: '2026-09-23',
    bindings: {PUBLIC_ORIGIN: origin, ADMIN_PASSWORD: password}, d1Databases: ['DB'],
    assets: {directory: '../static', binding: 'ASSETS', run_worker_first: true,
      routerConfig: {has_user_worker: true}, assetConfig: {html_handling: 'none'}}}));
  db = await mf.getD1Database('DB');
  // execute() accepts a complete migration, including trigger BEGIN/END blocks.
  for (const migration of ['0001_initial.sql', '0002_work_rules.sql']) {
    const sql = await readFile(`migrations/${migration}`, 'utf8');
    await db.prepare(sql).run();
  }
});
after(async () => { await mf?.dispose(); });
beforeEach(async () => {
  await db.batch(['entries', 'sync_receipts', 'devices', 'sessions', 'login_limit', 'work_rules'].map(t => db.prepare(`DELETE FROM ${t}`)));
  cookie = null;
  const r = await call('/api/login', {method: 'POST', signed: false, data: {password}});
  assert.equal(r.status, 200, JSON.stringify(r.body)); cookie = r.headers.get('Set-Cookie').split(';')[0];
});
test('dashboard, assets and API are protected; login cookie and logout', async () => {
  assert.equal((await call('/', {signed: false})).status, 302);
  assert.equal((await call('/index.html', {signed: false})).status, 302);
  assert.equal((await call('/api/export', {signed: false})).status, 401);
  assert.equal((await call('/login', {signed: false})).status, 200);
  assert.equal((await call('/magic.css', {signed: false})).status, 200);
  const page = await call('/'); assert.equal(page.status, 200); assert.match(page.body, /SimonSealsAPI/);
  assert.equal(page.headers.get('Cache-Control'), 'no-store');
  assert.equal((await call('/api/docs')).status, 200);
  const login = await call('/api/login', {method: 'POST', data: {password}});
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(login.headers.get('Set-Cookie').includes(flag));
  assert.equal((await call('/api/logout', {method: 'POST', data: {}})).status, 200);
  assert.equal((await call('/api/health')).status, 401);
});
test('sessions expire, tampered cookies and cross-origin requests are rejected', async () => {
  assert.equal((await call('/api/health', {headers: {Cookie: cookie + 'x'}})).status, 401);
  assert.equal((await call('/api/devices', {method: 'POST', data: {name: 'bad', platform: 'windows'}, headers: {Origin: 'https://evil.test'}})).status, 403);
  assert.equal((await call('/api/login', {method: 'POST', data: {password}, headers: {Origin: 'null'}})).status, 403);
  await db.prepare('UPDATE sessions SET expires_at=0').run();
  assert.equal((await call('/api/health')).status, 401);
});
test('login throttles across requests using persistent D1 state', async () => {
  await db.prepare('DELETE FROM login_limit').run();
  for (let i = 0; i < 15; i++) assert.equal((await call('/api/login', {method: 'POST', data: {password: 'bad'}})).status, 401);
  assert.equal((await call('/api/login', {method: 'POST', data: {password}})).status, 429);
  await db.prepare('UPDATE login_limit SET window=0').run();
  assert.equal((await call('/api/login', {method: 'POST', data: {password}})).status, 200);
});
test('five devices pair, tokens cannot read data, revocation and heartbeat', async () => {
  const devices = [];
  for (let i = 0; i < 5; i++) devices.push(await pair('Device ' + i, i < 3 ? 'windows' : 'android'));
  const d = devices[0]; assert.equal(d.server_url, origin); assert.equal(d.certificate_sha256, '');
  assert.equal((await call('/api/export', {signed: false, headers: {Authorization: 'Bearer ' + d.token}})).status, 401);
  assert.equal((await upload(d, [], {device_id: devices[1].device_id})).status, 400);
  assert.equal((await upload(d, [])).status, 200);
  const listing = (await call('/api/devices')).body;
  assert.equal(listing.devices.length, 5); assert.ok(listing.devices[0].last_seen);
  assert.ok(!JSON.stringify(listing).includes(d.token)); assert.ok(!JSON.stringify(listing).includes('token_hash'));
  assert.equal((await call('/api/devices/' + d.device_id, {method: 'DELETE'})).status, 200);
  assert.equal((await upload(d, [])).status, 401);
});
test('retries and deleted entries do not duplicate; changed IDs roll back the batch', async () => {
  const d = await pair();
  const first = await upload(d, [event()]); assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(first.body.inserted, 1);
  assert.equal((await upload(d, [event()])).body.inserted, 0);
  const conflict = await upload(d, [event('new'), event('one', {app: 'other.exe'})]);
  assert.equal(conflict.status, 400, JSON.stringify(conflict.body));
  let exported = (await call('/api/export')).body;
  assert.equal(exported.entries.length, 1);
  await call('/api/entries/' + exported.entries[0].id, {method: 'DELETE'});
  assert.equal((await upload(d, [event()])).body.inserted, 0);
  exported = (await call('/api/export')).body; assert.equal(exported.entries.length, 0);
  assert.equal((await upload(d, [event('same'), event('same')])).body.inserted, 1);
  assert.equal((await upload(d, [event('x'), event('x', {app: 'changed'})])).status, 400);
});
test('200-event batch, concurrent retries and invalid batch atomicity', async () => {
  const d = await pair(); const events = Array.from({length: 200}, (_, i) => event(String(i)));
  const results = await Promise.all([upload(d, events), upload(d, events)]);
  assert.deepEqual(results.map(r => r.status), [200, 200]);
  assert.equal(results.reduce((n, r) => n + r.body.inserted, 0), 200);
  assert.equal((await upload(d, [...events, event('too many')])).status, 400);
  assert.equal((await upload(d, [event('new'), event('invalid', {ended_at: 'nonsense'})])).status, 400);
  assert.equal((await call('/api/export')).body.entries.length, 200);
});
test('overlap, timezones, midnight boundaries and DST-length days', async () => {
  const a = await pair('Windows'), b = await pair('Pixel', 'android');
  await upload(a, [event()]);
  await upload(b, [event('one', {started_at: '2026-09-20T06:30:00-04:00', ended_at: '2026-09-20T07:30:00-04:00'})]);
  const day = (await call('/api/day?date=2026-09-20')).body;
  assert.equal(day.totals.screen_minutes, 120); assert.equal(day.totals.screen_unique_minutes, 90);
  assert.deepEqual(new Set(day.entries.map(e => e.device_name)), new Set(['Windows', 'Pixel']));
  const sleep = await call('/api/entries', {method: 'POST', data: {kind: 'sleep', started_at: '2026-03-07T23:00:00-05:00', ended_at: '2026-03-08T08:00:00-04:00'}});
  assert.equal(sleep.status, 201);
  const dst = await call('/api/day?date=2026-03-08&start=2026-03-08T05:00:00Z&end=2026-03-09T04:00:00Z');
  assert.equal(dst.body.totals.sleep_minutes, 420);
  assert.equal((await call('/api/day?date=2026-02-30')).status, 400);
});
test('approved apps and sites become work without double-counting browsers, devices, or manual time', async () => {
  const pc = await pair('PC'), phone = await pair('Phone', 'android');
  await upload(pc, [event('code', {app: 'code.exe'}),
    event('browser', {started_at: '2026-09-20T11:00:00Z', ended_at: '2026-09-20T12:00:00Z'}),
    event('site', {type: 'website', app: 'example.com', started_at: '2026-09-20T11:15:00Z', ended_at: '2026-09-20T11:45:00Z'})]);
  await upload(phone, [event('phone', {app: 'code.exe', started_at: '2026-09-20T10:30:00Z', ended_at: '2026-09-20T11:30:00Z'})]);
  const dayPath = '/api/day?date=2026-09-20';
  assert.equal((await call(dayPath)).body.totals.work_minutes, 0);
  assert.equal((await call('/api/work-rules', {signed: false})).status, 401);
  assert.equal((await call('/api/work-rules', {method:'PUT', data:{type:'app', label:'chrome.exe', classification:'work'}})).status, 400);
  for (const [type, label] of [['app', 'CODE.EXE'], ['website', 'example.com']])
    assert.equal((await call('/api/work-rules', {method:'PUT', data:{type, label, classification:'work'}})).status, 200);
  assert.equal((await call('/api/work-rules')).body.rules.length, 2);
  let totals = (await call(dayPath)).body.totals;
  assert.equal(totals.work_auto_minutes, 105);
  assert.equal(totals.work_minutes, 105);
  assert.equal(totals.screen_minutes, 180);
  await call('/api/entries', {method:'POST', data:{kind:'work', started_at:'2026-09-20T11:30:00Z', ended_at:'2026-09-20T12:00:00Z'}});
  totals = (await call(dayPath)).body.totals;
  assert.equal(totals.work_manual_minutes, 30);
  assert.equal(totals.work_minutes, 120);
  await call('/api/work-rules', {method:'PUT', data:{type:'app', label:'code.exe', classification:'unclassified'}});
  assert.equal((await call(dayPath)).body.totals.work_minutes, 45);
});
test('manual activities and timestamp validation preserve fractional seconds', async () => {
  const water = await call('/api/entries', {method: 'POST', data: {kind: 'water', value: 250, started_at: '2026-09-20T10:00:00.123456Z'}});
  assert.equal(water.status, 201); assert.equal(water.body.started_at, '2026-09-20T10:00:00.123456Z');
  assert.equal((await call('/api/day?date=2026-09-20')).body.totals.water_ml, 250);
  for (const data of [[], {kind: 'water', value: true}, {kind: 'work', started_at: '2026-09-20T10:00:00'},
    {kind: 'gym', started_at: '2026-02-30T00:00:00Z', ended_at: '2026-03-01T01:00:00Z'}]) {
    assert.equal((await call('/api/entries', {method: 'POST', data})).status, 400);
  }
  const d = await pair();
  assert.equal((await upload(d, [event('future', {started_at: '2099-01-01T10:00:00Z', ended_at: '2099-01-01T11:00:00Z'})])).status, 400);
});
test('export pagination covers all entries without disclosing credentials', async () => {
  const d = await pair();
  for (let b = 0; b < 3; b++) assert.equal((await upload(d, Array.from({length: 200}, (_, i) => event(`${b}-${i}`)))).status, 200);
  const first = (await call('/api/export')).body; assert.equal(first.entries.length, 500); assert.ok(first.next_cursor);
  const second = (await call('/api/export?cursor=' + first.next_cursor)).body;
  assert.equal(second.entries.length, 100); assert.equal(second.next_cursor, null);
  assert.equal(new Set([...first.entries, ...second.entries].map(e => e.id)).size, 600);
  assert.ok(!JSON.stringify(first).includes(d.token)); assert.ok(!JSON.stringify(first).includes('token_hash'));
  assert.equal((await call('/api/export?cursor=invalid')).status, 400);
});
test('oversized and malformed requests rejected without writes', async () => {
  const large = await call('/api/entries', {method: 'POST', data: {notes: 'x'.repeat(17000)}});
  assert.equal(large.status, 413);
  const malformed = await mf.dispatchFetch(origin + '/api/entries', {method: 'POST', headers: {Cookie: cookie, 'Content-Type': 'application/json'}, body: '{'});
  assert.equal(malformed.status, 400);
  assert.equal((await call('/api/export')).body.entries.length, 0);
});

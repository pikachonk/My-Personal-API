// Cloudflare adapter for the existing dashboard and Windows/Android wire protocol.
const encoder = new TextEncoder();
const kinds = new Set(['water', 'work', 'gym', 'sleep', 'screen', 'custom']);
const deviceColumns = 'id,name,platform,created_at,last_seen,revoked';
const columns = ['id', 'kind', 'label', 'started_at', 'ended_at', 'value', 'unit', 'notes', 'source', 'created_at', 'device_id', 'external_id'];
const cookieName = 'daybook_session';
const securityHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000',
};
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function fail(message, status = 400) { throw new HttpError(status, message); }
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {status, headers: {...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', ...headers}});
}
function object(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('Send a JSON object.');
  return data;
}
function text(data, key, fallback = '', limit = 200) {
  const value = data[key] === undefined ? fallback : data[key];
  if (typeof value !== 'string' || value.length > limit) fail(`${key} must be text, at most ${limit} characters.`);
  return value.trim();
}
function timestamp(value) {
  // Strict calendar validation: Date.parse alone silently normalizes February 30.
  if (typeof value !== 'string') fail('Use an ISO 8601 timestamp with a timezone.');
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) fail('Use an ISO 8601 timestamp with a timezone.');
  const [, y, mo, d, h, mi, s, , zone] = m;
  const days = new Date(Date.UTC(Number(y), Number(mo), 0)).getUTCDate();
  if (+y < 1000 || +mo < 1 || +mo > 12 || +d < 1 || +d > days || +h > 23 || +mi > 59 || +s > 59 ||
      (zone !== 'Z' && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59))) fail('Invalid timestamp.');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) fail('Invalid timestamp.');
  // Preserve microseconds sent by Python collectors while normalizing timezone.
  return new Date(ms).toISOString().replace(/\d{3}Z$/, (m[7] || '').padEnd(6, '0') + 'Z');
}
function nowISO() { return new Date().toISOString().replace('Z', '000Z'); }
function entry(data) {
  object(data);
  const kind = data.kind;
  if (!kinds.has(kind)) fail('kind must be water, work, gym, sleep, screen, or custom.');
  const start = timestamp(data.started_at), end = data.ended_at ? timestamp(data.ended_at) : null;
  if (end && (end <= start || Date.parse(end) - Date.parse(start) > 7 * 86400000)) fail('The end must follow the start, by at most seven days.');
  const value = data.value ?? null;
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1000000)) fail('value must be positive and no greater than 1,000,000.');
  if (kind === 'water' && (value === null || value > 10000 || end)) fail('Water requires 0–10,000 ml and a single timestamp.');
  if (['work', 'gym', 'sleep', 'screen'].includes(kind) && !end) fail('This activity requires an end time.');
  return {id: crypto.randomUUID(), kind, label: text(data, 'label', '', 253) || kind[0].toUpperCase() + kind.slice(1),
    started_at: start, ended_at: end, value, unit: kind === 'water' ? 'ml' : text(data, 'unit', '', 30),
    notes: text(data, 'notes', '', 2000), source: text(data, 'source', 'manual', 80) || 'manual',
    created_at: nowISO(), device_id: null, external_id: null};
}
async function readBody(request, limit = 16384) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') fail('Send Content-Type: application/json.', 415);
  if (Number(request.headers.get('Content-Length')) > limit) fail('Request body is too large.', 413);
  const reader = request.body?.getReader();
  if (!reader) fail('Send a JSON object.');
  const chunks = []; let size = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); fail('Request body is too large.', 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return object(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes))); }
  catch (error) { if (error instanceof HttpError) throw error; fail('Send valid JSON.'); }
}
function hex(bytes) { return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join(''); }
async function hash(value) { return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value))); }
function randomToken() { return hex(crypto.getRandomValues(new Uint8Array(32))); }
function extensionCors(origin) {
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin || '')
    ? {'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin'}
    : {};
}
function extensionOrigin(request) { return extensionCors(request.headers.get('Origin'))['Access-Control-Allow-Origin'] || ''; }
async function signingKey(password) {
  return crypto.subtle.importKey('raw', encoder.encode(password), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign', 'verify']);
}
async function mac(value, password) { return hex(await crypto.subtle.sign('HMAC', await signingKey(password), encoder.encode(value))); }
async function verifyMac(value, signature, password) {
  if (!/^[a-f0-9]{64}$/.test(signature || '')) return false;
  return crypto.subtle.verify('HMAC', await signingKey(password), Uint8Array.from(signature.match(/../g), x => parseInt(x, 16)), encoder.encode(value));
}
function sessionCookie(request) {
  return request.headers.get('Cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(cookieName + '='))?.slice(cookieName.length + 1) || '';
}
async function authorized(request, env) {
  const [token, signature, extra] = sessionCookie(request).split('.');
  if (extra !== undefined || !/^[a-f0-9]{64}$/.test(token || '') || !await verifyMac(token, signature, env.ADMIN_PASSWORD)) return false;
  return !!await env.DB.prepare('SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?').bind(await hash(token), Date.now()).first();
}
async function login(request, env) {
  const data = await readBody(request), window = Math.floor(Date.now() / 300000);
  // One atomic shared counter, not an isolate-local counter that resets on cold starts.
  const counter = await env.DB.prepare(`INSERT INTO login_limit(id,window,attempts) VALUES(1,?,1)
    ON CONFLICT(id) DO UPDATE SET window=excluded.window,
      attempts=CASE WHEN login_limit.window=excluded.window THEN login_limit.attempts+1 ELSE 1 END
    RETURNING attempts`).bind(window).first();
  if (counter.attempts > 15) return json({error: 'Too many attempts. Try again in five minutes.'}, 429, {'Retry-After': '300'});
  const challenge = randomToken();
  if (typeof data.password !== 'string' || !data.password ||
      !await verifyMac(challenge, await mac(challenge, env.ADMIN_PASSWORD), data.password)) fail('Incorrect password.', 401);
  const token = randomToken(), signature = await mac(token, env.ADMIN_PASSWORD);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(Date.now()),
    env.DB.prepare('INSERT INTO sessions(token_hash,expires_at) VALUES(?,?)').bind(await hash(token), Date.now() + 43200000),
  ]);
  return json({signed_in: true}, 200, {'Set-Cookie': `${cookieName}=${token}.${signature}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`});
}
async function devices(env) {
  return (await env.DB.prepare(`SELECT ${deviceColumns} FROM devices ORDER BY created_at`).all()).results;
}
async function pair(request, env) {
  const data = await readBody(request), name = text(data, 'name', '', 80);
  if (!name) fail('Give the device a name.');
  if (!['windows', 'android', 'chromeos'].includes(data.platform)) fail('Choose Windows, Android, or ChromeOS.');
  const id = crypto.randomUUID(), token = randomToken();
  await env.DB.prepare('INSERT INTO devices(id,name,platform,token_hash,created_at) VALUES(?,?,?,?,?)')
    .bind(id, name, data.platform, await hash(token), nowISO()).run();
  return json({device_id: id, device_name: name, platform: data.platform, token,
    server_url: env.PUBLIC_ORIGIN, certificate_sha256: ''}, 201);
}
async function sync(request, env, ctx) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ') || auth.length > 207) fail('Device key invalid or revoked. Pair the device again.', 401);
  const device = await env.DB.prepare('SELECT id,platform FROM devices WHERE token_hash=? AND revoked=0').bind(await hash(auth.slice(7))).first();
  if (!device) fail('Device key invalid or revoked. Pair the device again.', 401);
  const data = await readBody(request, 262144);
  if (data.device_id !== device.id) fail('The device ID must match the paired device.');
  if (!Array.isArray(data.events) || data.events.length > 200) fail('Send an events array with at most 200 sessions.');
  const unique = new Map();
  for (const event of data.events) {
    object(event);
    if (typeof event.event_id !== 'string' || !event.event_id.length || event.event_id.length > 160) fail('Each session requires a stable event_id, up to 160 characters.');
    const type = event.type === undefined ? 'app' : event.type;
    if (!['app', 'website'].includes(type)) fail('Session type must be app or website.');
    if (type === 'website' && device.platform !== 'windows') fail('Website sessions require a Windows pairing.');
    const label = type === 'website' ? text(event, 'app', '', 253) : text(event, 'app', '', 200);
    if (type === 'website' && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(label))
      fail('Website sessions must contain only a lowercase domain name.');
    const source = type === 'website' ? 'windows-browser' : device.platform + '-collector';
    const item = entry({kind: 'screen', label, started_at: event.started_at,
      ended_at: event.ended_at, source});
    if (Date.parse(item.ended_at) > Date.now() + 300000) fail('Screen time cannot be in the future. Check the device clock.');
    item.device_id = device.id; item.external_id = event.event_id;
    // Store the compact canonical content directly; equality needs no per-event crypto calls.
    // Keep the existing app digest unchanged so retries queued before deployment remain valid.
    const digest = type === 'app' ? JSON.stringify([item.label, item.started_at, item.ended_at])
      : JSON.stringify([type, item.label, item.started_at, item.ended_at]);
    if (unique.has(event.event_id) && unique.get(event.event_id).digest !== digest) fail('An event_id was reused for a different session.');
    unique.set(event.event_id, {...item, digest});
  }
  const payload = JSON.stringify([...unique.values()]);
  // Three statements regardless of batch size: stay below D1 Free's 50-query limit.
  // D1 batch is transactional. Conflict/revocation triggers roll back every statement.
  const result = await env.DB.batch([
    env.DB.prepare('UPDATE devices SET last_seen=? WHERE id=?').bind(nowISO(), device.id),
    env.DB.prepare(`INSERT INTO entries(${columns.join(',')})
      SELECT ${columns.map(c => `json_extract(j.value,'$.${c}')`).join(',')}
      FROM json_each(?) AS j
      WHERE NOT EXISTS (SELECT 1 FROM sync_receipts r WHERE r.device_id=? AND r.event_id=json_extract(j.value,'$.external_id'))`)
      .bind(payload, device.id),
    env.DB.prepare(`INSERT INTO sync_receipts(device_id,event_id,digest)
      SELECT ?,json_extract(value,'$.external_id'),json_extract(value,'$.digest') FROM json_each(?) WHERE 1
      ON CONFLICT(device_id,event_id) DO UPDATE SET digest=excluded.digest WHERE sync_receipts.digest!=excluded.digest`)
      .bind(device.id, payload),
  ]);
  const domains = [...unique.values()].filter(item => item.source === 'windows-browser').map(item => item.label);
  if (domains.length && ctx?.waitUntil) ctx.waitUntil(classifyDomains(env, domains).catch(() => {}));
  return json({accepted: data.events.length, inserted: result[1].meta.changes, server_time: nowISO()}, 200, extensionCors(request.headers.get('Origin')));
}
function dayBounds(query) {
  const day = query.get('date') || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail('Invalid date.');
  const midnight = Date.parse(timestamp(day + 'T00:00:00Z'));
  const offset = query.get('offset') || '0';
  if (!/^-?\d+$/.test(offset) || Math.abs(Number(offset)) > 840) fail('Invalid UTC offset.');
  let start = midnight - Number(offset) * 60000, end = start + 86400000;
  if (query.has('start') || query.has('end')) {
    start = Date.parse(timestamp(query.get('start'))); end = Date.parse(timestamp(query.get('end')));
    if (!(end > start && end - start <= 26 * 3600000)) fail('The requested day must span at most 26 hours.');
  }
  return {day, start, end};
}
function iso(ms) { return new Date(ms).toISOString().replace('Z', '000Z'); }
const browserApps = new Set(['chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'com.android.chrome', 'com.microsoft.emmx', 'org.mozilla.firefox']);
const aiModel = '@cf/meta/llama-3.1-8b-instruct-fp8';
const aiDailyCap = 100;
function workRule(data) {
  const type = text(data, 'type', '', 16);
  const label = text(data, 'label', '', type === 'website' ? 253 : 200).toLowerCase();
  const classification = text(data, 'classification', '', 16);
  if (!['app', 'website'].includes(type) || !label || !['work', 'personal', 'unclassified'].includes(classification)) fail('Choose an app or website and a classification.');
  if (type === 'website' && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(label)) fail('Enter a valid website domain.');
  if (type === 'app' && browserApps.has(label)) fail('Classify browser website domains instead of the entire browser.');
  return {type, label, classification};
}
function parseAiGuess(response) {
  try {
    const raw = typeof response?.response === 'string' ? response.response : '';
    const match = raw.match(/\{[\s\S]*\}/);
    const answer = JSON.parse(match?.[0] || '');
    if (!['work', 'personal', 'unsure'].includes(answer.classification)) throw new Error('Invalid classification');
    return {classification: answer.classification,
      reason: typeof answer.reason === 'string' ? answer.reason.replace(/\s+/g, ' ').slice(0, 140) : ''};
  } catch { return {classification: 'unsure', reason: 'The AI could not make a reliable guess.'}; }
}
export async function classifyDomain(env, domain) {
  domain = workRule({type: 'website', label: domain, classification: 'work'}).label;
  if (!env.AI || !(await env.DB.prepare('SELECT enabled FROM work_ai_settings WHERE id=1').first())?.enabled) return null;
  const now = nowISO();
  await env.DB.prepare("DELETE FROM work_ai_suggestions WHERE label=? AND classification='pending' AND created_at<?")
    .bind(domain, iso(Date.now() - 600000)).run();
  const claim = await env.DB.prepare(`INSERT INTO work_ai_suggestions(label,classification,reason,created_at)
    SELECT ?,'pending','',? WHERE NOT EXISTS
      (SELECT 1 FROM work_rules WHERE type='website' AND label=?)
    ON CONFLICT(label) DO NOTHING`).bind(domain, now, domain).run();
  if (!claim.meta.changes) return null;
  const day = new Date().toISOString().slice(0, 10);
  const quota = await env.DB.prepare(`INSERT INTO work_ai_quota(day,used) VALUES(?,1)
    ON CONFLICT(day) DO UPDATE SET used=used+1 WHERE used<${aiDailyCap} RETURNING used`).bind(day).first();
  if (!quota) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM work_ai_suggestions WHERE label=? AND classification='pending'").bind(domain),
      env.DB.prepare("UPDATE work_ai_settings SET last_error='Daily AI request cap reached; try again after midnight UTC.' WHERE id=1"),
    ]);
    return null;
  }
  try {
    const result = await env.AI.run(aiModel, {messages: [
      {role: 'system', content: 'Classify a website DOMAIN for a personal work-time tracker. Guess work only for clearly work-specific tools, personal only for clearly leisure-oriented sites. General search, email, chat, social, video, news, and mixed-use sites are unsure. A domain cannot reveal what the person did on a page. Return only JSON: {"classification":"work|personal|unsure","reason":"brief reason"}.'},
      {role: 'user', content: domain},
    ], max_tokens: 80, temperature: 0});
    const guess = parseAiGuess(result);
    await env.DB.batch([
      env.DB.prepare("UPDATE work_ai_suggestions SET classification=?,reason=?,created_at=? WHERE label=? AND classification='pending'")
        .bind(guess.classification, guess.reason, nowISO(), domain),
      env.DB.prepare("UPDATE work_ai_settings SET last_error='' WHERE id=1"),
    ]);
    return guess;
  } catch {
    // A failed model request must never break device sync or turn into a work guess.
    await env.DB.prepare("UPDATE work_ai_settings SET last_error='AI is temporarily unavailable. Try again later.' WHERE id=1").run();
    return null;
  }
}
async function classifyDomains(env, domains) {
  if (!env.AI || !(await env.DB.prepare('SELECT enabled FROM work_ai_settings WHERE id=1').first())?.enabled) return;
  await Promise.allSettled([...new Set(domains)].slice(0, 8).map(domain => classifyDomain(env, domain)));
}
async function recentUnclassifiedDomains(env) {
  await env.DB.prepare("DELETE FROM work_ai_suggestions WHERE classification='pending' AND created_at<?")
    .bind(iso(Date.now() - 600000)).run();
  const rows = (await env.DB.prepare(`SELECT e.label FROM entries e
    LEFT JOIN work_ai_suggestions s ON s.label=e.label
    LEFT JOIN work_rules r ON r.type='website' AND r.label=e.label
    WHERE e.source='windows-browser' AND s.label IS NULL AND r.label IS NULL
    GROUP BY e.label ORDER BY MAX(e.started_at) DESC LIMIT 8`).all()).results;
  return rows.map(row => row.label);
}
async function workAiState(env) {
  const setting = await env.DB.prepare('SELECT enabled,last_error FROM work_ai_settings WHERE id=1').first();
  const suggestions = (await env.DB.prepare("SELECT label,classification,reason FROM work_ai_suggestions WHERE classification!='pending' ORDER BY label LIMIT 1000").all()).results;
  const pending = await env.DB.prepare("SELECT COUNT(*) AS count FROM work_ai_suggestions WHERE classification='pending'").first();
  const quota = await env.DB.prepare('SELECT used FROM work_ai_quota WHERE day=?').bind(new Date().toISOString().slice(0, 10)).first();
  return {available: !!env.AI, enabled: !!setting?.enabled, last_error: setting?.last_error || '',
    suggestions, pending: pending?.count || 0, used_today: quota?.used || 0, daily_cap: aiDailyCap};
}
function unionMs(intervals) {
  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0, previousEnd = -Infinity;
  for (const [s, t] of intervals) { total += Math.max(0, t - Math.max(s, previousEnd)); previousEnd = Math.max(previousEnd, t); }
  return total;
}
function summarize(entries, start, end, rules = []) {
  const totals = {water_ml: 0, work_minutes: 0, work_auto_minutes: 0, work_manual_minutes: 0, gym_minutes: 0, sleep_minutes: 0, screen_minutes: 0, screen_unique_minutes: 0};
  const intervals = [], manualWork = [], autoWork = [], chrome = new Map(), sites = [];
  const byRule = new Map(rules.map(r => [`${r.type}:${r.label}`, r.classification]));
  for (const e of entries) {
    if (e.kind === 'water') totals.water_ml += e.value;
    else if (['work', 'gym', 'sleep', 'screen'].includes(e.kind)) {
      const s = Math.max(Date.parse(e.started_at), start), t = Math.min(Date.parse(e.ended_at), end);
      if (!(t > s)) continue;
      if (e.kind === 'work') manualWork.push([s, t]);
      else if (e.kind !== 'screen' || e.source !== 'windows-browser') totals[e.kind + '_minutes'] += (t - s) / 60000;
      if (e.kind === 'screen' && e.source !== 'windows-browser') {
        intervals.push([s, t]);
        const label = e.label.toLowerCase();
        if (label === 'chrome.exe' || label === 'google chrome') {
          if (!chrome.has(e.device_id)) chrome.set(e.device_id, []);
          chrome.get(e.device_id).push([s, t]);
        } else if (!browserApps.has(label) && byRule.get(`app:${label}`) === 'work') autoWork.push([s, t]);
      } else if (e.kind === 'screen' && e.source === 'windows-browser' && byRule.get(`website:${e.label.toLowerCase()}`) === 'work') sites.push({device: e.device_id, s, t});
    }
  }
  for (const site of sites) for (const [s, t] of chrome.get(site.device) || []) {
    const clippedStart = Math.max(s, site.s), clippedEnd = Math.min(t, site.t);
    if (clippedEnd > clippedStart) autoWork.push([clippedStart, clippedEnd]);
  }
  totals.screen_unique_minutes = unionMs(intervals) / 60000;
  totals.work_auto_minutes = unionMs(autoWork) / 60000;
  totals.work_manual_minutes = unionMs(manualWork) / 60000;
  totals.work_minutes = unionMs([...autoWork, ...manualWork]) / 60000;
  return Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, Math.round(v * 100) / 100]));
}
async function exportPage(url, env) {
  let after = 0, until;
  if (url.searchParams.has('cursor')) {
    const parts = (url.searchParams.get('cursor') || '').split(':');
    if (parts.length !== 2 || parts.some(x => !/^\d+$/.test(x) || !Number.isSafeInteger(Number(x)))) fail('Invalid export cursor.');
    [after, until] = parts.map(Number);
  } else {
    until = (await env.DB.prepare('SELECT COALESCE(MAX(rowid),0) AS last FROM entries').first()).last;
  }
  const rows = (await env.DB.prepare('SELECT rowid AS export_row,* FROM entries WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT 501').bind(after, until).all()).results;
  const hasMore = rows.length > 500, page = rows.slice(0, 500);
  const cursor = hasMore ? `${page.at(-1).export_row}:${until}` : null;
  const rules = (await env.DB.prepare('SELECT type,label,classification FROM work_rules ORDER BY type,label').all()).results;
  return json({version: 2, exported_at: nowISO(), entries: page.map(({export_row, ...e}) => e), devices: await devices(env), work_rules: rules, next_cursor: cursor});
}
async function route(request, env, ctx) {
  if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 16) fail('Set the ADMIN_PASSWORD Worker secret before using the dashboard.', 503);
  const url = new URL(request.url), path = url.pathname, method = request.method;
  const origin = request.headers.get('Origin') || '';
  const browserSync = path === '/api/sync' && !!extensionOrigin(request);
  if (!env.PUBLIC_ORIGIN || url.origin !== env.PUBLIC_ORIGIN ||
      (origin && origin !== env.PUBLIC_ORIGIN && !browserSync)) fail("Use the dashboard's configured address.", 403);
  if (method === 'OPTIONS' && path === '/api/sync' && browserSync)
    return new Response(null, {status: 204, headers: {...securityHeaders, ...extensionCors(origin)}});
  if (method === 'POST' && path === '/api/sync') return sync(request, env, ctx);
  if (method === 'POST' && path === '/api/login') return login(request, env);
  const publicAsset = ['/login', '/login.js', '/style.css', '/magic.css'].includes(path) && ['GET', 'HEAD'].includes(method);
  if (!publicAsset && !await authorized(request, env)) {
    if (path.startsWith('/api/')) fail('Sign in to your dashboard.', 401);
    return new Response(null, {status: 302, headers: {...securityHeaders, Location: '/login'}});
  }
  if (method === 'POST' && path === '/api/logout') {
    await readBody(request);
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await hash(sessionCookie(request).split('.')[0])).run();
    return json({signed_out: true}, 200, {'Set-Cookie': `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`});
  }
  if (method === 'POST' && path === '/api/devices') return pair(request, env);
  if (method === 'PUT' && path === '/api/work-ai') {
    const data = await readBody(request);
    if (typeof data.enabled !== 'boolean') fail('enabled must be true or false.');
    if (data.enabled && !env.AI) fail('AI suggestions are unavailable on this server.', 503);
    await env.DB.prepare('UPDATE work_ai_settings SET enabled=?,last_error=? WHERE id=1')
      .bind(data.enabled ? 1 : 0, '').run();
    if (data.enabled && ctx?.waitUntil) ctx.waitUntil(recentUnclassifiedDomains(env)
      .then(domains => classifyDomains(env, domains)).catch(() => {}));
    return json(await workAiState(env));
  }
  if (method === 'POST' && path === '/api/work-ai/refresh') {
    await readBody(request);
    if (!(await env.DB.prepare('SELECT enabled FROM work_ai_settings WHERE id=1').first())?.enabled) fail('Turn on AI suggestions first.', 409);
    const domains = await recentUnclassifiedDomains(env);
    if (ctx?.waitUntil && domains.length) ctx.waitUntil(classifyDomains(env, domains).catch(() => {}));
    const pending = await env.DB.prepare("SELECT COUNT(*) AS count FROM work_ai_suggestions WHERE classification='pending'").first();
    return json({queued: domains.length, pending: pending?.count || 0});
  }
  if (method === 'PUT' && path === '/api/work-rules') {
    const rule = workRule(object(await readBody(request)));
    if (rule.classification === 'unclassified') await env.DB.prepare('DELETE FROM work_rules WHERE type=? AND label=?').bind(rule.type, rule.label).run();
    else await env.DB.prepare('INSERT INTO work_rules(type,label,classification) VALUES(?,?,?) ON CONFLICT(type,label) DO UPDATE SET classification=excluded.classification').bind(rule.type, rule.label, rule.classification).run();
    return json(rule);
  }
  if (method === 'POST' && path === '/api/entries') {
    const e = entry(await readBody(request));
    await env.DB.prepare(`INSERT INTO entries(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).bind(...columns.map(c => e[c])).run();
    return json(e, 201);
  }
  if (method === 'DELETE' && /^\/api\/(entries|devices)\/[^/]+$/.test(path)) {
    const [, , resource, id] = path.split('/');
    const result = await env.DB.prepare(resource === 'devices' ? 'UPDATE devices SET revoked=1 WHERE id=?' : 'DELETE FROM entries WHERE id=?').bind(id).run();
    return json({[resource === 'devices' ? 'revoked' : 'deleted']: result.meta.changes > 0}, result.meta.changes ? 200 : 404);
  }
  if (method === 'GET') {
    if (path === '/api/health') { await env.DB.prepare('SELECT 1 FROM devices LIMIT 1').first(); return json({status: 'ok'}); }
    if (path === '/api/devices') return json({devices: await devices(env), sync: {enabled: true, cloud: true, url: env.PUBLIC_ORIGIN, certificate_sha256: ''}});
    if (path === '/api/work-ai') return json(await workAiState(env));
    if (path === '/api/work-rules') return json({rules: (await env.DB.prepare('SELECT type,label,classification FROM work_rules ORDER BY type,label').all()).results});
    if (path === '/api/export') return exportPage(url, env);
    if (path === '/api/day' || path === '/api/entries') {
      const {day, start, end} = dayBounds(url.searchParams);
      // Separate indexed ranges for starts today and activities crossing midnight.
      // The end index avoids rereading a week of screen sessions for today's chart.
      const entries = (await env.DB.prepare(`WITH daily AS (
        SELECT * FROM entries INDEXED BY entries_start WHERE started_at>=? AND started_at<?
        UNION ALL
        SELECT * FROM entries INDEXED BY entries_end WHERE ended_at>? AND ended_at<=? AND started_at<?
      ) SELECT e.*,d.name AS device_name FROM daily e LEFT JOIN devices d ON e.device_id=d.id ORDER BY e.started_at DESC`)
        .bind(iso(start), iso(end), iso(start), iso(start + 7 * 86400000), iso(start)).all()).results;
      const rules = path === '/api/day' ? (await env.DB.prepare('SELECT type,label,classification FROM work_rules').all()).results : [];
      const websites = [...new Set(entries.filter(e => e.source === 'windows-browser').map(e => e.label.toLowerCase()))];
      if (path === '/api/day' && websites.length && (await env.DB.prepare('SELECT enabled FROM work_ai_settings WHERE id=1').first())?.enabled) {
        const suggestions = (await env.DB.prepare("SELECT label,classification FROM work_ai_suggestions WHERE label IN (SELECT value FROM json_each(?)) AND classification IN ('work','personal')")
          .bind(JSON.stringify(websites)).all()).results;
        const manual = new Set(rules.filter(r => r.type === 'website').map(r => r.label));
        rules.push(...suggestions.filter(s => !manual.has(s.label)).map(s => ({type: 'website', ...s})));
      }
      return json(path === '/api/day' ? {date: day, totals: summarize(entries, start, end, rules), entries} : {entries});
    }
  }
  const assets = {'/': '/index.html', '/app.js': '/app.js', '/style.css': '/style.css', '/magic.css': '/magic.css', '/login': '/login.html', '/login.js': '/login.js', '/api/docs': '/api.html'};
  if (['GET', 'HEAD'].includes(method) && assets[path]) {
    url.pathname = assets[path]; url.search = '';
    const result = await env.ASSETS.fetch(new Request(url, {method}));
    const response = new Response(result.body, result);
    for (const [key, value] of Object.entries(securityHeaders)) response.headers.set(key, value);
    return response;
  }
  return json({error: 'Not found.'}, 404);
}
export default {
  async fetch(request, env, ctx) {
    try { return await route(request, env, ctx); }
    catch (error) {
      const cors = new URL(request.url).pathname === '/api/sync' ? extensionCors(request.headers.get('Origin')) : {};
      if (error instanceof HttpError) return json({error: error.message}, error.status, cors);
      const detail = `${error.message} ${error.cause?.message || ''}`;
      if (detail.includes('event_id_conflict')) return json({error: 'An event_id was reused for a different session.'}, 400, cors);
      if (detail.includes('device_revoked')) return json({error: 'Device key invalid or revoked. Pair the device again.'}, 401, cors);
      // Never return/log request bodies, credentials, or SQL parameters.
      return json({error: 'Could not access the database. Retry with the same event IDs.'}, 503, cors);
    }
  },
};

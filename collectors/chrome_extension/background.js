const SESSION_KEY = 'activeWebsiteSession';
const QUEUE_KEY = 'pendingWebsiteSessions';
const CONFIG_KEY = 'pairing';
const ENABLED_KEY = 'trackingEnabled';
const ALARM = 'sample-active-website';
const MAX_GAP_MS = 120000;
// Upload long-running visits in small completed slices so domains appear promptly.
const MAX_SESSION_MS = 300000;
const MIN_SESSION_MS = 5000;

let operations = Promise.resolve();

function serial(task) {
  const next = operations.then(task, task);
  operations = next.catch(() => {});
  return next.catch(error => setStatus(`Tracking error; retrying: ${error.message || 'unknown error'}`));
}

async function setStatus(status) {
  await chrome.storage.local.set({trackingStatus: status});
}

async function activeDomain() {
  const settings = await chrome.storage.local.get([CONFIG_KEY, ENABLED_KEY]);
  if (!settings[CONFIG_KEY] || settings[ENABLED_KEY] === false) return '';
  if (await chrome.idle.queryState(300) !== 'active') return '';
  try {
    const window = await chrome.windows.getLastFocused({populate: false});
    if (!window?.focused || window.type !== 'normal') return '';
    const [tab] = await chrome.tabs.query({active: true, windowId: window.id});
    if (!tab || tab.incognito || !tab.url) return '';
    const url = new URL(tab.url);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    return url.hostname.toLowerCase().replace(/\.$/, '');
  } catch (_) { return ''; }
}

async function saveSession(session, end) {
  if (!session || end - session.startedAt < MIN_SESSION_MS) return;
  const data = await chrome.storage.local.get(QUEUE_KEY);
  const pending = data[QUEUE_KEY] || [];
  pending.push({
    event_id: crypto.randomUUID(),
    type: 'website',
    app: session.domain,
    started_at: new Date(session.startedAt).toISOString(),
    ended_at: new Date(end).toISOString(),
  });
  await chrome.storage.local.set({[QUEUE_KEY]: pending});
}

async function uploadPending() {
  const data = await chrome.storage.local.get([CONFIG_KEY, QUEUE_KEY]);
  const config = data[CONFIG_KEY];
  const pending = data[QUEUE_KEY] || [];
  if (!config || !pending.length) return;
  const batch = pending.slice(0, 200);
  const response = await fetch(`${config.server_url.replace(/\/$/, '')}/api/sync`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}`},
    body: JSON.stringify({device_id: config.device_id, events: batch}),
  });
  const body = await response.json();
  if (!response.ok || body.accepted !== batch.length) throw new Error(body.error || 'The server did not confirm the upload.');
  const sent = new Set(batch.map(event => event.event_id));
  await chrome.storage.local.set({
    [QUEUE_KEY]: pending.filter(event => !sent.has(event.event_id)),
    trackingStatus: `Connected. Last website sync ${new Date().toLocaleTimeString()}.`,
  });
}

async function reconcile() {
  const now = Date.now();
  const [domain, data] = await Promise.all([activeDomain(), chrome.storage.local.get(SESSION_KEY)]);
  let session = data[SESSION_KEY] || null;
  const stale = session && now - session.lastSeenAt > MAX_GAP_MS;
  const rotate = session && now - session.startedAt >= MAX_SESSION_MS;
  if (session && (session.domain !== domain || stale || rotate)) {
    const end = stale ? session.lastSeenAt : now;
    await saveSession(session, end);
    session = null;
  }
  if (domain) {
    if (session) session.lastSeenAt = now;
    else session = {domain, startedAt: now, lastSeenAt: now};
  } else session = null;
  await chrome.storage.local.set({[SESSION_KEY]: session});
  await uploadPending();
}

function checkNow() { void serial(reconcile); }

function initialize() {
  chrome.idle.setDetectionInterval(300);
  chrome.alarms.create(ALARM, {periodInMinutes: 1});
  checkNow();
}

chrome.runtime.onInstalled.addListener(initialize);
chrome.runtime.onStartup.addListener(initialize);
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) checkNow(); });
chrome.tabs.onActivated.addListener(checkNow);
chrome.tabs.onUpdated.addListener((_, change, tab) => { if (tab.active && change.url) checkNow(); });
chrome.tabs.onRemoved.addListener(checkNow);
chrome.windows.onFocusChanged.addListener(checkNow);
chrome.idle.onStateChanged.addListener(checkNow);

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.action === 'set-enabled') {
    void serial(async () => {
      await chrome.storage.local.set({[ENABLED_KEY]: !!message.enabled});
      await reconcile();
      return {enabled: !!message.enabled};
    }).then(respond);
    return true;
  }
  if (message?.action === 'pairing-saved') { initialize(); respond({ok: true}); }
  return false;
});

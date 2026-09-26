const $ = (selector) => document.querySelector(selector);
const names = {water: 'Hydration', work: 'Work', gym: 'Movement', sleep: 'Sleep', screen: 'Screen time', custom: 'Custom'};
const symbols = {water: '◒', work: '▧', gym: '↗', sleep: '☾', screen: '▣', custom: '◇'};
const knownApps = {
  'chrome.exe': 'Google Chrome', 'msedge.exe': 'Microsoft Edge', 'firefox.exe': 'Firefox', 'explorer.exe': 'File Explorer',
  'code.exe': 'Visual Studio Code', 'spotify.exe': 'Spotify', 'discord.exe': 'Discord', 'teams.exe': 'Microsoft Teams',
  'com.android.chrome': 'Chrome', 'com.google.android.youtube': 'YouTube', 'com.google.android.apps.youtube.music': 'YouTube Music',
  'com.google.android.gm': 'Gmail', 'com.google.android.apps.maps': 'Google Maps', 'com.google.android.apps.photos': 'Google Photos',
  'com.google.android.apps.messaging': 'Google Messages', 'com.google.android.dialer': 'Phone', 'com.spotify.music': 'Spotify',
  'com.whatsapp': 'WhatsApp', 'com.instagram.android': 'Instagram', 'com.facebook.katana': 'Facebook',
};
let currentEntries = [];
let currentDevices = [];
let pairingConfig = null;
let workRules = [];
let workAi = {available: false, enabled: false, suggestions: []};
let loadId = 0;
let toastTimer;
const historyCache = new Map();
const pad = (n) => String(n).padStart(2, '0');
function localDate(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function localInput(d) { return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function duration(minutes) { const n = Math.round(minutes); return n >= 60 ? `${Math.floor(n / 60)}h ${n % 60}m` : `${n}m`; }
function displayAppName(label) {
  if (knownApps[label.toLowerCase()]) return knownApps[label.toLowerCase()];
  if (/\.exe$/i.test(label)) return label.slice(0, -4).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, c => c.toUpperCase());
  if (/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/i.test(label)) {
    const tail = label.split('.').at(-1);
    return tail.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, c => c.toUpperCase());
  }
  return label;
}
function deviceUsageBreakdown(device, entries, day) {
  const isWindowsChrome = label => device.platform === 'windows' && ['chrome.exe', 'google chrome'].includes(label.toLowerCase());
  const totals = new Map();
  const chromeIntervals = [];
  let chromeMinutes = 0;
  for (const entry of entries.filter(e => e.kind === 'screen' && e.device_id === device.id && e.source !== 'windows-browser')) {
    const interval = intervalInDay(entry, day);
    if (!interval) continue;
    const minutes = (interval.end - interval.start) / 60000;
    if (isWindowsChrome(entry.label)) {
      chromeIntervals.push(interval);
      chromeMinutes += minutes;
    } else {
      const label = displayAppName(entry.label);
      totals.set(label, (totals.get(label) || 0) + minutes);
    }
  }

  // Website sessions are detail within Chrome time, so clip them to Chrome's
  // foreground intervals and allocate overlapping intervals only once.
  const siteSegments = [];
  if (chromeIntervals.length) {
    for (const entry of entries.filter(e => e.kind === 'screen' && e.device_id === device.id && e.source === 'windows-browser')) {
      const site = intervalInDay(entry, day);
      if (!site) continue;
      for (const chrome of chromeIntervals) {
        const start = Math.max(site.start, chrome.start), end = Math.min(site.end, chrome.end);
        if (end > start) siteSegments.push({label: entry.label, start, end});
      }
    }
  }
  siteSegments.sort((a, b) => a.start - b.start || a.end - b.end);
  let allocatedUntil = -Infinity, siteMinutes = 0;
  for (const segment of siteSegments) {
    const start = Math.max(segment.start, allocatedUntil);
    if (segment.end <= start) continue;
    const minutes = (segment.end - start) / 60000;
    totals.set(segment.label, (totals.get(segment.label) || 0) + minutes);
    siteMinutes += minutes;
    allocatedUntil = segment.end;
  }
  const chromeWithoutSites = Math.max(0, chromeMinutes - siteMinutes);
  if (chromeWithoutSites > 0.001) totals.set('Chrome (site not identified)', chromeWithoutSites);
  return [...totals.entries()].map(([label, minutes]) => ({label, minutes})).filter(item => item.minutes > 0);
}
function notify(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500); }
async function api(path, options) {
  const response = await fetch(path, options);
  const endpoint = new URL(path, location.href).pathname;
  const raw = await response.text();
  let body;
  if (raw) {
    try { body = JSON.parse(raw); }
    catch {
      if (response.ok) throw new Error(`The server returned invalid data for ${endpoint} (HTTP ${response.status}). Reload and try again.`);
    }
  }
  if (response.status === 401) { location.assign('/login'); throw new Error('Please sign in.'); }
  if (!response.ok) throw new Error(body?.error || `Request to ${endpoint} failed (HTTP ${response.status}${raw ? '' : ', empty response'}).`);
  if (body === undefined) throw new Error(`The server returned an empty response for ${endpoint} (HTTP ${response.status}). Reload and try again.`);
  if (options?.method && options.method !== 'GET') historyCache.clear();
  return body;
}
function dayQuery(value) {
  const start = new Date(`${value}T00:00:00`);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  return new URLSearchParams({date: value, start: start.toISOString(), end: end.toISOString()});
}
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function minutesInDay(entry, day) {
  if (!entry.ended_at) return 0;
  const start = new Date(`${day}T00:00:00`);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  return Math.max(0, Math.min(+new Date(entry.ended_at), +end) - Math.max(+new Date(entry.started_at), +start)) / 60000;
}
function intervalInDay(entry, day) {
  if (!entry.ended_at) return null;
  const dayStart = new Date(`${day}T00:00:00`).getTime();
  const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
  const start = Math.max(new Date(entry.started_at).getTime(), dayStart);
  const end = Math.min(new Date(entry.ended_at).getTime(), +dayEnd);
  return end > start ? {start, end} : null;
}
const browserAppLabels = new Set(['chrome.exe', 'google chrome', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'com.android.chrome', 'com.microsoft.emmx', 'org.mozilla.firefox']);
function renderWorkAiControls() {
  $('#work-ai-controls').hidden = !workAi.available;
  if (!workAi.available) return;
  $('#work-ai-enabled').checked = workAi.enabled;
  $('#work-ai-refresh').hidden = !workAi.enabled;
  $('#work-ai-status').textContent = workAi.last_error || (workAi.enabled
    ? `${workAi.pending ? `Reviewing ${workAi.pending} sites · ` : ''}${workAi.used_today}/${workAi.daily_cap} site requests today`
    : 'AI is off. Existing guesses are ignored.');
}
async function refreshWorkAiView() {
  workAi = await api('/api/work-ai');
  renderWorkAiControls();
  historyCache.clear();
  await loadDay();
  if ($('#work-dialog').open) renderWorkRules();
}
function pollWorkAi() {
  for (const delay of [4000, 12000, 30000]) setTimeout(() => {
    if ($('#work-dialog').open) refreshWorkAiView().catch(error => { $('#work-rule-error').textContent = error.message; });
  }, delay);
}
function renderWorkRules() {
  const list = $('#work-rule-list'); list.replaceChildren();
  const chromeUsed = currentEntries.some(entry => entry.kind === 'screen' && entry.source === 'windows-collector' && ['chrome.exe', 'google chrome'].includes(entry.label.toLowerCase()));
  const websitesRecorded = currentEntries.some(entry => entry.kind === 'screen' && entry.source === 'windows-browser');
  if (chromeUsed && !websitesRecorded) {
    const help = node('p', 'muted small', 'Chrome app time is recorded, but no website domains have arrived for this day. Install and connect the separate Chrome extension using this PC\'s Windows pairing JSON. ');
    const link = node('a', '', 'Chrome setup instructions ↗'); link.href = '/api/docs#browser';
    help.append(link); list.append(help);
  }
  const observed = new Map();
  for (const entry of currentEntries) {
    if (entry.kind !== 'screen') continue;
    const type = entry.source === 'windows-browser' ? 'website' : 'app';
    const label = entry.label.toLowerCase();
    if (type === 'app' && browserAppLabels.has(label)) continue;
    const key = `${type}:${label}`;
    if (!observed.has(key)) observed.set(key, {type, label, minutes: 0});
    observed.get(key).minutes += minutesInDay(entry, $('#selected-date').value);
  }
  for (const rule of workRules) {
    const key = `${rule.type}:${rule.label}`;
    if (!observed.has(key)) observed.set(key, {...rule, minutes: 0});
  }
  for (const guess of workAi.suggestions || []) {
    const key = `website:${guess.label}`;
    if (!observed.has(key)) observed.set(key, {type: 'website', label: guess.label, minutes: 0});
  }
  const items = [...observed.values()].sort((a, b) => b.minutes - a.minutes || a.label.localeCompare(b.label));
  if (!items.length) { list.append(node('p', 'muted', chromeUsed ? 'No classifiable apps or website domains for this day yet.' : 'No app or website activity yet for this day. Pair and sync a device first.')); return; }
  for (const item of items) {
    const row = node('div', 'work-rule-row');
    const name = node('div', 'work-rule-name');
    name.append(node('strong', '', item.type === 'app' ? displayAppName(item.label) : item.label),
      node('small', '', `${item.type === 'app' ? 'App' : 'Website'} · ${duration(item.minutes)} on this day`));
    const manual = workRules.find(rule => rule.type === item.type && rule.label === item.label);
    const guess = item.type === 'website' ? workAi.suggestions?.find(s => s.label === item.label) : null;
    if (guess && !manual && workAi.enabled)
      name.append(node('small', 'work-ai-guess', `AI guess: ${guess.classification} · ${guess.reason || 'Based on the domain only'}`));
    else if (guess && manual) name.append(node('small', '', 'Your choice overrides the AI guess.'));
    const select = node('select');
    select.setAttribute('aria-label', `Classify ${item.label}`);
    for (const [value, label] of [['unclassified', 'Unclassified'], ['work', 'Work'], ['personal', 'Personal']]) {
      const option = node('option', '', label); option.value = value; select.append(option);
    }
    select.value = workRules.find(rule => rule.type === item.type && rule.label === item.label)?.classification || 'unclassified';
    select.addEventListener('change', async () => {
      const previous = workRules.find(rule => rule.type === item.type && rule.label === item.label)?.classification || 'unclassified';
      select.disabled = true; $('#work-rule-error').textContent = '';
      try {
        await api('/api/work-rules', {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({type:item.type, label:item.label, classification:select.value})});
        workRules = workRules.filter(rule => !(rule.type === item.type && rule.label === item.label));
        if (select.value !== 'unclassified') workRules.push({type:item.type, label:item.label, classification:select.value});
        await loadDay(); renderWorkRules();
      } catch (error) { select.value = previous; $('#work-rule-error').textContent = error.message; }
      finally { select.disabled = false; }
    });
    row.append(name, select); list.append(row);
  }
}
function renderDevicePie(card, device, entries, day) {
  const raw = deviceUsageBreakdown(device, entries, day);
  const total = raw.reduce((sum, item) => sum + item.minutes, 0);
  if (!total) {
    card.append(node('p', 'muted small device-chart-empty', 'No app time recorded for this day.'));
    return;
  }
  const shown = [], small = [];
  for (const item of raw) (item.minutes / total < 0.01 ? small : shown).push(item);
  if (small.length) shown.push({label: 'Other', minutes: small.reduce((sum, item) => sum + item.minutes, 0), other: true});
  shown.sort((a, b) => a.other ? 1 : b.other ? -1 : b.minutes - a.minutes);

  let percent = 0;
  const colors = shown.map((item, index) => item.other ? '#cfd7ca' : `hsl(${(index * 137.5 + 34) % 360} 48% 59%)`);
  const stops = shown.map((item, index) => {
    const from = percent;
    percent += item.minutes / total * 100;
    const to = index === shown.length - 1 ? 100 : percent;
    return `${colors[index]} ${from.toFixed(3)}% ${to.toFixed(3)}%`;
  });
  const chart = node('div', 'device-chart');
  const pie = node('div', 'device-pie');
  pie.style.background = `conic-gradient(${stops.join(', ')})`;
  pie.setAttribute('role', 'img');
  pie.setAttribute('aria-label', `Tracked app time: ${shown.map(item => `${item.label}, ${(item.minutes / total * 100).toFixed(1)} percent, ${duration(item.minutes)}`).join('; ')}`);
  const center = node('div', 'device-pie-center');
  center.append(node('span', 'device-pie-total', duration(total)), node('span', 'device-pie-caption', 'tracked time'));
  pie.append(center);
  const legend = node('div', 'device-legend');
  shown.forEach((item, index) => {
    const row = node('div', 'device-legend-row');
    const swatch = node('span', 'device-legend-swatch'); swatch.style.backgroundColor = colors[index];
    const label = node('span', 'device-legend-name', item.label);
    label.title = item.label;
    row.append(swatch, label, node('span', 'device-legend-percent', `${(item.minutes / total * 100).toFixed(1)}%`),
      node('span', 'device-legend-time', item.minutes < 0.5 ? '<1m' : duration(item.minutes)));
    legend.append(row);
  });
  chart.append(pie, legend);
  card.append(chart);
}
function renderEntries() {
  const container = $('#entries'); container.replaceChildren();
  const filter = $('#filter').value;
  const selected = currentEntries.filter(e => filter === 'all' || e.kind === filter);
  const groups = new Map();
  const entries = [];
  for (const entry of selected) {
    if (entry.kind !== 'screen' || !entry.device_id) { entries.push(entry); continue; }
    const key = JSON.stringify([entry.device_id, entry.label, entry.source]);
    if (!groups.has(key)) groups.set(key, {...entry, session_count:0, daily_minutes:0});
    const group = groups.get(key); group.session_count++;
    group.daily_minutes += minutesInDay(entry, $('#selected-date').value);
  }
  entries.push(...groups.values());
  entries.sort((a,b) => b.started_at.localeCompare(a.started_at));
  $('#journal-count').textContent = entries.length;
  if (!entries.length) {
    const empty = node('div', 'empty-state');
    empty.append(node('strong', '', filter === 'all' ? 'A fresh page for your day.' : 'Nothing logged here yet.'), node('p', '', 'Log an activity above and start building your daily picture.'));
    container.append(empty); return;
  }
  for (const entry of entries) {
    const row = node('div', 'entry');
    const copy = node('div', 'entry-copy');
    const fmt = d => new Date(d).toLocaleString([], {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
    const times = fmt(entry.started_at) + (entry.ended_at ? ` → ${fmt(entry.ended_at)}` : '');
    const website = entry.source === 'windows-browser';
    const title = entry.kind === 'screen' && !website ? displayAppName(entry.label) : entry.label;
    const subtitle = entry.session_count ? `${website ? 'Website' : 'App'} · ${entry.device_name || 'Device'} · ${entry.session_count} sessions` : `${names[entry.kind]} · ${times}${entry.source !== 'manual' ? ` · ${entry.source}` : ''}`;
    copy.append(node('div', 'entry-title', title), node('div', 'entry-subtitle', subtitle));
    if (entry.notes) copy.append(node('p', 'entry-notes', entry.notes));
    const amount = entry.session_count ? duration(entry.daily_minutes) : entry.kind === 'water' ? `${entry.value.toLocaleString()} ml` : entry.ended_at ? duration(minutesInDay(entry, $('#selected-date').value)) : entry.value ? `${entry.value} ${entry.unit}` : '';
    const remove = node('button', 'delete-entry', '×');
    remove.setAttribute('aria-label', `Delete ${entry.label}`);
    remove.addEventListener('click', async () => {
      if (!confirm(`Delete “${entry.label}”? This cannot be undone.`)) return;
      remove.disabled = true;
      try { await api(`/api/entries/${entry.id}`, {method: 'DELETE'}); await loadDay(); notify('Activity deleted.'); }
      catch (error) { notify(error.message); remove.disabled = false; }
    });
    row.append(node('span', 'entry-symbol', symbols[entry.kind]), copy, node('span', 'entry-value', amount));
    if (!entry.session_count) row.append(remove);
    container.append(row);
  }
}
function renderWeek(days, dates) {
  const chart = $('#week-chart'); chart.replaceChildren();
  const max = Math.max(60, ...days.flatMap(d => [d.totals.work_minutes, d.totals.gym_minutes, d.totals.screen_minutes]));
  const descriptions = [];
  days.forEach((day, index) => {
    const column = node('div', 'chart-day'); const bars = node('div', 'bars');
    const label = dates[index].toLocaleDateString([], {weekday: 'short'});
    const values = ['work', 'gym', 'screen'].map(kind => {
      const minutes = day.totals[`${kind}_minutes`];
      const bar = node('div', `bar bar-${kind}`); bar.style.height = `${minutes / max * 95}%`;
      bars.append(bar); return `${names[kind]} ${duration(minutes)}`;
    });
    column.title = `${localDate(dates[index])}: ${values.join(', ')}`;
    descriptions.push(`${label}: ${values.join(', ')}`);
    column.append(bars, node('span', 'chart-label', label)); chart.append(column);
  });
  chart.setAttribute('aria-label', descriptions.join('; '));
}
async function loadDay() {
  const version = ++loadId;
  const value = $('#selected-date').value;
  if (!value) return;
  $('#entry-count').textContent = 'Loading your day…';
  const selected = new Date(`${value}T12:00:00`);
  const dates = Array.from({length: 7}, (_, i) => { const d = new Date(selected); d.setDate(d.getDate() - 6 + i); return d; });
  try {
    // Current/selected day stays fresh. Refresh historical chart totals every ten
    // minutes so a dashboard left open doesn't repeatedly read the same history.
    const [days, deviceData] = await Promise.all([Promise.all(dates.map(async d => {
      const date = localDate(d), cached = historyCache.get(date);
      if (date !== value && date !== localDate() && cached && Date.now() - cached.at < 600000) return cached.data;
      const data = await api(`/api/day?${dayQuery(date)}`);
      if (historyCache.size >= 30) historyCache.delete(historyCache.keys().next().value);
      historyCache.set(date, {at: Date.now(), data: {totals: data.totals}});
      return data;
    })), api('/api/devices')]);
    if (version !== loadId) return;
    const data = days[6]; currentEntries = data.entries;
    currentDevices = deviceData.devices;
    renderDevices(deviceData.sync);
    $('#screen-unique').textContent = `${duration(data.totals.screen_unique_minutes || 0)} with simultaneous use counted once`;
    $('#water-total').textContent = data.totals.water_ml.toLocaleString();
    for (const kind of ['work', 'gym', 'sleep', 'screen']) $(`#${kind}-total`).textContent = duration(data.totals[`${kind}_minutes`]);
    $('#work-detail').textContent = `${duration(data.totals.work_auto_minutes || 0)} from screens · ${duration(data.totals.work_manual_minutes || 0)} logged`;
    $('#entry-count').textContent = `${data.entries.length} ${data.entries.length === 1 ? 'activity' : 'activities'} logged`;
    $('#day-label').textContent = selected.toLocaleDateString([], {weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'}).toUpperCase();
    renderEntries(); renderWeek(days, dates);
  } catch (error) {
    if (version !== loadId) return;
    $('#entry-count').textContent = 'Could not refresh this day'; notify(error.message);
  }
}
function syncFields() {
  const kind = $('#entry-kind').value;
  const timed = ['work', 'gym', 'sleep', 'screen'].includes(kind);
  $('#end-field').hidden = !timed; $('#entry-form').elements.ended_at.required = timed;
  $('#value-row').hidden = timed; $('#unit-field').hidden = kind !== 'custom';
  $('#value-label').textContent = kind === 'water' ? 'Amount (ml)' : 'Value (optional)';
  $('#entry-form').elements.value.required = kind === 'water';
  $('#entry-form').elements.value.max = kind === 'water' ? '10000' : '1000000';
  $('#start-label').textContent = kind === 'sleep' ? 'Bedtime' : timed ? 'Start' : 'When';
}
function openEntry(kind = 'water') {
  const form = $('#entry-form'); form.reset(); $('#form-error').textContent = '';
  $('#entry-kind').value = kind;
  const end = new Date(); const day = new Date(`${$('#selected-date').value}T12:00:00`);
  end.setFullYear(day.getFullYear(), day.getMonth(), day.getDate());
  if (kind === 'sleep') end.setHours(7, 0, 0, 0);
  const start = new Date(+end - (kind === 'sleep' ? 8 : kind === 'water' || kind === 'custom' ? 0 : 1) * 3600000);
  form.elements.started_at.value = localInput(start); form.elements.ended_at.value = localInput(end);
  form.elements.value.value = kind === 'water' ? '250' : '';
  syncFields(); $('#entry-dialog').showModal();
}
$('#selected-date').value = localDate();
$('#entry-kind option[value="screen"]').remove();
$('#selected-date').addEventListener('change', loadDay);
for (const [id, delta] of [['previous-day', -1], ['next-day', 1]]) $(`#${id}`).addEventListener('click', () => {
  const d = new Date(`${$('#selected-date').value}T12:00:00`); d.setDate(d.getDate()+delta); $('#selected-date').value = localDate(d); loadDay();
});
$('#today').addEventListener('click', () => { $('#selected-date').value = localDate(); loadDay(); });
$('#filter').addEventListener('change', renderEntries);
$('#add-entry').addEventListener('click', () => openEntry());
document.querySelectorAll('[data-kind]').forEach(button => button.addEventListener('click', () => openEntry(button.dataset.kind)));
$('#manage-work').addEventListener('click', async () => {
  $('#work-rule-error').textContent = '';
  try {
    const [rules, ai] = await Promise.all([api('/api/work-rules'), api('/api/work-ai')]);
    workRules = rules.rules; workAi = ai;
    renderWorkAiControls();
    renderWorkRules(); $('#work-dialog').showModal();
  } catch (error) { notify(error.message); }
});
$('#close-work').addEventListener('click', () => $('#work-dialog').close());
$('#work-ai-enabled').addEventListener('change', async () => {
  const toggle = $('#work-ai-enabled'); toggle.disabled = true; $('#work-rule-error').textContent = '';
  try {
    workAi = await api('/api/work-ai', {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({enabled:toggle.checked})});
    renderWorkAiControls(); renderWorkRules(); historyCache.clear(); await loadDay();
    if (workAi.enabled) pollWorkAi();
  } catch (error) { toggle.checked = !toggle.checked; $('#work-rule-error').textContent = error.message; }
  finally { toggle.disabled = false; }
});
$('#work-ai-refresh').addEventListener('click', async () => {
  const button = $('#work-ai-refresh'); button.disabled = true; $('#work-rule-error').textContent = '';
  try {
    const result = await api('/api/work-ai/refresh', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'});
    if (result.queued || result.pending) {
      $('#work-ai-status').textContent = `Reviewing ${result.queued + result.pending} recorded sites…`;
      pollWorkAi();
    } else await refreshWorkAiView();
  } catch (error) { $('#work-rule-error').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#entry-kind').addEventListener('change', syncFields);
for (const id of ['close-dialog', 'cancel-dialog']) $(`#${id}`).addEventListener('click', () => $('#entry-dialog').close());
$('#entry-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); const kind = data.get('kind');
  $('#save-entry').disabled = true; $('#form-error').textContent = '';
  try {
    const entry = {kind, label: data.get('label'), notes: data.get('notes'), started_at: new Date(data.get('started_at')).toISOString()};
    if (['work','gym','sleep','screen'].includes(kind)) entry.ended_at = new Date(data.get('ended_at')).toISOString();
    else if (data.get('value')) { entry.value = Number(data.get('value')); entry.unit = data.get('unit'); }
    await api('/api/entries', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(entry)});
    $('#entry-dialog').close(); await loadDay(); notify('Activity saved. A little more of your day, remembered.');
  } catch (error) { $('#form-error').textContent = error.message; }
  finally { $('#save-entry').disabled = false; }
});
document.querySelectorAll('[data-water]').forEach(button => button.addEventListener('click', async () => {
  const buttons = document.querySelectorAll('[data-water]'); buttons.forEach(b => b.disabled = true);
  try {
    const d = new Date(); const day = new Date(`${$('#selected-date').value}T12:00:00`); d.setFullYear(day.getFullYear(), day.getMonth(), day.getDate());
    await api('/api/entries', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({kind:'water', value:Number(button.dataset.water), started_at:d.toISOString()})});
    await loadDay(); notify(`${button.dataset.water} ml logged.`);
  } catch (error) { notify(error.message); }
  finally { buttons.forEach(b => b.disabled = false); }
}));
$('#export').addEventListener('click', async () => {
  const button = $('#export'); button.disabled = true;
  try {
    const data = await api('/api/export');
    let cursor = data.next_cursor;
    while (cursor) {
      const page = await api(`/api/export?cursor=${encodeURIComponent(cursor)}`);
      data.entries.push(...page.entries); cursor = page.next_cursor;
    }
    delete data.next_cursor;
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type:'application/json'}));
    const link = node('a'); link.href = url; link.download = `SimonSealsAPI-${localDate()}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); notify('Your data export is ready.');
  } catch (error) { notify(error.message); }
  finally { button.disabled = false; }
});
loadDay();
setInterval(() => { if (!document.hidden && !$('#entry-dialog').open) loadDay(); }, 60000);

function renderDevices(sync) {
  $('#sign-out').hidden = !sync.cloud;
  if (sync.cloud) {
    $('.private-badge').textContent = '● Private cloud sync';
    $('.local-pill').replaceChildren(node('span'), document.createTextNode('Stored in your cloud server'));
  }
  const container = $('#device-list'); container.replaceChildren();
  const devices = currentDevices.filter(device => !device.revoked);
  $('#device-count').textContent = `${devices.length} paired`;
  $('#sync-status').textContent = sync.enabled ? `Sync server: ${sync.url}` : 'Cloud setup needed. Deploy your server, then open its dashboard to pair your five devices.';
  $('#pair-device').disabled = !sync.enabled;
  const total = id => currentEntries.filter(e => e.kind === 'screen' && e.source !== 'windows-browser' && e.device_id === id).reduce((sum,e) => sum + minutesInDay(e, $('#selected-date').value), 0);
  for (const device of devices) {
    const card = node('article', 'device-card');
    card.append(node('span', 'device-type', device.platform === 'android' ? 'GOOGLE PIXEL / ANDROID' : 'WINDOWS PC'), node('h3', '', device.name), node('div', 'device-minutes', duration(total(device.id))));
    card.append(node('p', 'muted small', device.last_seen ? `Last synced ${new Date(device.last_seen).toLocaleString()}` : 'Waiting for the first sync'));
    card.append(node('div', 'device-chart-heading', 'Apps and websites'));
    renderDevicePie(card, device, currentEntries, $('#selected-date').value);
    if (device.platform === 'windows' && currentEntries.some(entry => entry.device_id === device.id && entry.source === 'windows-collector' && ['chrome.exe', 'google chrome'].includes(entry.label.toLowerCase())) && !currentEntries.some(entry => entry.device_id === device.id && entry.source === 'windows-browser')) {
      const help = node('p', 'muted small', 'No Chrome domains recorded for this day. The Windows app collector needs a separate Chrome extension for websites. ');
      const link = node('a', '', 'Set it up ↗'); link.href = '/api/docs#browser';
      help.append(link); card.append(help);
    }
    const revoke = node('button', 'text-button', 'Revoke pairing');
    revoke.addEventListener('click', async () => {
      if (!confirm(`Revoke “${device.name}”? Its uploads will stop. Existing history will remain. Pause or uninstall its collector to stop local recording.`)) return;
      try { await api(`/api/devices/${device.id}`, {method:'DELETE'}); await loadDay(); notify('Device key revoked.'); }
      catch(error) { notify(error.message); }
    });
    card.append(revoke); container.append(card);
  }
  const missing = [...Array(Math.max(0,3-devices.filter(d => d.platform === 'windows').length)).fill('Windows PC'), ...Array(Math.max(0,2-devices.filter(d => d.platform === 'android').length)).fill('Google Pixel')];
  for (const label of missing) {
    const card = node('article', 'device-card device-placeholder');
    card.append(node('span', 'device-type', label === 'Windows PC' ? 'WINDOWS PC' : 'GOOGLE PIXEL / ANDROID'), node('h3', '', label), node('p', 'muted small', 'Not paired yet'));
    container.append(card);
  }
}
$('#pair-device').addEventListener('click', () => {
  pairingConfig = null; $('#device-form').reset(); $('#pair-json').value = '';
  $('#pair-fields').hidden = false; $('#pair-result').hidden = true; $('#pair-error').textContent = '';
  $('#device-dialog').showModal();
});
$('#close-device').addEventListener('click', () => $('#device-dialog').close());
$('#device-dialog').addEventListener('close', () => { pairingConfig = null; $('#pair-json').value = ''; });
$('#device-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#create-pairing').disabled = true; $('#pair-error').textContent = '';
  try {
    pairingConfig = await api('/api/devices', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:$('#device-name').value, platform:$('#device-platform').value})});
    $('#pair-json').value = JSON.stringify(pairingConfig,null,2);
    $('#pair-fields').hidden = true; $('#pair-result').hidden = false;
    $('#pair-instructions').textContent = pairingConfig.platform === 'android' ? 'Install SimonSealsAPI.apk on this Pixel, import this pairing file, and allow Usage Access. The phone will collect and sync automatically.' : 'Download this file on the matching Windows PC and use it for the Windows installer. To track Chrome websites too, load the Chrome extension from the project and paste this same pairing JSON there.';
    await loadDay();
  } catch(error) { $('#pair-error').textContent = error.message; }
  finally { $('#create-pairing').disabled = false; }
});
$('#download-pairing').addEventListener('click', () => {
  if (!pairingConfig) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(pairingConfig,null,2)],{type:'application/json'}));
  const link = node('a'); link.href = url; link.download = `SimonSealsAPI-${pairingConfig.device_id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
});
$('#sign-out').addEventListener('click', async () => {
  try { await api('/api/logout', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'}); location.assign('/login'); }
  catch(error) { notify(error.message); }
});

const $ = selector => document.querySelector(selector);
const configKey = 'pairing';

async function refresh() {
  const data = await chrome.storage.local.get([configKey, 'trackingEnabled', 'trackingStatus']);
  const connected = !!data[configKey];
  const enabled = data.trackingEnabled !== false;
  $('#status').textContent = connected ? (data.trackingStatus || 'Connected.') : 'Not connected.';
  $('#toggle').disabled = !connected;
  $('#toggle').textContent = enabled ? 'Pause tracking' : 'Resume tracking';
  if (connected) $('#pairing').placeholder = `Connected to ${data[configKey].device_name || 'this Windows PC'}. Paste the same key again to reconnect.`;
}

$('#connect').addEventListener('click', async () => {
  const button = $('#connect'); button.disabled = true; $('#status').textContent = 'Checking pairing…';
  try {
    const config = JSON.parse($('#pairing').value);
    const server = new URL(config.server_url);
    if (server.protocol !== 'https:' || !['', '/'].includes(server.pathname) || server.search || server.hash || server.username || server.password)
      throw new Error('The server URL must be an HTTPS address without a path.');
    if (config.platform !== 'windows' || !config.device_id || !config.token)
      throw new Error('Use a Windows pairing file with its device ID and key.');
    if (config.certificate_sha256) throw new Error('Chrome tracking requires a standard public HTTPS certificate.');
    const permission = {origins: [`${server.origin}/*`]};
    if (!await chrome.permissions.request(permission)) throw new Error('Allow access to your SimonSealsAPI server to connect.');
    const previous = await chrome.storage.local.get(configKey);
    if (previous[configKey] && previous[configKey].device_id !== config.device_id)
      throw new Error('This Chrome profile is paired to another device. Remove this extension first to change pairings.');
    await chrome.storage.local.set({[configKey]: config, trackingEnabled: true, trackingStatus: 'Connected. Waiting for an active website.'});
    $('#pairing').value = '';
    await chrome.runtime.sendMessage({action: 'pairing-saved'});
    await refresh();
  } catch (error) { $('#status').textContent = error.message || 'Could not connect.'; }
  finally { button.disabled = false; }
});

$('#toggle').addEventListener('click', async () => {
  const current = await chrome.storage.local.get('trackingEnabled');
  const enabled = current.trackingEnabled === false;
  $('#toggle').disabled = true;
  try { await chrome.runtime.sendMessage({action: 'set-enabled', enabled}); await refresh(); }
  catch (_) { $('#status').textContent = 'Could not update tracking.'; }
  finally { $('#toggle').disabled = false; }
});

refresh();

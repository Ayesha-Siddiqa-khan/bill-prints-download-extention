importScripts('core.js', 'scan.js');
let creating;
const downloadNames = new Map();
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const filename = downloadNames.get(item.url);
  if (filename) { downloadNames.delete(item.url); suggest({filename, conflictAction: 'uniquify'}); }
  else suggest();
});
async function ensureRunner() {
  if ((await chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT']})).length) return;
  if (!creating) creating = chrome.offscreen.createDocument({url: 'offscreen.html', reasons: ['BLOBS'],
    justification: 'Cache PDF blobs locally, download and merge them while the control window is minimized.'}).finally(() => { creating = null; });
  await creating;
}
chrome.action.onClicked.addListener(async tab => {
  await chrome.storage.local.set({sourceTabId: tab.id});
  const contexts = await chrome.runtime.getContexts({contextTypes: ['TAB'], documentUrls: [chrome.runtime.getURL('panel.html')]});
  if (contexts.length) {
    await chrome.windows.update(contexts[0].windowId, {focused: true, state: 'normal'});
    return;
  }
  await chrome.windows.create({url: 'panel.html', type: 'popup', width: 1060, height: 790, focused: true});
});
async function handle(message) {
  if (message.type === 'SCAN') {
    const {sourceTabId} = await chrome.storage.local.get('sourceTabId');
    if (!sourceTabId) throw new Error('Click the extension icon on the billing list tab first.');
    const tab = await chrome.tabs.get(sourceTabId);
    if (!BillCore.allowedUrl(tab.url)) throw new Error('Open the billing list on https://elgcd.punjab.gov.pk and click the extension icon there.');
    const [{result}] = await chrome.scripting.executeScript({target: {tabId: sourceTabId}, world: 'MAIN', func: scanBillTable});
    if (!result) throw new Error('Could not read the bill table. Refresh the billing page and try again.');
    for (const row of result.rows) if (row.viewRef) row.viewRef.tabId = sourceTabId;
    return result;
  }
  if (message.type === 'RESOLVE_VIEW') {
    const row = message.row;
    if (!row?.viewRef || !BillCore.canDownload({...row, url: ''})) throw new Error('Invalid billing View action.');
    let tab;
    try { tab = await chrome.tabs.get(row.viewRef.tabId); } catch { /* Browser restarts may change tab IDs. */ }
    if (!tab || tab.url !== row.viewRef.pageUrl) {
      const {sourceTabId} = await chrome.storage.local.get('sourceTabId');
      if (sourceTabId) { try { tab = await chrome.tabs.get(sourceTabId); } catch { tab = null; } }
    }
    if (!tab || tab.url !== row.viewRef.pageUrl || !BillCore.allowedUrl(tab.url)) throw new Error('Reopen the original billing list and click the extension icon on that tab, then Resume.');
    const [{result}] = await chrome.scripting.executeScript({target: {tabId: tab.id}, world: 'MAIN', func: resolveBillView, args: [row]});
    if (result?.error) throw new Error(result.error);
    if (!BillCore.allowedUrl(result?.url)) throw new Error('View did not produce a supported PDF URL.');
    return result.url;
  }
  if (message.type === 'COMMAND') {
    await ensureRunner();
    // createDocument can finish before the offscreen script installs its listener.
    let response;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        response = await chrome.runtime.sendMessage({target: 'runner', action: message.action, payload: message.payload});
        break;
      } catch (error) {
        if (!error.message.includes('Receiving end does not exist') || attempt === 99) throw error;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    if (!response?.ok) throw new Error(response?.error || 'PDF processor did not respond.');
    return response.data;
  }
  if (message.type === 'SAVE') {
    if (!message.url.startsWith(`blob:chrome-extension://${chrome.runtime.id}/`)) throw new Error('Invalid download source.');
    if (!message.filename || message.filename.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Invalid filename.');
    downloadNames.set(message.url, message.filename);
    try { return await chrome.downloads.download({url: message.url, filename: message.filename, saveAs: false, conflictAction: 'uniquify'}); }
    catch (error) { downloadNames.delete(message.url); throw error; }
  }
  if (message.type === 'DOWNLOAD_STATUS') {
    const [item] = await chrome.downloads.search({id: message.id});
    return item ? {state: item.state, error: item.error} : {state: 'interrupted', error: 'Download record missing'};
  }
  if (message.type === 'SHOW_FOLDER') {
    if (message.id) await chrome.downloads.show(message.id);
    else await chrome.downloads.showDefaultFolder();
    return true;
  }
  throw new Error('Unknown command.');
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message.target === 'runner') return;
  handle(message).then(data => reply({ok: true, data}), error => reply({ok: false, error: error.message}));
  return true;
});

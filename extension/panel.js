const $ = id => document.getElementById(id);
let preview = [], current, working = false, polling = false;
let settingsJobId;
const retrySettings = () => ({waitSeconds: Number($('waitMinutes').value) * 60, concurrency: Number($('parallelDownloads').value), autoRetry: $('autoRetry').checked});
const selected = new Set();
const jobSelected = new Set();
async function rpc(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'Extension is unavailable. Reopen this window.');
  return response.data;
}
function error(error) { $('error').textContent = error.message; $('error').hidden = false; }
function formatTime(ms) { return [Math.floor(ms / 3600000), Math.floor(ms / 60000) % 60, Math.floor(ms / 1000) % 60].map(n => String(Math.max(0,n)).padStart(2,'0')).join(':'); }
function renderRows(rows, isJob) {
  const body = $('rows'); body.replaceChildren();
  rows.forEach((row, index) => {
    const tr = document.createElement('tr');
    const pick = document.createElement('input'); pick.type = 'checkbox'; pick.checked = isJob ? jobSelected.has(row.id) : selected.has(index);
    pick.disabled = working || !BillCore.canDownload(row) || (isJob && row.status === 'done');
    pick.setAttribute('aria-label', `Select ${row.locality}`);
    pick.addEventListener('change', () => {
      const set = isJob ? jobSelected : selected, id = isJob ? row.id : index;
      if (pick.checked) set.add(id); else set.delete(id); render();
    });
    const td = document.createElement('td'); td.append(pick); tr.append(td);
    for (const value of [index + 1, row.locality, row.billCount || '—', row.filename]) {
      const cell = document.createElement('td'); cell.textContent = value;
      if (value === row.locality) { const small = document.createElement('small'); small.textContent = row.sector || ''; cell.append(small); }
      tr.append(cell);
    }
    const state = document.createElement('td'), badge = document.createElement('span');
    badge.className = 'row-status ' + row.status;
    badge.textContent = !BillCore.canDownload(row) ? 'Missing View link' : row.status === 'pending' ? (!row.url ? 'View action ready' : 'Queued') : row.status;
    state.append(badge);
    if (row.error) { const small = document.createElement('small'); small.textContent = row.error; state.append(small); }
    if (row.transferNote) { const small = document.createElement('small'); small.textContent = row.transferNote; state.append(small); }
    if (row.attempts) { const small = document.createElement('small'); small.textContent = `Attempts: ${row.attempts}`; state.append(small); }
    tr.append(state);
    const retryCell = document.createElement('td');
    if (isJob && row.status !== 'done') {
      const active = current?.busy && row.status === 'fetching';
      const retry = document.createElement('button'); retry.className = 'secondary'; retry.textContent = active ? 'Skip' : 'Retry';
      retry.setAttribute('aria-label', `${active ? 'Skip' : 'Retry'} ${row.locality} file ${row.fileNumber || index + 1}`);
      retry.disabled = working || row.skipRequested || (!active && current?.busy);
      retry.title = current?.busy ? 'Pause or Stop the batch before retrying one file.' : 'Download only this unfinished file, then refresh the CSV and merge.';
      retry.onclick = () => act(async () => {
        current = await rpc({type: 'COMMAND', action: active ? 'skip' : 'retry-one', payload: {id: row.id, ...retrySettings()}});
        preview = [];
      });
      retryCell.append(retry);
    }
    tr.append(retryCell); body.append(tr);
  });
  $('rowCount').textContent = rows.length; $('empty').hidden = !!rows.length;
}
let rowsKey = '';
function render() {
  const job = current?.job, busy = current?.busy;
  const rows = preview.length ? preview : job?.rows || [];
  const isJob = !preview.length && !!job;
  for (const id of jobSelected) if (!job?.rows.some(r => r.id === id && r.status !== 'done')) jobSelected.delete(id);
  const key = JSON.stringify([rows, isJob, [...selected], [...jobSelected], busy, working]);
  if (key !== rowsKey) { renderRows(rows, isJob); rowsKey = key; }
  const done = job?.rows.filter(r => r.status === 'done') || [];
  $('status').textContent = job ? job.status.replaceAll('_', ' ') : 'Ready';
  const activeRows = job?.rows.filter(r => r.status === 'fetching') || [];
  $('message').textContent = activeRows.length > 1 ? `Processing ${activeRows.length} files in parallel…` : job?.message || 'Ready when you are';
  $('counter').textContent = `${done.length} / ${job?.rows.length || 0}`;
  $('progress').max = job?.rows.length || 1; $('progress').value = done.length;
  $('failed').textContent = job?.rows.filter(r => r.status === 'failed').length || 0;
  $('pages').textContent = done.reduce((sum, r) => sum + r.pages, 0);
  $('elapsed').textContent = formatTime((job?.elapsedMs || 0) + (busy && job?.activeSince ? Date.now() - job.activeSince : 0));
  $('next').textContent = busy && job.status === 'running' && job.nextAt > Date.now() ? `${Math.ceil((job.nextAt - Date.now()) / 1000)}s` : '—';
  const active = activeRows.find(r => !r.skipRequested);
  const mb = value => (value / (1024 * 1024)).toFixed(1);
  $('transfer').textContent = activeRows.length && busy ? activeRows.map(r => `${r.locality}: ${mb(r.bytesReceived || 0)} MB${r.totalBytes ? ` / ${mb(r.totalBytes)} MB` : ''} received · ${r.deadline ? `Wait remaining: ${formatTime(Math.max(0, r.deadline - Date.now()))}` : 'Waiting to prepare PDF'}${r.phase === 'waiting' ? ' · Connection interrupted; no retry before deadline' : ''}`).join('\n') : job ? `Retry pass ${job.retryPass || 1} · ${job.autoRetry ? 'Auto retry enabled' : 'Auto retry off'} · ${job.concurrency || 5} download slots · Progress saved on this device` : '';
  $('destination').textContent = `Downloads / ${job?.folder || BillCore.folderName()}`;
  $('start').disabled = working || busy || !preview.length || !selected.size;
  $('downloadSelected').hidden = !isJob;
  $('downloadSelected').disabled = working || busy || !isJob || !jobSelected.size;
  $('pause').disabled = working || !busy || job?.status !== 'running';
  $('stop').disabled = $('pause').disabled;
  $('skip').disabled = working || !busy || job?.status !== 'running' || !active || active.skipRequested;
  $('resume').disabled = working || busy || !job || job.status === 'completed';
  $('scan').disabled = $('add').disabled = working || busy;
  $('clear').disabled = working || busy || !job;
  const eligible = rows.filter(r => BillCore.canDownload(r) && (!isJob || r.status !== 'done'));
  const count = isJob ? jobSelected.size : selected.size;
  $('selectAll').disabled = working || !eligible.length;
  $('selectAll').checked = eligible.length > 0 && count === eligible.length;
  $('selectAll').indeterminate = count > 0 && count < eligible.length;
  $('selectionLabel').textContent = isJob ? 'Select unfinished files' : 'Select all';
  $('selectionInfo').textContent = isJob ? `${count} unfinished files selected. ${busy ? 'Pause or Stop before downloading only the selected files.' : 'Download selected runs only checked rows; completed PDFs stay saved.'}` : `${count} files selected for the new batch.`;
}
async function act(fn) {
  if (working) return;
  working = true; $('error').hidden = true; render();
  try { await fn(); } catch (e) { error(e); }
  finally { working = false; render(); }
}
async function scan(append) {
  const result = await rpc({type: 'SCAN'});
  if (!result.rows.length) throw new Error('No View links found. Show the bill list on the portal first.');
  const combined = append ? [...preview, ...result.rows] : result.rows;
  const seen = new Set();
  preview = BillCore.prepareRows(combined.filter(row => {
    const key = JSON.stringify([row.url, row.locality, row.sector, row.fileNumber, row.billCount]);
    if (seen.has(key)) return false; seen.add(key); return true;
  }));
  selected.clear(); preview.forEach((r,i) => { if (BillCore.canDownload(r)) selected.add(i); });
  $('scanInfo').textContent = `${preview.length} localities collected. ${result.info} ` +
    (result.paginationWarning || (result.serverSide ? 'Server pagination detected: move to each next list page and use “Add another list page” before starting.' : 'All loaded, filtered DataTables rows are included. If the portal has more pages not loaded here, add each page.'));
  const dynamic = preview.filter(r => !r.url && BillCore.canDownload(r)).length;
  if (dynamic) $('scanInfo').textContent += ` ${dynamic} View actions will be resolved during download. Keep this billing list page open.`;
  const missing = preview.filter(r => !BillCore.canDownload(r)).length;
  if (missing) throw new Error(`${missing} rows have unsupported or missing View links and were left unselected. Those rows need a real PDF link from the portal.`);
}
$('scan').onclick = () => act(() => scan(false));
$('add').onclick = () => act(() => scan(true));
$('start').onclick = () => act(async () => {
  if (current?.job && !confirm('Start a new batch? This replaces the previous batch’s temporary copies and resume progress. Already downloaded files stay on disk.')) return;
  current = await rpc({type: 'COMMAND', action: 'start', payload: {rows: preview.filter((_,i) => selected.has(i)), delay: $('delay').value, ...retrySettings()}});
  preview = []; selected.clear();
});
$('downloadSelected').onclick = () => act(async () => {
  current = await rpc({type: 'COMMAND', action: 'retry-selected', payload: {ids: [...jobSelected], ...retrySettings()}});
});
for (const action of ['pause', 'stop', 'resume', 'skip']) $(action).onclick = () => act(async () => {
  current = await rpc({type: 'COMMAND', action, payload: action === 'resume' ? retrySettings() : undefined});
  if (action === 'resume') preview = [];
});
$('clear').onclick = () => act(async () => {
  if (!confirm('Delete this batch’s temporary PDF copies and saved progress? Files in Downloads will remain.')) return;
  current = await rpc({type: 'COMMAND', action: 'clear'});
});
$('folder').onclick = () => act(() => rpc({type: 'SHOW_FOLDER', id: current?.job?.lastDownloadId}));
$('selectAll').onchange = event => {
  const isJob = !preview.length && !!current?.job, set = isJob ? jobSelected : selected;
  set.clear();
  if (event.target.checked) (isJob ? current.job.rows : preview).forEach((r,i) => {
    if (BillCore.canDownload(r) && (!isJob || r.status !== 'done')) set.add(isJob ? r.id : i);
  });
  render();
};
$('minimize').onclick = () => act(async () => { const win = await chrome.windows.getCurrent(); await chrome.windows.update(win.id, {state: 'minimized'}); });
$('close').onclick = () => window.close();
for (const id of ['waitMinutes', 'parallelDownloads', 'autoRetry']) $(id).onchange = () => act(async () => {
  if (current?.job) current = await rpc({type: 'COMMAND', action: 'settings', payload: retrySettings()});
});
async function refresh() {
  if (polling || working) return;
  polling = true;
  try {
    current = await rpc({type: 'COMMAND', action: 'state'});
    if (current.job && settingsJobId !== current.job.id) {
      jobSelected.clear();
      settingsJobId = current.job.id;
      $('waitMinutes').value = (current.job.waitSeconds || 600) / 60;
      $('autoRetry').checked = !!current.job.autoRetry;
      $('parallelDownloads').value = current.job.concurrency || 5;
    }
    render();
  }
  catch(e) { error(e); }
  finally { polling = false; }
}
void refresh(); setInterval(refresh, 1000); setInterval(render, 250);

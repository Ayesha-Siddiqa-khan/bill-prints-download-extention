const $ = id => document.getElementById(id);
let preview = [], current, working = false, polling = false;
const selected = new Set();
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
    const pick = document.createElement('input'); pick.type = 'checkbox'; pick.checked = isJob || selected.has(index); pick.disabled = isJob;
    pick.setAttribute('aria-label', `Select ${row.locality}`);
    pick.addEventListener('change', () => { if (pick.checked) selected.add(index); else selected.delete(index); render(); });
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
    tr.append(state); body.append(tr);
  });
  $('rowCount').textContent = rows.length; $('empty').hidden = !!rows.length;
}
let rowsKey = '';
function render() {
  const job = current?.job, busy = current?.busy;
  const rows = preview.length ? preview : job?.rows || [];
  const isJob = !preview.length && !!job;
  const key = JSON.stringify([rows, isJob, [...selected]]);
  if (key !== rowsKey) { renderRows(rows, isJob); rowsKey = key; }
  const done = job?.rows.filter(r => r.status === 'done') || [];
  $('status').textContent = job ? job.status.replaceAll('_', ' ') : 'Ready';
  $('message').textContent = job?.message || 'Ready when you are';
  $('counter').textContent = `${done.length} / ${job?.rows.length || 0}`;
  $('progress').max = job?.rows.length || 1; $('progress').value = done.length;
  $('failed').textContent = job?.rows.filter(r => r.status === 'failed').length || 0;
  $('pages').textContent = done.reduce((sum, r) => sum + r.pages, 0);
  $('elapsed').textContent = formatTime((job?.elapsedMs || 0) + (busy && job?.activeSince ? Date.now() - job.activeSince : 0));
  $('next').textContent = busy && job.status === 'running' && job.nextAt > Date.now() ? `${Math.ceil((job.nextAt - Date.now()) / 1000)}s` : '—';
  $('destination').textContent = `Downloads / ${job?.folder || BillCore.folderName()}`;
  $('start').disabled = working || busy || !preview.length || !selected.size;
  $('pause').disabled = working || !busy || job?.status !== 'running';
  $('stop').disabled = $('pause').disabled;
  $('resume').disabled = working || busy || !job || job.status === 'completed';
  $('scan').disabled = $('add').disabled = working || busy;
  $('clear').disabled = working || busy || !job;
  $('selectAll').disabled = isJob;
  $('selectAll').checked = !!preview.length && selected.size === preview.length;
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
  current = await rpc({type: 'COMMAND', action: 'start', payload: {rows: preview.filter((_,i) => selected.has(i)), delay: $('delay').value}});
  preview = []; selected.clear();
});
for (const action of ['pause', 'stop', 'resume']) $(action).onclick = () => act(async () => {
  current = await rpc({type: 'COMMAND', action});
  if (action === 'resume') preview = [];
});
$('clear').onclick = () => act(async () => {
  if (!confirm('Delete this batch’s temporary PDF copies and saved progress? Files in Downloads will remain.')) return;
  current = await rpc({type: 'COMMAND', action: 'clear'});
});
$('folder').onclick = () => act(() => rpc({type: 'SHOW_FOLDER', id: current?.job?.lastDownloadId}));
$('selectAll').onchange = event => { selected.clear(); if (event.target.checked) preview.forEach((r,i) => { if (BillCore.canDownload(r)) selected.add(i); }); render(); };
$('minimize').onclick = () => act(async () => { const win = await chrome.windows.getCurrent(); await chrome.windows.update(win.id, {state: 'minimized'}); });
$('close').onclick = () => window.close();
async function refresh() {
  if (polling || working) return;
  polling = true;
  try { current = await rpc({type: 'COMMAND', action: 'state'}); render(); }
  catch(e) { error(e); }
  finally { polling = false; }
}
void refresh(); setInterval(refresh, 1000); setInterval(render, 250);

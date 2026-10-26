const dbReady = new Promise((resolve, reject) => {
  const request = indexedDB.open('bill-prints-download', 1);
  request.onupgradeneeded = () => { request.result.createObjectStore('state'); request.result.createObjectStore('pdfs'); };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
async function store(name, mode, operation) {
  const db = await dbReady;
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode), req = operation(tx.objectStore(name));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Local storage transaction aborted.'));
  });
}
let job, busy = false, aborter;
const ready = (async () => {
  job = await store('state', 'readonly', s => s.get('job'));
  if (job && ['running', 'merging'].includes(job.status)) {
    job.status = 'paused'; job.message = 'Browser restarted. Resume to continue from saved progress.';
    await persist();
  }
})();
async function persist() { await store('state', 'readwrite', s => s.put(job, 'job')); }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function rpc(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'Extension worker did not respond.');
  return response.data;
}
async function downloadDone(id) {
  for (;;) {
    const result = await rpc({type: 'DOWNLOAD_STATUS', id});
    if (result.state === 'complete') return;
    if (result.state === 'interrupted') throw new Error('Download interrupted: ' + (result.error || 'unknown error'));
    await sleep(500);
  }
}
async function saveBlob(blob, filename, remember) {
  const url = URL.createObjectURL(blob);
  try {
    const id = await rpc({type: 'SAVE', url, filename: `${job.folder}/${filename}`});
    job.lastDownloadId = id;
    remember(id);
    await persist();
    await downloadDone(id);
    return id;
  } finally { URL.revokeObjectURL(url); }
}
async function fetchPDF(row) {
  if (!row.url && row.viewRef) {
    row.url = await rpc({type: 'RESOLVE_VIEW', row});
    await persist();
    if (job.status !== 'running') throw new Error('Batch paused.');
  }
  if (!BillCore.allowedUrl(row.url)) throw new Error('View link is missing or points outside the supported billing portal.');
  aborter = new AbortController();
  const timer = setTimeout(() => aborter.abort(new Error('PDF request timed out after 120 seconds.')), 120000);
  try {
    const response = await fetch(row.url, {credentials: 'include', signal: aborter.signal});
    if (!response.ok) throw new Error(`Portal returned HTTP ${response.status}. Check your login.`);
    if (!BillCore.allowedUrl(response.url || row.url)) throw new Error('Portal redirected outside the allowed website.');
    const bytes = await response.arrayBuffer();
    if (!new TextDecoder().decode(bytes.slice(0, 1024)).includes('%PDF-')) {
      throw new Error('The portal returned a page instead of a PDF. Log in again, then Resume.');
    }
    return bytes;
  } finally { clearTimeout(timer); aborter = null; }
}
async function processRow(row) {
  let bytes = await store('pdfs', 'readonly', s => s.get(row.id));
  if (!bytes) {
    bytes = await fetchPDF(row);
    // Validate before download so login HTML and corrupt PDFs are never saved as bills.
    const pdf = await PDFLib.PDFDocument.load(bytes);
    row.pages = pdf.getPageCount();
    await store('pdfs', 'readwrite', s => s.put(bytes, row.id));
  }
  if (row.downloadId) {
    const status = await rpc({type: 'DOWNLOAD_STATUS', id: row.downloadId});
    if (status.state === 'in_progress') await downloadDone(row.downloadId);
    else if (status.state !== 'complete') row.downloadId = null;
  }
  if (!row.downloadId) await saveBlob(new Blob([bytes], {type: 'application/pdf'}), row.filename, id => { row.downloadId = id; });
  row.status = 'done'; row.error = '';
}
async function exportFiles() {
  const done = job.rows.filter(r => r.status === 'done');
  job.message = 'Writing locality CSV…'; await persist();
  if (!job.csvDone) {
    if (job.csvId) {
      try { await downloadDone(job.csvId); job.csvDone = true; } catch { job.csvId = null; }
    }
    if (!job.csvDone) {
      await saveBlob(new Blob([BillCore.csv(job)], {type: 'text/csv;charset=utf-8'}), 'Localities.csv', id => { job.csvId = id; });
      job.csvDone = true; await persist();
    }
  }
  if (job.status !== 'running' || !done.length) return;
  if (job.mergedId) {
    try { await downloadDone(job.mergedId); job.mergedDone = true; return; } catch { job.mergedId = null; }
  }
  job.message = `Merging ${done.length} PDFs…`; await persist();
  const merged = await PDFLib.PDFDocument.create();
  for (const row of done) {
    if (job.status !== 'running') return;
    const bytes = await store('pdfs', 'readonly', s => s.get(row.id));
    if (!bytes) throw new Error(`Temporary copy missing for ${row.locality}. Start a new batch to download it again.`);
    const source = await PDFLib.PDFDocument.load(bytes);
    for (const page of await merged.copyPages(source, source.getPageIndices())) merged.addPage(page);
    await sleep(0);
  }
  if (job.status !== 'running') return;
  const bytes = await merged.save();
  if (job.status !== 'running') return;
  job.totalPages = merged.getPageCount();
  await saveBlob(new Blob([bytes], {type: 'application/pdf'}), 'All Bills.pdf', id => { job.mergedId = id; });
  job.mergedDone = true; await persist();
}
async function run() {
  if (busy) return;
  busy = true;
  const since = Date.now();
  job.activeSince = since;
  try {
    for (const row of job.rows) {
      if (job.status !== 'running') break;
      if (row.status === 'done' || row.status === 'failed') continue;
      while (job.nextAt > Date.now() && job.status === 'running') await sleep(Math.min(250, job.nextAt - Date.now()));
      if (job.status !== 'running') break;
      row.status = 'fetching'; job.message = `Downloading ${row.locality}…`; await persist();
      try { await processRow(row); }
      catch (error) {
        if (job.status !== 'running' && !row.downloadId) row.status = 'pending';
        else { row.status = 'failed'; row.error = error.message; }
      }
      job.nextAt = Date.now() + job.delay * 1000; await persist();
    }
    if (job.status === 'running') {
      await exportFiles();
      if (job.status === 'running') {
        job.status = job.rows.some(r => r.status === 'failed') ? 'completed_with_errors' : 'completed';
        job.message = job.status === 'completed' ? 'All PDFs, locality CSV and merged PDF are saved.' : 'Batch finished with failures. Resume retries failed rows; the merge contains successful PDFs only.';
      }
    }
  } catch (error) { job.status = 'paused'; job.message = error.message; }
  finally { job.elapsedMs = (job.elapsedMs || 0) + Date.now() - since; job.activeSince = null; busy = false; await persist(); }
}
async function command(action, payload) {
  await ready;
  if (action === 'state') return {job, busy};
  if (action === 'start') {
    if (busy) throw new Error('Stop the current batch and wait for its active download to finish.');
    if (!payload?.rows?.length || payload.rows.some(r => !r.locality || !BillCore.canDownload(r))) throw new Error('Every selected row needs a valid locality and billing portal View link or action.');
    const delay = Number(payload.delay);
    if (!Number.isFinite(delay) || delay < 1 || delay > 300) throw new Error('Delay must be between 1 and 300 seconds.');
    await store('pdfs', 'readwrite', s => s.clear());
    job = {id: crypto.randomUUID(), folder: BillCore.folderName(), createdAt: Date.now(), delay, rows: BillCore.prepareRows(payload.rows), status: 'running', elapsedMs: 0, message: 'Starting…'};
    await persist(); void run();
  } else if (action === 'pause' || action === 'stop') {
    if (!job || !busy) throw new Error('No batch is currently running.');
    job.status = action === 'stop' ? 'stopped' : 'paused';
    job.message = `${action === 'stop' ? 'Stopped' : 'Paused'}. Any active disk download will finish. Progress is saved; use Resume to continue.`;
    aborter?.abort(); await persist();
  } else if (action === 'resume') {
    if (!job || busy) throw new Error('Wait for the active operation to finish before resuming.');
    if (job.status === 'completed') throw new Error('This batch is already complete.');
    const failed = job.rows.some(r => r.status === 'failed');
    for (const row of job.rows) if (row.status !== 'done') { row.status = 'pending'; row.error = ''; }
    if (failed) { job.csvDone = false; job.csvId = null; job.mergedDone = false; job.mergedId = null; }
    job.status = 'running'; job.message = 'Resuming…'; await persist(); void run();
  } else if (action === 'clear') {
    if (busy) throw new Error('Stop the batch and wait before clearing temporary data.');
    await store('pdfs', 'readwrite', s => s.clear());
    await store('state', 'readwrite', s => s.delete('job')); job = null;
  } else throw new Error('Unknown processor command.');
  return {job, busy};
}
// Serialize commands so two rapid clicks cannot start overlapping batches.
let commands = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message.target !== 'runner') return;
  commands = commands.then(() => command(message.action, message.payload))
    .then(data => reply({ok: true, data}), error => reply({ok: false, error: error.message}));
  return true;
});

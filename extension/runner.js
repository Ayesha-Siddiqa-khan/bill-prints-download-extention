const dbReady = new Promise((resolve, reject) => {
  const request = indexedDB.open('bill-prints-download', 1);
  request.onupgradeneeded = () => { request.result.createObjectStore('state'); request.result.createObjectStore('pdfs'); };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
async function store(name, mode, operation) {
  const db = await dbReady;
  return await new Promise((resolve, reject) => {
    // Checkpoints and cached PDFs should reach disk before acknowledging saved progress.
    const tx = db.transaction(name, mode, {durability: mode === 'readwrite' ? 'strict' : 'default'}), req = operation(tx.objectStore(name));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Local storage transaction aborted.'));
  });
}
let job, busy = false;
const aborters = new Map();
const ready = (async () => {
  job = await store('state', 'readonly', s => s.get('job'));
  if (job) {
    job.waitSeconds ??= 600;
    job.autoRetry ??= false;
    job.retryPass ??= 1;
    job.concurrency ??= 5;
  }
  if (job && ['running', 'merging'].includes(job.status)) {
    job.status = 'paused'; job.message = 'Browser restarted. Resume to continue from saved progress.';
    job.nextAt = null;
    job.fileDeadline = null;
    for (const row of job.rows) { if (row.status === 'fetching') row.status = 'pending'; row.deadline = null; }
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
async function downloadDone(id, deadline) {
  for (;;) {
    const result = await rpc({type: 'DOWNLOAD_STATUS', id});
    if (result.state === 'complete') return;
    if (result.state === 'interrupted') throw new Error('Download interrupted: ' + (result.error || 'unknown error'));
    if (deadline && Date.now() >= deadline) {
      await rpc({type: 'CANCEL_DOWNLOAD', id});
      throw new Error('File exceeded the wait limit. Cached PDF kept; skipped for a later retry.');
    }
    await sleep(500);
  }
}
async function saveBlob(blob, filename, remember, deadline) {
  const url = URL.createObjectURL(blob);
  try {
    const id = await rpc({type: 'SAVE', url, filename: `${job.folder}/${filename}`});
    job.lastDownloadId = id;
    remember(id);
    await persist();
    await downloadDone(id, deadline);
    return id;
  } finally { URL.revokeObjectURL(url); }
}
let resolvingView = false;
async function resolveView(row) {
  row.phase = 'waiting-view'; row.deadline = null;
  while (resolvingView && job.status === 'running' && !row.skipRequested) await sleep(100);
  if (job.status !== 'running' || row.skipRequested) throw new Error('File attempt interrupted.');
  resolvingView = true;
  row.phase = 'preparing'; row.deadline = Date.now() + job.waitSeconds * 1000;
  let result;
  try {
    // Only the brief View capture owns window.open; PDF transfers themselves run in parallel.
    result = await rpc({type: 'RESOLVE_VIEW', row, waitMs: Math.max(1, row.deadline - Date.now())});
    while (result.pending && job.status === 'running' && !row.skipRequested) {
      if (Date.now() >= row.deadline) throw new Error('File exceeded the wait limit. Skipped for a later retry.');
      await sleep(500);
      result = await rpc({type: 'RESOLVE_VIEW', row, action: 'poll'});
    }
    if (job.status !== 'running' || row.skipRequested) throw new Error('File attempt interrupted.');
    return result;
  } finally {
    if (result?.pending) await rpc({type: 'RESOLVE_VIEW', row, action: 'cancel'}).catch(() => {});
    resolvingView = false;
  }
}
async function fetchPDF(row) {
  if (job.status !== 'running' || row.skipRequested) throw new Error('File attempt interrupted.');
  if (!row.url && row.viewRef) {
    job.message = `Waiting for portal to prepare ${row.locality}…`; await persist();
    row.url = (await resolveView(row)).url;
    await persist();
    if (job.status !== 'running') throw new Error('Batch paused.');
  }
  if (!BillCore.allowedUrl(row.url)) throw new Error('View link is missing or points outside the supported billing portal.');
  if (job.status !== 'running' || row.skipRequested) throw new Error('File attempt interrupted.');
  const partialKey = `partial:${row.id}`;
  const partial = await store('pdfs', 'readonly', s => s.get(partialKey));
  if (partial?.url === row.url && partial.totalBytes > 0 && partial.blob.size === partial.totalBytes) return await partial.blob.arrayBuffer();
  const aborter = new AbortController();
  aborters.set(row.id, aborter);
  let timedOut = false;
  let chunks = [], plan, checkpoint, checkpointError, lastSaved = Date.now(), savedBytes = 0;
  const savePartial = () => {
    if (!plan || !chunks.length) return Promise.resolve();
    const blob = new Blob(chunks);
    chunks = [blob];
    savedBytes = blob.size; lastSaved = Date.now();
    return blob.slice(0, 1024).text().then(header => {
      if (!header.includes('%PDF-')) return;
      return store('pdfs', 'readwrite', s => s.put({url: row.url, blob, totalBytes: plan.totalBytes, validator: plan.validator, encoded: plan.encoded}, partialKey));
    });
  };
  const timer = setTimeout(() => {
    timedOut = true;
    aborter.abort(new Error('File exceeded the wait limit. Skipped for a later retry.'));
  }, Math.max(1, row.deadline - Date.now()));
  try {
    const response = await fetch(row.url, {credentials: 'include', signal: aborter.signal, headers: BillCore.resumeHeaders(partial, row.url)});
    if (!response.ok) throw new Error(`Portal returned HTTP ${response.status}. Check your login.`);
    if (!BillCore.allowedUrl(response.url || row.url)) throw new Error('Portal redirected outside the allowed website.');
    plan = BillCore.transferPlan(partial, row.url, response);
    chunks = plan.prefix ? [plan.prefix] : [];
    row.bytesReceived = plan.prefix?.size || 0;
    savedBytes = row.bytesReceived;
    row.totalBytes = plan.totalBytes;
    row.transferNote = plan.prefix ? `Resuming from ${(plan.prefix.size / 1048576).toFixed(1)} MB.` : partial?.blob?.size ? 'Portal could not safely resume this file; using its full response.' : '';
    row.phase = 'downloading';
    job.message = `Downloading ${row.locality}…`; await persist();
    const reader = response.body.getReader();
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      chunks.push(value); row.bytesReceived += value.byteLength;
      if (!checkpoint && (row.bytesReceived - savedBytes >= 8 * 1048576 || Date.now() - lastSaved > 5000)) {
        // Keep reading the network while the browser writes a checkpoint in the background.
        checkpoint = savePartial().then(() => persist()).catch(error => { checkpointError = error; }).finally(() => { checkpoint = null; });
      }
    }
    if (plan.totalBytes && row.bytesReceived !== plan.totalBytes) throw new TypeError('Connection ended before the complete PDF arrived.');
    const bytes = await new Blob(chunks).arrayBuffer();
    if (!new TextDecoder().decode(bytes.slice(0, 1024)).includes('%PDF-')) {
      throw new Error('The portal returned a page instead of a PDF. Log in again, then Resume.');
    }
    return bytes;
  } catch (error) {
    if (timedOut) throw new Error('File exceeded the wait limit. Skipped for a later retry.');
    error.waitForDeadline = error.name === 'TypeError' || error.name === 'NetworkError';
    throw error;
  } finally {
    clearTimeout(timer); aborters.delete(row.id);
    await checkpoint;
    if (chunks.length && row.bytesReceived > savedBytes) await savePartial();
    if (checkpointError) throw checkpointError;
  }
}
async function processRow(row) {
  let bytes = await store('pdfs', 'readonly', s => s.get(row.id));
  if (job.status !== 'running' || row.skipRequested) throw new Error('File attempt interrupted.');
  if (!bytes) {
    bytes = await fetchPDF(row);
    // Validate before download so login HTML and corrupt PDFs are never saved as bills.
    let pdf;
    try { pdf = await PDFLib.PDFDocument.load(bytes); }
    catch (error) { await store('pdfs', 'readwrite', s => s.delete(`partial:${row.id}`)); throw error; }
    row.pages = pdf.getPageCount();
    await store('pdfs', 'readwrite', s => s.put(bytes, row.id));
  } else if (!row.pages) {
    // A shutdown can happen after the PDF cache commits but before its page count does.
    row.pages = (await PDFLib.PDFDocument.load(bytes)).getPageCount();
  }
  await store('pdfs', 'readwrite', s => s.delete(`partial:${row.id}`));
  row.phase = 'saving';
  if (row.downloadId) {
    const status = await rpc({type: 'DOWNLOAD_STATUS', id: row.downloadId});
    if (status.state === 'in_progress') await downloadDone(row.downloadId, row.deadline);
    else if (status.state !== 'complete') row.downloadId = null;
  }
  if (row.skipRequested || job.status !== 'running') throw new Error('File attempt interrupted.');
  if (!row.downloadId) await saveBlob(new Blob([bytes], {type: 'application/pdf'}), row.filename, id => { row.downloadId = id; }, row.deadline);
  if (row.skipRequested) throw new Error('Skipped manually. Retry this file later.');
  row.status = 'done'; row.error = '';
  invalidateExports();
}
function invalidateExports() {
  job.csvDone = false; job.csvId = null; job.mergedDone = false; job.mergedId = null;
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
    let candidates = job.rows.filter(r => !['done', 'failed'].includes(r.status) && (!job.scopeIds || job.scopeIds.includes(r.id)));
    let automaticPass = false;
    for (;;) {
      let cursor = 0;
      const worker = async () => {
        while (job.status === 'running' && cursor < candidates.length && (!automaticPass || job.autoRetry)) {
          const row = candidates[cursor++];
          if (row.retryNotBefore > Date.now()) {
            row.phase = 'queued'; row.nextAt = row.retryNotBefore;
            job.message = `Waiting until the previous deadline before retrying ${row.locality}…`; await persist();
            while (row.retryNotBefore > Date.now() && job.status === 'running' && (!automaticPass || job.autoRetry)) await sleep(250);
            if (job.status !== 'running' || (automaticPass && !job.autoRetry)) break;
          }
          row.status = 'fetching'; row.skipRequested = false; row.attempts = (row.attempts || 0) + 1;
          row.phase = 'preparing'; row.error = ''; row.transferNote = ''; row.nextAt = null;
          row.bytesReceived = 0; row.totalBytes = 0;
          row.deadline = Date.now() + job.waitSeconds * 1000;
          job.message = `Downloading ${row.locality} (attempt ${row.attempts})…`; await persist();
          try { await processRow(row); }
          catch (error) {
            if (error.waitForDeadline && job.status === 'running' && !row.skipRequested && Date.now() < row.deadline) {
              row.phase = 'waiting'; row.error = error.message;
              job.message = `Connection interrupted for ${row.locality}. Keeping received data; no retry before its deadline.`;
              await persist();
              while (Date.now() < row.deadline && job.status === 'running' && !row.skipRequested) await sleep(250);
            }
            if (job.status !== 'running') row.status = 'pending';
            else { row.status = 'failed'; row.error = row.skipRequested ? 'Skipped manually. Retry this file later.' : error.message; }
            row.retryNotBefore = row.deadline;
          }
          row.skipRequested = false; row.deadline = null; await persist();
          const nextAt = Date.now() + job.delay * 1000;
          while (cursor < candidates.length && job.status === 'running' && Date.now() < nextAt) await sleep(100);
        }
      };
      const results = await Promise.allSettled(Array.from({length: Math.min(job.concurrency, candidates.length)}, () => worker().catch(error => {
        job.status = 'paused'; for (const controller of aborters.values()) controller.abort(); throw error;
      })));
      const rejected = results.find(r => r.status === 'rejected');
      if (rejected) throw rejected.reason;
      if (job.status !== 'running') break;
      const failed = job.rows.filter(r => r.status === 'failed' && (!job.scopeIds || job.scopeIds.includes(r.id)));
      if (!job.autoRetry || !failed.length) break;
      job.nextAt = Date.now() + Math.max(30, job.delay) * 1000;
      job.message = `${failed.length} files skipped. Waiting before retry pass ${job.retryPass + 1}…`; await persist();
      while (Date.now() < job.nextAt && job.status === 'running' && job.autoRetry) await sleep(250);
      if (job.status !== 'running' || !job.autoRetry) break;
      job.nextAt = null; job.retryPass++; candidates = failed; automaticPass = true;
      await persist();
    }
    if (job.status === 'running') {
      await exportFiles();
      if (job.status === 'running') {
        job.status = job.rows.some(r => r.status !== 'done') ? 'completed_with_errors' : 'completed';
        job.message = job.status === 'completed' ? 'All PDFs, locality CSV and merged PDF are saved.' : 'Some files remain. Use Resume / retry all or Retry on an individual row. The merge contains successful PDFs only.';
      }
    }
  } catch (error) { job.status = 'paused'; job.message = error.message; }
  finally { job.elapsedMs = (job.elapsedMs || 0) + Date.now() - since; job.activeSince = null; job.fileDeadline = null; job.nextAt = null; busy = false; await persist(); }
}
function settings(payload = {}) {
  const waitSeconds = Number(payload.waitSeconds ?? job?.waitSeconds ?? 600);
  if (!Number.isFinite(waitSeconds) || waitSeconds < 60 || waitSeconds > 7200) throw new Error('Wait limit must be between 1 and 120 minutes.');
  const concurrency = Number(payload.concurrency ?? job?.concurrency ?? 5);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 5) throw new Error('Parallel downloads must be between 1 and 5.');
  return {waitSeconds, concurrency, autoRetry: payload.autoRetry === undefined ? (job?.autoRetry ?? false) : payload.autoRetry === true};
}
async function command(action, payload) {
  await ready;
  if (action === 'state') return {job, busy};
  if (action === 'start') {
    if (busy) throw new Error('Stop the current batch and wait for its active download to finish.');
    if (!payload?.rows?.length || payload.rows.some(r => !r.locality || !BillCore.canDownload(r))) throw new Error('Every selected row needs a valid locality and billing portal View link or action.');
    const delay = Number(payload.delay);
    if (!Number.isFinite(delay) || delay < 1 || delay > 300) throw new Error('Delay must be between 1 and 300 seconds.');
    const options = settings(payload);
    await store('pdfs', 'readwrite', s => s.clear());
    job = {id: crypto.randomUUID(), folder: BillCore.folderName(), createdAt: Date.now(), delay, ...options, retryPass: 1, rows: BillCore.prepareRows(payload.rows), status: 'running', elapsedMs: 0, message: 'Starting…'};
    await persist(); void run();
  } else if (action === 'skip') {
    const row = job?.rows.find(r => r.status === 'fetching' && (payload?.id === undefined || r.id === payload.id));
    if (!busy || job.status !== 'running' || !row) throw new Error('No active PDF to skip.');
    row.skipRequested = true;
    aborters.get(row.id)?.abort();
    if (row.downloadId) {
      const status = await rpc({type: 'DOWNLOAD_STATUS', id: row.downloadId});
      if (status.state === 'in_progress') await rpc({type: 'CANCEL_DOWNLOAD', id: row.downloadId});
    }
    job.message = `Skipping ${row.locality}…`; await persist();
  } else if (action === 'pause' || action === 'stop') {
    if (!job || !busy) throw new Error('No batch is currently running.');
    job.status = action === 'stop' ? 'stopped' : 'paused';
    job.message = `${action === 'stop' ? 'Stopped' : 'Paused'}. Any active disk download will finish. Progress is saved; use Resume to continue.`;
    for (const controller of aborters.values()) controller.abort();
    await persist();
  } else if (action === 'settings') {
    if (!job) throw new Error('No saved batch.');
    Object.assign(job, settings(payload)); await persist();
  } else if (action === 'resume' || action === 'retry-one' || action === 'retry-selected') {
    if (!job || busy) throw new Error('Wait for the active operation to finish before resuming.');
    if (job.status === 'completed') throw new Error('This batch is already complete.');
    Object.assign(job, settings(payload));
    const row = action === 'retry-one' ? job.rows.find(r => r.id === payload?.id && r.status !== 'done') : null;
    if (action === 'retry-one' && !row) throw new Error('Choose an unfinished file. Completed files are already saved.');
    if (action === 'retry-selected' && (!Array.isArray(payload?.ids) || !payload.ids.length || payload.ids.some(id => !job.rows.some(r => r.id === id && r.status !== 'done')))) throw new Error('Select at least one unfinished file.');
    job.scopeIds = row ? [row.id] : action === 'retry-selected' ? [...new Set(payload.ids)] : null;
    for (const item of job.rows) if (item.status !== 'done' && (!job.scopeIds || job.scopeIds.includes(item.id))) { item.status = 'pending'; item.error = ''; item.retryNotBefore = null; }
    invalidateExports();
    job.nextAt = null;
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

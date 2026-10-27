(function (root) {
  const safeName = (value) => {
    let name = String(value || 'Unnamed locality').normalize('NFC')
      .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/\s+/g, ' ').trim()
      .replace(/^[. ]+|[. ]+$/g, '').slice(0, 120).replace(/[. ]+$/g, '');
    if (!name) name = 'Unnamed locality';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
    return name;
  };
  function folderName(date = new Date()) {
    return [date.getDate(), date.getMonth() + 1, date.getFullYear() % 100]
      .map(n => String(n).padStart(2, '0')).join('') + ' Bill Prints Download';
  }
  function prepareRows(rows) {
    const used = new Set(['all bills.pdf']);
    return rows.map((row, index) => {
      const base = safeName(row.locality);
      let name = base + '.pdf', suffix = 2;
      while (used.has(name.toLowerCase())) name = `${base} (${suffix++}).pdf`;
      used.add(name.toLowerCase());
      return {...row, id: index, filename: name, status: 'pending', error: '', pages: 0};
    });
  }
  function csv(job) {
    const cell = value => {
      let text = String(value ?? '');
      // Prevent spreadsheet formulas when a locality begins with a formula prefix.
      if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
      return '"' + text.replace(/"/g, '""') + '"';
    };
    const rows = [['No.', 'Locality', 'Sector', 'File Number', 'Bill Count', 'PDF Filename', 'Status', 'Pages', 'Error'],
      ...job.rows.map((r, i) => [i + 1, r.locality, r.sector, r.fileNumber, r.billCount, r.filename, r.status, r.pages, r.error])];
    return '\ufeff' + rows.map(r => r.map(cell).join(',')).join('\r\n');
  }
  function allowedUrl(value) {
    try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'elgcd.punjab.gov.pk' && !url.username && !url.password; }
    catch { return false; }
  }
  const canDownload = row => allowedUrl(row.url) || (!row.url && Number.isInteger(row.viewRef?.tabId) && allowedUrl(row.viewRef.pageUrl) && typeof row.viewRef.token === 'string');
  function resumeHeaders(partial, url) {
    return partial?.url === url && partial.blob?.size > 0 && partial.validator && !partial.encoded
      ? {Range: `bytes=${partial.blob.size}-`, 'If-Range': partial.validator} : {};
  }
  function transferPlan(partial, url, response) {
    const encoded = !!response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity';
    const etag = response.headers.get('etag');
    const modified = response.headers.get('last-modified');
    const validator = etag?.startsWith('"') ? etag : (modified && Number.isFinite(Date.parse(modified)) ? modified : null);
    const plan = {prefix: null, encoded, validator: encoded ? null : validator, totalBytes: encoded ? 0 : Number(response.headers.get('content-length')) || 0};
    if (response.status === 206) {
      const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
      const offset = resumeHeaders(partial, url).Range ? partial.blob.size : 0;
      const returnedValidator = offset && partial.validator.startsWith('"') ? etag : modified;
      if (!range || encoded || Number(range[1]) !== offset || Number(range[2]) < offset || Number(range[2]) >= Number(range[3]) ||
          (offset && partial.totalBytes && partial.totalBytes !== Number(range[3])) ||
          (offset && returnedValidator && returnedValidator !== partial.validator)) throw new Error('Portal returned an inconsistent byte range. Partial data was kept; retry later.');
      plan.prefix = offset ? partial.blob : null;
      plan.totalBytes = Number(range[3]);
      if (offset) plan.validator = partial.validator;
    }
    // A 200 response means Range was ignored or the file changed: use this full response alone.
    return plan;
  }
  const api = {safeName, folderName, prepareRows, csv, allowedUrl, canDownload, resumeHeaders, transferPlan};
  root.BillCore = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);

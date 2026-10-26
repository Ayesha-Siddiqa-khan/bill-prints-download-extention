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
  const api = {safeName, folderName, prepareRows, csv, allowedUrl, canDownload};
  root.BillCore = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);

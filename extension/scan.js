// Runs in the page's main world so DataTables' loaded rows are available.
function scanBillTable() {
  const clean = text => String(text || '').replace(/\s+/g, ' ').trim();
  for (const table of document.querySelectorAll('table')) {
    const headers = [...table.querySelectorAll('thead th')].map(el => clean(el.textContent).toLowerCase());
    if (!headers.includes('locality')) continue;
    let nodes = [...table.querySelectorAll('tbody tr')], serverSide = false, paginationWarning = '';
    try {
      if (window.jQuery?.fn?.dataTable?.isDataTable(table)) {
        const dt = window.jQuery(table).DataTable();
        serverSide = !!dt.settings()[0].oFeatures.bServerSide;
        if (!serverSide) nodes = dt.rows({search: 'applied', order: 'applied', page: 'all'}).indexes().toArray().map(index => {
          const existing = dt.row(index).node();
          if (existing) return existing;
          // Deferred rows have data but no DOM nodes until their page is displayed.
          const tr = document.createElement('tr');
          for (let column = 0; column < headers.length; column++) {
            const td = document.createElement('td'), value = dt.cell(index, column).render('display');
            if (value?.nodeType) td.append(value.cloneNode(true));
            else td.innerHTML = String(value ?? '');
            tr.append(td);
          }
          return tr;
        });
      }
    } catch { paginationWarning = 'Could not read all DataTables rows. Add each visible list page before starting.'; }
    const result = [];
    for (const tr of nodes) {
      const cells = [...tr.querySelectorAll('td')];
      const locality = clean(cells[headers.indexOf('locality')]?.textContent);
      const view = [...tr.querySelectorAll('a,button,input[type=button],[role=button]')].find(el => /^view$/i.test(clean(el.textContent || el.value)));
      if (!view || !locality) continue;
      let raw = view.getAttribute('href');
      if (!raw || /^(#|javascript:)/i.test(raw)) {
        raw = view.getAttribute('data-url') || view.getAttribute('data-href');
        if (!raw) {
          const onclick = view.getAttribute('onclick') || '';
          raw = onclick.match(/(?:window\.)?open\s*\(\s*['"]([^'"]+)['"]/)?.[1]
            || onclick.match(/(?:location(?:\.href)?)\s*=\s*['"]([^'"]+)['"]/)?.[1];
        }
      }
      let url = '';
      try { if (raw) url = new URL(raw, document.baseURI).href; } catch { /* Report unresolved links in the preview. */ }
      const at = header => clean(cells[headers.indexOf(header)]?.textContent);
      const token = view.getAttribute('data-bpd-view-id') || crypto.randomUUID();
      view.setAttribute('data-bpd-view-id', token);
      result.push({locality, url, sector: at('sector'), fileNumber: at('file number'), billCount: at('bill count'),
        viewRef: view.isConnected ? {token, pageUrl: location.href} : null});
    }
    const info = table.closest('.dataTables_wrapper, .dt-container')?.querySelector('.dataTables_info, .dt-info')?.textContent || '';
    return {rows: result, serverSide, info: clean(info), paginationWarning, pageUrl: location.href};
  }
  throw new Error('No bill table with a Locality column was found. Open Water Print Bills and show the list first.');
}

// Framework event listeners (including Angular's click bindings) have no href/onclick to parse.
async function resolveBillView(row) {
  try {
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  let view = [...document.querySelectorAll('[data-bpd-view-id]')]
    .find(el => el.getAttribute('data-bpd-view-id') === row.viewRef.token);
  if (!view) {
    const matches = [];
    for (const table of document.querySelectorAll('table')) {
      const headers = [...table.querySelectorAll('thead th')].map(el => clean(el.textContent).toLowerCase());
      if (!headers.includes('locality')) continue;
      for (const tr of table.querySelectorAll('tbody tr')) {
        const cells = [...tr.querySelectorAll('td')];
        const at = key => clean(cells[headers.indexOf(key)]?.textContent);
        if (at('locality') !== row.locality || at('sector') !== row.sector || at('file number') !== row.fileNumber || at('bill count') !== row.billCount) continue;
        const candidate = [...tr.querySelectorAll('a,button,input[type=button],[role=button]')].find(el => /^view$/i.test(clean(el.textContent || el.value)));
        if (candidate) matches.push(candidate);
      }
    }
    if (matches.length === 1) view = matches[0];
  }
  if (!view?.isConnected) throw new Error('The locality View button is no longer on the billing page. Display its list page again, then Resume.');
  const originalOpen = window.open;
  let timer, capture, rejectCapture;
  const result = new Promise((resolve, reject) => { capture = resolve; rejectCapture = reject; });
  const record = value => {
    if (!value || value === 'about:blank') return;
    try {
      const url = new URL(String(value), document.baseURI);
      if (url.protocol !== 'https:' || url.hostname !== 'elgcd.punjab.gov.pk' || url.username || url.password) throw new Error('View opened an unsupported PDF address.');
      capture(url.href);
    } catch (error) { rejectCapture(error); }
  };
  const locationProxy = {assign: record, replace: record};
  Object.defineProperty(locationProxy, 'href', {set: record, get: () => 'about:blank'});
  const popup = {close() {}, focus() {}, closed: false};
  Object.defineProperty(popup, 'location', {get: () => locationProxy, set: record});
  const interceptOpen = value => { record(value); return popup; };
  const interceptAnchor = event => {
    const anchor = event.target.closest?.('a[href]');
    const href = anchor?.getAttribute('href');
    if (href?.startsWith('#')) { event.preventDefault(); return; }
    if (!href || /^javascript:/i.test(href)) return;
    event.preventDefault(); event.stopImmediatePropagation(); record(anchor.href);
  };
  try {
    window.open = interceptOpen;
    document.addEventListener('click', interceptAnchor, true);
    timer = setTimeout(() => rejectCapture(new Error('View did not open a PDF within 15 seconds. Keep the billing list open and try Resume.')), 15000);
    view.click();
    return {url: await result};
  } finally {
    clearTimeout(timer);
    if (window.open === interceptOpen) window.open = originalOpen;
    document.removeEventListener('click', interceptAnchor, true);
  }
  } catch (error) { return {error: error.message}; }
}

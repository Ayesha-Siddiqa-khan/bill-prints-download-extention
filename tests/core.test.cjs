const {test} = require('node:test');
const assert = require('node:assert/strict');
const core = require('../extension/core.js');
test('folder format uses the local date and padded DDMMYY', () => {
  assert.equal(core.folderName(new Date(2026, 0, 5)), '050126 Bill Prints Download');
});
test('filenames avoid Windows reserved names, traversal, illegal characters and collisions', () => {
  assert.equal(core.safeName('../CON'), '_CON');
  assert.equal(core.safeName('NUL'), '_NUL');
  assert.equal(core.safeName('A/B: C?'), 'A_B_ C_');
  const rows = core.prepareRows(['Market','market','All Bills','Market (2)'].map(locality => ({locality})));
  assert.deepEqual(rows.map(r => r.filename), ['Market.pdf','market (2).pdf','All Bills (2).pdf','Market (2) (2).pdf']);
  assert.ok(core.safeName('a'.repeat(200)).length <= 120);
});
test('CSV escapes quotes and line breaks, includes locality names, and neutralizes formulas', () => {
  const csv = core.csv({rows:[{locality:'Market, "A"\nBlock',sector:'=CMD()',status:'done',pages:2}]});
  assert.ok(csv.startsWith('\ufeff')); assert.ok(csv.includes('"Market, ""A""\nBlock"')); assert.ok(csv.includes('"\'=CMD()"'));
});
test('PDF links are limited to the authenticated billing host', () => {
  assert.ok(core.allowedUrl('https://elgcd.punjab.gov.pk/utils/viewAttachments.php?file=a.pdf'));
  for(const url of ['http://elgcd.punjab.gov.pk/a','https://elgcd.punjab.gov.pk.evil.com/a','javascript:alert(1)','https://x:y@elgcd.punjab.gov.pk/a']) assert.equal(core.allowedUrl(url),false);
});
test('dynamic View actions are selectable only with a reference to the billing portal', () => {
  const row = {url:'',viewRef:{tabId:12,token:'test-token',pageUrl:'https://elgcd.punjab.gov.pk/e-billing/water-bills-print'}};
  assert.equal(core.canDownload(row),true);
  assert.equal(core.canDownload({...row,url:'https://evil.example/bill.pdf'}),false);
  assert.equal(core.canDownload({...row,viewRef:{...row.viewRef,pageUrl:'https://evil.example'}}),false);
  assert.equal(core.canDownload({url:''}),false);
});

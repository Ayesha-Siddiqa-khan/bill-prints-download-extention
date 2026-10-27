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
test('partial downloads use a conditional range only for the same unencoded PDF with a validator', () => {
  const url='https://elgcd.punjab.gov.pk/bill.pdf', partial={url,blob:new Blob(['%PDF-12345']),validator:'"v1"',totalBytes:20};
  assert.deepEqual(core.resumeHeaders(partial,url),{Range:'bytes=10-','If-Range':'"v1"'});
  assert.deepEqual(core.resumeHeaders({...partial,validator:null},url),{});
  assert.deepEqual(core.resumeHeaders({...partial,encoded:true},url),{});
  assert.deepEqual(core.resumeHeaders(partial,url+'?other'),{});
  const response=(status,headers)=>({status,headers:new Headers(headers)});
  const plan=core.transferPlan(partial,url,response(206,{'content-range':'bytes 10-19/20',etag:'"v1"'}));
  assert.equal(plan.prefix,partial.blob);assert.equal(plan.totalBytes,20);
  assert.throws(()=>core.transferPlan(partial,url,response(206,{'content-range':'bytes 9-19/20'})),/inconsistent/);
  assert.throws(()=>core.transferPlan(partial,url,response(206,{'content-range':'bytes 10-19/20',etag:'"v2"'})),/inconsistent/);
  const ignored=core.transferPlan(partial,url,response(200,{'content-length':'25',etag:'"v2"'}));
  assert.equal(ignored.prefix,null);assert.equal(ignored.totalBytes,25);assert.equal(ignored.validator,'"v2"');
  const compressed=core.transferPlan(partial,url,response(200,{'content-length':'10','content-encoding':'gzip',etag:'"v1"'}));
  assert.equal(compressed.validator,null);assert.equal(compressed.totalBytes,0);
});

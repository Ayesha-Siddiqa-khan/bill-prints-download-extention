const { chromium } = require('playwright');
const { PDFDocument } = require('pdf-lib');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const root = path.resolve(__dirname,'..');
const artifacts = path.join(__dirname,'artifacts');
const wait = ms => new Promise(resolve => setTimeout(resolve,ms));
async function until(fn, description, timeout = 45000) {
  const end = Date.now()+timeout;
  while(Date.now()<end) { const value = await fn(); if(value) return value; await wait(150); }
  throw new Error('Timed out: '+description);
}
(async()=>{
  await fs.mkdir(artifacts,{recursive:true});
  const profile = await fs.mkdtemp(path.join(os.tmpdir(),'bill-extension-test-'));
  await fs.mkdir(path.join(profile,'Default'),{recursive:true});
  await fs.writeFile(path.join(profile,'Default','Preferences'),JSON.stringify({download:{default_directory:path.join(artifacts,'downloads'),prompt_for_download:false}}));
  const pdfs = {};
  for (const [name,count] of [['one.pdf',2],['two.pdf',1],['three.pdf',1]]) {
    const pdf = await PDFDocument.create();
    for(let i=0;i<count;i++) pdf.addPage().drawText(name+' page '+(i+1));
    pdfs[name] = Buffer.from(await pdf.save());
  }
  let context, panel, worker, extensionId, loginPage = false, slowFile = false, transferMode = null, parallelMode = false;
  const rangeRequests = [];
  let parallelActive=0, parallelPeak=0;
  const parallelEvents=[];
  const unavailableFiles = new Set();
  const requests = {};
  const server = https.createServer({key:await fs.readFile(path.join(__dirname,'localhost-key.pem')),cert:await fs.readFile(path.join(__dirname,'localhost-cert.pem'))},async(req,res)=>{
    const url = new URL(req.url,'https://elgcd.punjab.gov.pk');
    if(url.pathname.includes('viewAttachments')) {
      const name = url.searchParams.get('file'); requests[name] = (requests[name] || 0) + 1;
      if (parallelMode) {
        const slot=Number(url.searchParams.get('slot'));
        parallelActive++;parallelPeak=Math.max(parallelPeak,parallelActive);parallelEvents.push({slot,event:'start',at:Date.now()});
        res.writeHead(200,{'Content-Type':'application/pdf','Content-Length':pdfs[name].length,'Cache-Control':'no-store'});res.write(pdfs[name].subarray(0,20));
        const timer=setTimeout(()=>res.end(pdfs[name].subarray(20)),slot===0?12000:5000);
        res.on('close',()=>{clearTimeout(timer);parallelActive--;parallelEvents.push({slot,event:'end',at:Date.now()});});return;
      }
      if (transferMode && name === 'one.pdf') {
        rangeRequests.push({range:req.headers.range,validator:req.headers['if-range'],at:Date.now()});
        const bytes=pdfs[name], headers={'Content-Type':'application/pdf','Content-Length':bytes.length,ETag:'"fixture-v1"','Accept-Ranges':'bytes','Cache-Control':'no-store'};
        if(transferMode==='drop') {
          res.writeHead(200,headers);res.write(bytes.subarray(0,Math.floor(bytes.length/2)));
          const timer=setTimeout(()=>res.destroy(),1500);res.on('close',()=>clearTimeout(timer));return;
        }
        if(transferMode==='healthy'&&req.headers.range&&req.headers['if-range']==='"fixture-v1"') {
          const offset=Number(req.headers.range.match(/bytes=(\d+)-/)[1]);
          res.writeHead(206,{...headers,'Content-Length':bytes.length-offset,'Content-Range':`bytes ${offset}-${bytes.length-1}/${bytes.length}`});res.end(bytes.subarray(offset));return;
        }
        res.writeHead(200,headers);res.end(bytes);return;
      }
      if (slowFile && name === 'one.pdf') {
        const timer=setTimeout(()=>{res.writeHead(200,{'Content-Type':'application/pdf'});res.end(pdfs[name]);},65000);
        res.on('close',()=>clearTimeout(timer));return;
      }
      if(unavailableFiles.has(name)) {res.writeHead(503);res.end('Temporarily busy');return;}
      if(!req.headers.cookie?.includes('billing_session=fixture-test') || (loginPage && url.searchParams.get('file')==='three.pdf')) {res.writeHead(200,{'Content-Type':'text/html'});res.end('<h1>Please log in</h1>');}
      else {res.writeHead(200,{'Content-Type':'application/pdf'});res.end(pdfs[url.searchParams.get('file')]);}
    } else {res.writeHead(200,{'Content-Type':'text/html'});res.end(await fs.readFile(path.join(__dirname,'fixture.html'),'utf8'));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port = server.address().port;
  const launch = async()=>{
    context = await chromium.launchPersistentContext(profile, {headless:true,channel:'chromium',executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,acceptDownloads:true,
      downloadsPath:path.join(artifacts,'downloads'),args:[`--disable-extensions-except=${path.join(root,'extension')}`,`--load-extension=${path.join(root,'extension')}`,
        '--ignore-certificate-errors','--no-proxy-server',`--host-resolver-rules=MAP elgcd.punjab.gov.pk 127.0.0.1:${port}`]});
    const cdp = await context.browser().newBrowserCDPSession();
    await cdp.send('Browser.setDownloadBehavior',{behavior:'default',eventsEnabled:true});
    await context.addCookies([{name:'billing_session',value:'fixture-test',domain:'elgcd.punjab.gov.pk',path:'/',httpOnly:true,secure:true,sameSite:'Lax'}]);
    worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    extensionId = new URL(worker.url()).host;
    panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    await panel.waitForFunction(()=>document.getElementById('status').textContent!=='');
  };
  const command = async(action,payload)=>{
    const result=await panel.evaluate(async({action,payload})=>await chrome.runtime.sendMessage({type:'COMMAND',action,payload}),{action,payload});
    assert.equal(result.ok,true,result.error);return result.data;
  };
  const state=()=>command('state');
  try {
    await launch();
    const page = await context.newPage(); await page.goto('https://elgcd.punjab.gov.pk/e-billing/water-bills-print');
    const sourceTabId = await worker.evaluate(async()=> (await chrome.tabs.query({url:'https://elgcd.punjab.gov.pk/*'}))[0].id);
    await worker.evaluate(id=>chrome.storage.local.set({sourceTabId:id}),sourceTabId);
    await panel.getByRole('button',{name:'Scan billing page'}).click();
    await panel.waitForFunction(()=>document.querySelectorAll('#rows tr').length===3);
    assert.match(await panel.locator('#rows').innerText(),/PETROL PUMPs \(2\).pdf/);
    await page.evaluate(()=>{
      const nodes=[...document.querySelectorAll('tbody tr')];
      const dt={settings:()=>[{oFeatures:{bServerSide:false}}],rows:()=>({indexes:()=>({toArray:()=>[0,1,2,3]})}),
        row:index=>({node:()=>nodes[index]}),cell:(index,column)=>({render:()=>['4','COMMERCIAL','Deferred locality','1','1','<a href="/utils/viewAttachments.php?file=three.pdf">View</a>'][column]})};
      window.jQuery=()=>({DataTable:()=>dt});window.jQuery.fn={dataTable:{isDataTable:()=>true}};
    });
    await panel.getByRole('button',{name:'Scan billing page'}).click();
    await panel.waitForFunction(()=>document.querySelectorAll('#rows tr').length===4);
    assert.match(await panel.locator('#rows').innerText(),/Deferred locality/);
    await page.evaluate(()=>{delete window.jQuery});
    await panel.getByRole('button',{name:'Scan billing page'}).click();
    await panel.waitForFunction(()=>document.querySelectorAll('#rows tr').length===3);
    await panel.locator('#delay').fill('2');
    await panel.locator('#parallelDownloads').selectOption('1');
    await panel.screenshot({path:path.join(artifacts,'queue-preview.png'),fullPage:true});
    await panel.getByRole('button',{name:'Start download'}).click();
    await until(async()=>{const s=await state(); return s.job?.rows[0].status==='done';},'first PDF download');
    await command('pause');
    await until(async()=>!(await state()).busy,'pause settled');
    let s=await state();assert.equal(s.job.status,'paused');assert.ok(s.job.rows.filter(r=>r.status==='done').length<3);
    await context.close();
    await launch();
    s=await state();assert.equal(s.job.status,'paused');assert.equal(s.job.rows[0].status,'done');
    await command('resume');
    s=await until(async()=>{const s=await state();return !s.busy&&s.job.status==='completed'?s:false;},'resume and merge');
    assert.equal(s.job.rows.length,3);assert.equal(s.job.totalPages,4);assert.ok(s.job.csvDone&&s.job.mergedDone);
    const cached = await panel.evaluate(async()=>{
      const db=await new Promise((res,rej)=>{const r=indexedDB.open('bill-prints-download',1);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
      return await new Promise((res,rej)=>{const r=db.transaction('pdfs').objectStore('pdfs').getAll();r.onsuccess=()=>res(r.result.map(b=>b.byteLength));r.onerror=()=>rej(r.error)});
    });assert.equal(cached.length,3);assert.ok(cached.every(n=>n>100));
    const downloads = await worker.evaluate(()=>chrome.downloads.search({}));
    assert.equal(downloads.filter(d=>d.state==='complete').length,5);
    const mergedDownload = downloads.find(d=>/All Bills(?: \(\d+\))?\.pdf$/.test(d.filename));
    assert.ok(mergedDownload,JSON.stringify(downloads));
    assert.equal((await PDFDocument.load(await fs.readFile(mergedDownload.filename))).getPageCount(),4);
    const csvDownload = downloads.find(d=>/Localities(?: \(\d+\))?\.csv$/.test(d.filename));
    assert.match(await fs.readFile(csvDownload.filename,'utf8'),/PETROL PUMPs/);
    await panel.screenshot({path:path.join(artifacts,'completed-batch.png'),fullPage:true});
    console.log('PASS: actual MV3 extension scans href/onclick, downloads three PDFs, preserves duplicate names, pauses, survives browser restart, resumes, exports CSV and merges four pages.');
    const rows=s.job.rows.map(({locality,url,sector,fileNumber,billCount})=>({locality,url,sector,fileNumber,billCount}));
    loginPage=true;await command('start',{rows,delay:1});
    s=await until(async()=>{const s=await state();return !s.busy&&s.job.status==='completed_with_errors'?s:false;},'login HTML failure and partial merge');
    assert.equal(s.job.rows[2].status,'failed');assert.match(s.job.rows[2].error,/instead of a PDF/);assert.equal(s.job.totalPages,3);
    loginPage=false;await command('resume');
    s=await until(async()=>{const s=await state();return !s.busy&&s.job.status==='completed'?s:false;},'retry failed row');
    assert.equal(s.job.totalPages,4);
    console.log('PASS: login HTML rejected, failures reported, successful PDFs merged, retry produces complete merge.');
    await command('start',{rows,delay:5});
    await until(async()=>(await state()).job.rows[0].status==='done','stop test first PDF');
    await command('stop');await until(async()=>!(await state()).busy,'stop settled');
    assert.equal((await state()).job.status,'stopped');
    await command('clear');assert.equal((await state()).job,null);
    assert.equal(await panel.evaluate(async()=>{
      const db=await new Promise(res=>{const r=indexedDB.open('bill-prints-download',1);r.onsuccess=()=>res(r.result)});
      return await new Promise(res=>{const r=db.transaction('pdfs').objectStore('pdfs').count();r.onsuccess=()=>res(r.result)});
    }),0);
    console.log('PASS: Stop preserves progress, Clear removes temporary PDFs and saved job.');
    const dynamicPage=await context.newPage();
    await dynamicPage.goto('https://elgcd.punjab.gov.pk/e-billing/water-bills-print');
    const dynamicTabId=await worker.evaluate(async()=> (await chrome.tabs.query({url:'https://elgcd.punjab.gov.pk/*'})).find(t=>t.active).id);
    await worker.evaluate(id=>chrome.storage.local.set({sourceTabId:id}),dynamicTabId);
    await dynamicPage.evaluate(()=>{
      document.querySelectorAll('tbody a').forEach((link,index)=>{
        link.removeAttribute('href');link.removeAttribute('onclick');
        if(index===0) link.setAttribute('href','#');
        if(index===1) link.setAttribute('href','javascript:void(0)');
        link.addEventListener('click',()=>{
          const url='/utils/viewAttachments.php?file='+['one.pdf','two.pdf','three.pdf'][index];
          if(index===0) window.open(url,'_blank');
          else if(index===1) setTimeout(()=>window.open(url,'_blank'),50);
          else {const popup=window.open('','_blank');setTimeout(()=>{popup.location.href=url},50);}
        });
      });
      window.testOriginalOpen=window.open;
    });
    await panel.getByRole('button',{name:'Scan billing page'}).click();
    await panel.waitForFunction(()=>document.querySelectorAll('#rows tr').length===3);
    assert.equal(await panel.locator('#rows input:checked').count(),3);
    assert.match(await panel.locator('#rows').innerText(),/View action ready/);
    // Rescanned/reloaded tables may recreate nodes and lose our temporary tokens.
    await dynamicPage.evaluate(()=>document.querySelectorAll('[data-bpd-view-id]').forEach(el=>el.removeAttribute('data-bpd-view-id')));
    await panel.locator('#delay').fill('1');
    await panel.screenshot({path:path.join(artifacts,'dynamic-view-queue.png'),fullPage:true});
    await panel.getByRole('button',{name:'Start download'}).click();
    s=await until(async()=>{const s=await state();return !s.busy&&['completed','completed_with_errors'].includes(s.job?.status)?s:false;},'dynamic View actions');
    assert.equal(s.job.status,'completed',JSON.stringify(s.job.rows));
    assert.equal(s.job.totalPages,4);
    assert.ok(s.job.rows.every(row=>row.url.startsWith('https://elgcd.punjab.gov.pk/utils/viewAttachments.php')));
    assert.equal(await dynamicPage.evaluate(()=>window.open===window.testOriginalOpen),true);
    assert.equal(context.pages().filter(p=>p.url().includes('viewAttachments')).length,0);
    console.log('PASS: event-listener-only View buttons are selectable; synchronous, asynchronous and blank-popup location actions resolve, download and merge; window.open restored; no PDF tabs left open.');
    // Verify the old 15-second View limit no longer applies, using the real browser.
    if (!process.env.BILL_TEST_FAST && !process.env.BILL_TEST_TRANSFER_ONLY) {
    await dynamicPage.evaluate(()=>{
      const link=document.querySelector('tbody a');
      link.replaceWith(link.cloneNode(true));
      document.querySelector('tbody a').addEventListener('click',()=>setTimeout(()=>window.open('/utils/viewAttachments.php?file=one.pdf'),16000));
    });
    const delayedScan=await panel.evaluate(()=>chrome.runtime.sendMessage({type:'SCAN'}));
    await command('start',{rows:[delayedScan.data.rows[0]],delay:1,waitSeconds:60,autoRetry:false});
    s=await until(async()=>{const s=await state();return !s.busy&&s.job?.status==='completed'?s:false;},'View delayed beyond 15 seconds');
    assert.equal(s.job.totalPages,2);
    console.log('PASS: View address arriving after 16 seconds is captured and downloaded.');
    }
    unavailableFiles.add('one.pdf'); unavailableFiles.add('two.pdf');
    await command('start',{rows,delay:1,waitSeconds:60,autoRetry:false});
    s=await until(async()=>{const s=await state();return !s.busy&&s.job?.status==='completed_with_errors'?s:false;},'multiple failed rows');
    assert.deepEqual(s.job.rows.map(r=>r.status),['failed','failed','done']);
    unavailableFiles.delete('one.pdf');
    await until(async()=>await panel.locator('#rows button').count()===2,'individual retry controls');
    await panel.getByRole('button',{name:'Retry PETROL PUMPs file 1',exact:true}).click();
    s=await until(async()=>{const s=await state();return !s.busy&&s.job.rows[0].status==='done'?s:false;},'individual retry');
    assert.deepEqual(s.job.rows.map(r=>r.status),['done','failed','done']);
    assert.equal(s.job.rows[1].attempts,1);assert.equal(s.job.rows[2].attempts,1);assert.equal(s.job.totalPages,3);
    console.log('PASS: per-row Retry downloads only the selected file and refreshes the merge; other failed and completed files are untouched.');
    // Leave two.pdf unavailable for the first pass, then recover during the cooldown.
    if (!process.env.BILL_TEST_FAST && !process.env.BILL_TEST_TRANSFER_ONLY) {
    await command('start',{rows,delay:1,waitSeconds:60,autoRetry:true});
    s=await until(async()=>{const s=await state();return s.busy&&s.job.message.includes('Waiting before retry pass')?s:false;},'auto retry cooldown');
    assert.equal(s.job.rows[1].status,'failed');
    assert.equal(s.job.waitSeconds,60);assert.equal(s.job.autoRetry,true);
    unavailableFiles.clear();
    s=await until(async()=>{const s=await state();return !s.busy&&s.job.status==='completed'?s:false;},'auto retry completion',80000);
    assert.equal(s.job.retryPass,2);assert.deepEqual(s.job.rows.map(r=>r.attempts),[1,2,1]);
    console.log('PASS: auto retry waits 30 seconds, retries failed files only, and stops automatically after the batch completes.');
    }
    unavailableFiles.clear();
    if (!process.env.BILL_TEST_FAST && !process.env.BILL_TEST_TRANSFER_ONLY) {
    slowFile=true;
    console.log('Testing a 60-second file timeout and skip-to-next behavior…');
    await command('start',{rows,delay:1,waitSeconds:60,autoRetry:false});
    s=await until(async()=>{const s=await state();return !s.busy&&s.job.status==='completed_with_errors'?s:false;},'heavy PDF wait limit',80000);
    assert.deepEqual(s.job.rows.map(r=>r.status),['failed','done','done']);
    assert.match(s.job.rows[0].error,/wait limit/);
    slowFile=false;
    const beforeRetry={...requests};
    await command('retry-one',{id:0,waitSeconds:600,autoRetry:false});
    s=await until(async()=>{const s=await state();return !s.busy&&s.job.status==='completed'?s:false;},'retry heavy PDF');
    assert.equal(s.job.totalPages,4);assert.equal(requests['two.pdf'],beforeRetry['two.pdf']);assert.equal(requests['three.pdf'],beforeRetry['three.pdf']);
    console.log('PASS: file waits the configured full minute, times out, moves to remaining files, and can later be resumed on its own without redownloading completed files.');
    }
    slowFile=true;
    await command('start',{rows,delay:1,waitSeconds:600,autoRetry:false});
    await until(async()=>{const s=await state();return s.job.rows[0].status==='fetching';},'manual skip active file');
    await panel.getByRole('button',{name:'Skip current file'}).click();
    s=await until(async()=>{const s=await state();return !s.busy&&s.job.status==='completed_with_errors'?s:false;},'manual skip moves on');
    assert.deepEqual(s.job.rows.map(r=>r.status),['failed','done','done']);assert.match(s.job.rows[0].error,/Skipped manually/);
    slowFile=false;
    await command('retry-one',{id:0});
    s=await until(async()=>{const s=await state();return !s.busy&&s.job.status==='completed'?s:false;},'manual skip retry');
    assert.equal(s.job.totalPages,4);
    console.log('PASS: Skip current file interrupts a slow request, continues with the next locality and leaves the skipped file retryable.');
    slowFile=true;
    await command('start',{rows:[rows[2],rows[0]],delay:1,waitSeconds:1200,autoRetry:true});
    s=await until(async()=>{const s=await state();return s.job.rows[0].status==='done'&&s.job.rows[1].status==='fetching'?s:false;},'checkpoint before unexpected shutdown');
    const savedId=s.job.id, savedFolder=s.job.folder, completedRequests=requests['three.pdf'];
    await context.close(); // No Pause or Stop: the processor disappears while a file is in flight.
    slowFile=false;
    await launch();
    s=await state();assert.equal(s.job.status,'paused');assert.equal(s.job.id,savedId);assert.equal(s.job.folder,savedFolder);
    assert.equal(s.job.rows[0].status,'done');assert.equal(s.job.rows[1].status,'pending');
    assert.equal(s.job.waitSeconds,1200);assert.equal(s.job.autoRetry,true);
    await command('resume');
    s=await until(async()=>{const s=await state();return !s.busy&&s.job.status==='completed'?s:false;},'recovery without graceful pause');
    assert.equal(s.job.totalPages,3);assert.equal(requests['three.pdf'],completedRequests);
    console.log('PASS: shutdown during an active request preserves folder, queue, retry settings, cached completed PDF and download ID; Resume finishes without fetching the completed file again.');
    // A v1.0.1 saved batch has no retry settings. Simulate updating in the same profile.
    await panel.evaluate(async()=>{
      const db=await new Promise(res=>{const r=indexedDB.open('bill-prints-download',1);r.onsuccess=()=>res(r.result)});
      await new Promise((res,rej)=>{
        const tx=db.transaction('state','readwrite'),store=tx.objectStore('state'),r=store.get('job');
        r.onsuccess=()=>{const job=r.result;delete job.waitSeconds;delete job.autoRetry;delete job.retryPass;job.status='running';job.rows[1].status='fetching';job.rows[1].pages=0;store.put(job,'job')};
        tx.oncomplete=res;tx.onerror=()=>rej(tx.error);
      });
    });
    await context.close();await launch();s=await state();
    assert.equal(s.job.id,savedId);assert.equal(s.job.status,'paused');assert.equal(s.job.waitSeconds,600);assert.equal(s.job.autoRetry,false);
    assert.equal(s.job.rows[0].status,'done');assert.equal(s.job.rows[1].status,'pending');
    await command('resume');
    s=await until(async()=>{const s=await state();return !s.busy&&s.job.status==='completed'?s:false;},'old batch migration resume');
    assert.equal(s.job.rows[1].pages,2);
    console.log('PASS: existing v1.0.1 jobs migrate in place with a 10-minute wait default and retain their queue and completed-file cache.');
    unavailableFiles.add('one.pdf');unavailableFiles.add('two.pdf');
    await command('start',{rows,delay:1,waitSeconds:60,autoRetry:false});
    await until(async()=>{const s=await state();return !s.busy&&s.job.status==='completed_with_errors';},'selected download fixture');
    await until(async()=>await panel.locator('#rows input:enabled').count()===2,'unfinished row checkboxes enabled');
    await panel.locator('#selectAll').check();
    assert.equal(await panel.locator('#rows input:checked').count(),2);
    await panel.getByRole('checkbox',{name:'Select PETROL PUMPs',exact:true}).first().uncheck();
    assert.equal(await panel.locator('#rows input:checked').count(),1);
    unavailableFiles.delete('two.pdf');
    await panel.getByRole('button',{name:'Download selected'}).click();
    s=await until(async()=>{const s=await state();return !s.busy&&s.job.rows[1].status==='done'?s:false;},'one checked row downloads');
    assert.deepEqual(s.job.rows.map(r=>r.status),['failed','done','done']);
    assert.deepEqual(s.job.rows.map(r=>r.attempts),[1,2,1]);
    console.log('PASS: Select all checks only unfinished rows; Download selected runs just the checked file and leaves other rows untouched.');
    unavailableFiles.clear();
    if (!process.env.BILL_TEST_FAST) {
      transferMode='drop';rangeRequests.length=0;
      console.log('Testing a mid-stream connection drop: no automatic retry before the full one-minute deadline…');
      await command('start',{rows,delay:1,waitSeconds:60,autoRetry:true});
      s=await until(async()=>{const s=await state();return s.job.rows[0].phase==='waiting'?s:false;},'partial stream connection drop');
      const deadline=s.job.rows[0].deadline, received=s.job.rows[0].bytesReceived;
      assert.ok(received>0&&received<pdfs['one.pdf'].length);
      await panel.screenshot({path:path.join(artifacts,'connection-interrupted-waiting.png'),fullPage:true});
      await wait(38000);
      s=await state();assert.equal(s.job.rows[0].attempts,1);assert.equal(rangeRequests.length,1);
      assert.equal(s.job.rows[0].deadline,deadline);assert.equal(s.job.rows[0].bytesReceived,received);assert.ok(Date.now()<deadline);
      await panel.locator('#autoRetry').uncheck();
      transferMode='healthy';
      s=await until(async()=>{const s=await state();return !s.busy&&s.job.status==='completed_with_errors'?s:false;},'skip only after original deadline',35000);
      assert.deepEqual(s.job.rows.map(r=>r.status),['failed','done','done']);assert.equal(rangeRequests.length,1);
      const partialSize=await panel.evaluate(async()=>{
        const db=await new Promise(res=>{const r=indexedDB.open('bill-prints-download',1);r.onsuccess=()=>res(r.result)});
        return await new Promise(res=>{const r=db.transaction('pdfs').objectStore('pdfs').get('partial:0');r.onsuccess=()=>res(r.result?.blob.size)});
      });assert.equal(partialSize,received);
      await until(async()=>await panel.locator('#rows input:enabled').count()===1,'failed stream selectable');
      await panel.locator('#selectAll').check();
      await panel.getByRole('button',{name:'Download selected'}).click();
      s=await until(async()=>{const s=await state();return !s.busy&&s.job.status==='completed'?s:false;},'conditional range resume');
      assert.equal(rangeRequests.length,2);assert.equal(rangeRequests[1].range,`bytes=${received}-`);assert.equal(rangeRequests[1].validator,'"fixture-v1"');
      const bytes=await panel.evaluate(async()=>{
        const db=await new Promise(res=>{const r=indexedDB.open('bill-prints-download',1);r.onsuccess=()=>res(r.result)});
        return await new Promise(res=>{const r=db.transaction('pdfs').objectStore('pdfs').get(0);r.onsuccess=()=>res(Array.from(new Uint8Array(r.result)))});
      });assert.deepEqual(Buffer.from(bytes),pdfs['one.pdf']);assert.equal(s.job.totalPages,4);
      console.log('PASS: partial transfer retains bytes, keeps one attempt and deadline despite auto retry enabled, skips only at the deadline, then resumes via validated Range and produces an exact PDF.');
      transferMode=null;
    }
    parallelMode=true;parallelPeak=0;parallelEvents.length=0;
    const parallelSourceRows=Array.from({length:8},(_,i)=>({...rows[i%3],locality:`Parallel locality ${i+1}`,url:rows[i%3].url+`&slot=${i}`}));
    const parallelPortal=await context.newPage();await parallelPortal.goto('https://elgcd.punjab.gov.pk/e-billing/water-bills-print');
    await parallelPortal.evaluate(rows=>{
      const body=document.querySelector('tbody');body.replaceChildren();
      rows.forEach((row,i)=>{
        const tr=document.createElement('tr');
        for(const text of [i+1,row.sector,row.locality,row.fileNumber,row.billCount]) {const td=document.createElement('td');td.textContent=text;tr.append(td);}
        const td=document.createElement('td'),view=document.createElement('button');view.textContent='View';
        view.addEventListener('click',()=>setTimeout(()=>window.open(row.url),i===0?400:50));td.append(view);tr.append(td);body.append(tr);
      });
    },parallelSourceRows);
    const parallelTabId=await worker.evaluate(async()=> (await chrome.tabs.query({url:'https://elgcd.punjab.gov.pk/*'})).find(t=>t.active).id);
    await worker.evaluate(id=>chrome.storage.local.set({sourceTabId:id}),parallelTabId);
    const parallelScan=await panel.evaluate(()=>chrome.runtime.sendMessage({type:'SCAN'}));
    assert.equal(parallelScan.ok,true,parallelScan.error);const parallelRows=parallelScan.data.rows;
    assert.ok(parallelRows.every(r=>!r.url&&r.viewRef));
    await command('start',{rows:parallelRows,delay:1,waitSeconds:60,autoRetry:false,concurrency:5});
    await until(()=>parallelPeak===5,'five parallel PDF requests');
    s=await state();const firstDeadline=s.job.rows[0].deadline;
    assert.equal(s.job.rows.filter(r=>r.status==='fetching').length,5);
    await until(async()=>await panel.getByRole('button',{name:'Skip Parallel locality 3 file 2',exact:true}).count()===1,'parallel per-file Skip control');
    await panel.screenshot({path:path.join(artifacts,'five-parallel-downloads.png'),fullPage:true});
    await panel.getByRole('button',{name:'Skip Parallel locality 3 file 2',exact:true}).click();
    await until(()=>parallelEvents.some(e=>e.slot===5&&e.event==='start'),'vacant slot refills');
    s=await state();assert.equal(s.job.rows[0].deadline,firstDeadline);assert.equal(s.job.rows[0].attempts,1);
    s=await until(async()=>{const s=await state();return !s.busy&&s.job.status==='completed_with_errors'?s:false;},'parallel queue complete');
    assert.equal(parallelPeak,5);assert.equal(s.job.rows[2].status,'failed');assert.match(s.job.rows[2].error,/Skipped manually/);
    assert.ok(s.job.rows.every((r,i)=>i===2||r.status==='done'));
    assert.ok(parallelEvents.find(e=>e.slot===5&&e.event==='start').at<parallelEvents.find(e=>e.slot===0&&e.event==='end').at);
    await command('retry-selected',{ids:[2],concurrency:5});
    s=await until(async()=>{const s=await state();return !s.busy&&s.job.status==='completed'?s:false;},'parallel selected retry');
    assert.equal(s.job.totalPages,11);assert.ok(s.job.rows.every((r,i)=>r.attempts===(i===2?2:1)));
    parallelMode=false;
    console.log('PASS: five simultaneous requests never exceed five, free slots refill before the slow first file finishes, timers remain independent, per-file Skip leaves other requests intact, and selected retry completes the merge.');
  } finally {
    await context?.close(); await new Promise(resolve=>server.close(resolve));
    const resolved=path.resolve(profile);
    if(path.dirname(resolved)===path.resolve(os.tmpdir())&&path.basename(resolved).startsWith('bill-extension-test-')) await fs.rm(resolved,{recursive:true,force:true});
  }
})().catch(e=>{console.error(e);process.exitCode=1});

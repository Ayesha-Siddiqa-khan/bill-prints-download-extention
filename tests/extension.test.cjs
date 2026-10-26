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
  let context, panel, worker, extensionId, loginPage = false;
  const server = https.createServer({key:await fs.readFile(path.join(__dirname,'localhost-key.pem')),cert:await fs.readFile(path.join(__dirname,'localhost-cert.pem'))},async(req,res)=>{
    const url = new URL(req.url,'https://elgcd.punjab.gov.pk');
    if(url.pathname.includes('viewAttachments')) {
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
  } finally {
    await context?.close(); await new Promise(resolve=>server.close(resolve));
    const resolved=path.resolve(profile);
    if(path.dirname(resolved)===path.resolve(os.tmpdir())&&path.basename(resolved).startsWith('bill-extension-test-')) await fs.rm(resolved,{recursive:true,force:true});
  }
})().catch(e=>{console.error(e);process.exitCode=1});

const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({headless:true,channel:'chromium',executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const page = await browser.newPage();
  const svg = await fs.readFile(path.join(__dirname,'../extension/icons/icon.svg'),'utf8');
  for (const size of [16,32,48,128]) {
    await page.setViewportSize({width:size,height:size});
    await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;background:transparent}svg{width:100%;height:100%;display:block}</style>${svg}`);
    await page.screenshot({path:path.join(__dirname,`../extension/icons/icon${size}.png`),omitBackground:true});
  }
  await browser.close();
})().catch(e=>{console.error(e);process.exitCode=1});

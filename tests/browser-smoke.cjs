const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');
(async () => {
 const root = path.resolve(__dirname, '..');
 fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
 const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sri-extension-smoke-'));
 const downloadPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sri-smoke-downloads-'));
 fs.mkdirSync(path.join(profile, 'Default'));
 fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloadPath, prompt_for_download: false } }));
 const keys = [1,2,3,4].map(n => String(n).padStart(49,'0'));
 const calls = []; const errors = []; const suggestedNames = [];
 const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, downloadsPath: downloadPath, args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`], viewport: {width: 1280, height: 800} });
 try {
  const cdp = await context.browser().newBrowserCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true });
  let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  worker.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  await context.route('https://api.emite.ec/**', async route => {
    const request = route.request(); const body = request.postDataJSON(); calls.push({url:request.url(),body});
    let data;
    if (request.url().endsWith('verificar-conexion')) data = { valido:true, razon_social:'EMPRESA DE PRUEBA', ruc:'0000000000001' };
    else if (request.url().endsWith('pre-check')) data = {duplicadas:[], anuladas_detectadas:[], por_sincronizar:body.comprobantes.map(x=>({clave_acceso:x.clave_acceso}))};
    else data = {guardados:body.comprobantes.map(x=>({clave_acceso:x.clave_acceso,cod_doc:'01'})),fallidos:[]};
    await route.fulfill({json:data});
  });
  const html = `<!doctype html><html><head><title>Comprobantes Recibidos</title></head><body><h1>Comprobantes Recibidos</h1><table><tbody id="rows"></tbody></table><div><button class="ui-paginator-first">Primera</button><span class="ui-paginator-page ui-state-active">1</span><button class="ui-paginator-next">Siguiente</button></div><script>
  const keys=${JSON.stringify(keys)}; let page=1;
  function render(){ document.getElementById('rows').innerHTML=keys.slice((page-1)*2,page*2).map((key,i)=>'<tr data-ri="'+i+'"><td>001-001-00000000'+((page-1)*2+i+1)+'</td><td>0000000000001 EMPRESA FICTICIA</td><td>16/11/2026</td><td>'+key+'</td><td>10.00</td><td>1.50</td><td>11.50</td><td><a id="lnkXml'+i+'" href="/mock/'+key+'.xml">XML</a></td></tr>').join(''); document.querySelector('.ui-state-active').textContent=page; document.querySelector('.ui-paginator-next').classList.toggle('ui-state-disabled',page===2); document.querySelector('.ui-paginator-first').classList.toggle('ui-state-disabled',page===1); }
  document.querySelector('.ui-paginator-next').onclick=()=>{if(page<2){page++;render()}}; document.querySelector('.ui-paginator-first').onclick=()=>{page=1;render()};render();</script></body></html>`;
  await context.route('https://srienlinea.sri.gob.ec/**', async route => {
    const url = route.request().url();
    if(url.endsWith('.xml')) { const key=url.split('/').pop().replace('.xml',''); await route.fulfill({contentType:'application/xml',body:'<factura><infoTributaria><claveAcceso>'+key+'</claveAcceso></infoTributaria></factura>'}); }
    else await route.fulfill({contentType:'text/html',body:html});
  });
  const popup = await context.newPage(); await popup.goto(`chrome-extension://${id}/popup.html`);
  popup.on('pageerror', e => errors.push(e.message));
  await popup.locator('#toggleConfigBtn').click(); await popup.locator('#emiteApiKey').fill('test-only-not-a-real-secret'); await popup.locator('#saveEmiteBtn').click();
  const sri = await context.newPage(); sri.on('download', download => suggestedNames.push(download.suggestedFilename())); await sri.goto('https://srienlinea.sri.gob.ec/comprobantes-recibidos');
  // El popup se abre como documento para mantener visible la pestaña SRI activa al consultar tabs.query.
  await sri.bringToFront();
  await popup.locator('#scanAllBtn').evaluate(el=>el.click());
  await popup.waitForFunction(()=>document.getElementById('totalInvoices').textContent==='4', {timeout:15000});
  await sri.bringToFront();
  await popup.locator('#syncEmiteBtn').evaluate(el=>el.click());
  await worker.evaluate(async()=> { const deadline=Date.now()+15000; while(Date.now()<deadline){const s=await chrome.storage.local.get('emiteSyncState'); if(s.emiteSyncState?.status==='SUCCESS') return; if(s.emiteSyncState?.status==='ERROR') throw new Error(JSON.stringify(s)); await new Promise(r=>setTimeout(r,100));} throw new Error('Sync no terminó'); });
  const result = await worker.evaluate(()=>chrome.storage.local.get(['lastEmiteSyncResult','emiteSyncState']));
  if(result.lastEmiteSyncResult.totalSincronizadas!==4) throw new Error(JSON.stringify(result));
  const chunks=calls.filter(c=>c.url.endsWith('ingestar-claves')).map(c=>c.body.comprobantes.map(i=>i.clave_acceso));
  if(chunks.length!==2||chunks.some(x=>x.length!==2)) throw new Error(JSON.stringify(chunks));
  const access = await worker.evaluate(async()=> { const tabs=await chrome.tabs.query({url:'https://srienlinea.sri.gob.ec/*'}); return chrome.scripting.executeScript({target:{tabId:tabs[0].id},func:async()=>{try {const data=await chrome.storage.local.get('emiteApiKey'); return data.emiteApiKey ? 'EXPOSED':'HIDDEN';} catch {return 'BLOCKED';}}}); });
  if(access.some(x=>x.result==='EXPOSED')) throw new Error('Storage expuesto');
  await sri.evaluate(() => {
    // Emula una descarga JSF mediante Blob local sin solicitudes al SRI real.
    const install = () => document.querySelectorAll('a[id^="lnkXml"]').forEach(link => {
      link.href = '#'; link.onclick = event => {
        event.preventDefault();
        const key = link.closest('tr').textContent.match(/\d{49}/)[0];
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['<factura><claveAcceso>'+key+'</claveAcceso></factura>'], {type:'application/xml'})); a.download = 'prueba.xml'; a.click();
      };
    });
    const original = window.render;
    window.render = () => { original(); install(); }; install();
  });
  await sri.bringToFront();
  await popup.locator('#downloadBtn').evaluate(el=>el.click());
  const downloads = await worker.evaluate(async()=> {
    const deadline=Date.now()+20000;
    while(Date.now()<deadline){const items=await chrome.downloads.search({});if(items.filter(x=>x.state==='complete').length===4)return items.map(x=>({state:x.state,filename:x.filename.split('/').pop()}));await new Promise(r=>setTimeout(r,100));}
    throw new Error(JSON.stringify(await chrome.downloads.search({})));
  });
  if(downloads.some(item=>!item.filename.includes('0000000000001_16_11_2026_'))) throw new Error(JSON.stringify({downloads,suggestedNames}));
  await popup.screenshot({path:root+'/dist/extension-smoke.png',fullPage:true});
  console.log(JSON.stringify({ extensionLoaded:true, scanned:4, synchronized:result.lastEmiteSyncResult.totalSincronizadas, batches:chunks.map(x=>x.length),contentScriptStorage:access.map(x=>x.result), downloads, suggestedNames, errors },null,2));
  if(errors.length) throw new Error('Errores del navegador');
 } finally {await context.close(); fs.rmSync(profile, { recursive: true, force: true }); fs.rmSync(downloadPath, { recursive: true, force: true });}
})().catch(e=>{console.error(e);process.exitCode=1});

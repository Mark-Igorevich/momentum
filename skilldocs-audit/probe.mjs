import https from 'node:https';
import http from 'node:http';
import { chromium } from 'playwright';

const ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

function coreRequest(rawUrl, {method='GET',headers={},body=null,redirects=0}={}) {
  return new Promise((resolve,reject)=>{
    const u=new URL(rawUrl);
    const mod=u.protocol==='https:'?https:http;
    const req=mod.request(u,{method,family:4,headers:{'user-agent':ua,'accept-encoding':'identity',...headers},timeout:45000},res=>{
      const chunks=[];
      res.on('data',c=>chunks.push(c));
      res.on('end',async()=>{
        const data=Buffer.concat(chunks);
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location && redirects<5) {
          try { resolve(await coreRequest(new URL(res.headers.location,u).href,{method:res.statusCode===303?'GET':method,headers,body:res.statusCode===303?null:body,redirects:redirects+1})); } catch(e){reject(e)}
        } else resolve({status:res.statusCode,headers:res.headers,body:data,url:u.href});
      });
    });
    req.on('timeout',()=>req.destroy(new Error('core request timeout')));
    req.on('error',reject);
    if (body) req.write(body);
    req.end();
  });
}

console.log('Node core request start');
try { const r=await coreRequest('https://skilldocs.pl/'); console.log('Node core result',r.status,r.body.length,r.headers['content-type']); }
catch(e){console.error('Node core failed',e)}

async function testBrowser(label, launchOptions={}, proxy=false){
  console.log('TEST',label);
  const browser=await chromium.launch({headless:true,...launchOptions});
  const context=await browser.newContext({ignoreHTTPSErrors:true,userAgent:ua});
  if(proxy){
    const cache=new Map();
    await context.route('**/*', async route=>{
      const req=route.request();
      const u=new URL(req.url());
      if(u.hostname.replace(/^www\./,'')!=='skilldocs.pl') return route.continue();
      const key=req.method()==='GET'?req.url():null;
      try{
        let r=key?cache.get(key):null;
        if(!r){
          const h={...req.headers()};
          for(const k of ['host','content-length','connection','accept-encoding']) delete h[k];
          r=await coreRequest(req.url(),{method:req.method(),headers:h,body:req.postDataBuffer()});
          if(key && r.status>=200 && r.status<400) cache.set(key,r);
        }
        const headers={};
        for(const [k,v] of Object.entries(r.headers)) if(v!=null && !['content-length','transfer-encoding','content-encoding','connection','keep-alive'].includes(k.toLowerCase())) headers[k]=Array.isArray(v)?v.join(', '):String(v);
        await route.fulfill({status:r.status,headers,body:r.body});
      }catch(e){ console.error('route proxy error',req.url(),e.message); await route.abort('failed'); }
    });
  }
  const page=await context.newPage();
  page.on('requestfailed',r=>console.log('requestfailed',r.url(),r.failure()?.errorText));
  try{
    const response=await page.goto('https://skilldocs.pl/',{waitUntil:'domcontentloaded',timeout:45000});
    console.log(label,'goto',response?.status(),page.url(),await page.title(),(await page.content()).length);
    console.log(label,'buttons',await page.locator('button,a.elementor-button').count(),'forms',await page.locator('form').count());
    await page.screenshot({path:`probe-${label.replace(/[^a-z0-9]/gi,'-')}.png`,fullPage:false});
  }catch(e){ console.error(label,'failed',e.message); }
  await context.close();await browser.close();
}

await testBrowser('default');
await testBrowser('flags',{args:['--disable-quic','--disable-http2','--disable-features=UseDnsHttpsSvcbAlpn','--host-resolver-rules=MAP skilldocs.pl 46.202.142.38']});
await testBrowser('core-route-proxy',{},true);

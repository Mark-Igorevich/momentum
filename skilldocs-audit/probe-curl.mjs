import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
const execFileAsync=promisify(execFile);
const ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
let seq=0;
async function curlRequest(url,{method='GET',headers={},body=null}={}){
  const id=`sd-${process.pid}-${Date.now()}-${seq++}-${crypto.randomBytes(3).toString('hex')}`;
  const dir=path.join(os.tmpdir(),'sd-curl-proxy');await fs.mkdir(dir,{recursive:true});
  const hdr=path.join(dir,id+'.hdr'), out=path.join(dir,id+'.bin'), post=path.join(dir,id+'.post');
  const args=['-sS','-L','--http1.1','--connect-timeout','15','--max-time','60','--retry','1','--retry-delay','1','-A',ua,'-D',hdr,'-o',out,'-w','%{http_code}\n%{url_effective}\n'];
  if(method!=='GET') args.push('-X',method);
  for(const [k,v] of Object.entries(headers)){
    if(v==null||['host','content-length','connection','accept-encoding','cookie','sec-ch-ua','sec-ch-ua-mobile','sec-ch-ua-platform'].includes(k.toLowerCase())) continue;
    args.push('-H',`${k}: ${v}`);
  }
  args.push('-H','Accept-Encoding: identity');
  if(body && body.length){await fs.writeFile(post,body);args.push('--data-binary',`@${post}`)}
  args.push(url);
  try{
    const {stdout,stderr}=await execFileAsync('curl.exe',args,{encoding:'utf8',maxBuffer:2*1024*1024,windowsHide:true,timeout:70000});
    const lines=stdout.trim().split(/\r?\n/);const effectiveUrl=lines.pop()||url;const status=Number(lines.pop())||0;
    const rawHeaders=await fs.readFile(hdr,'utf8').catch(()=>"");
    const blocks=rawHeaders.split(/\r?\n\r?\n/).filter(x=>/^HTTP\//i.test(x.trim()));
    const last=blocks.at(-1)||'';const headersOut={};
    for(const line of last.split(/\r?\n/).slice(1)){const i=line.indexOf(':');if(i>0){const k=line.slice(0,i).trim().toLowerCase(),v=line.slice(i+1).trim();if(!['content-length','transfer-encoding','content-encoding','connection','keep-alive','set-cookie'].includes(k)) headersOut[k]=headersOut[k]?`${headersOut[k]}, ${v}`:v;}}
    const data=await fs.readFile(out).catch(()=>Buffer.alloc(0));
    if(stderr) console.log('curl stderr',stderr.slice(0,200));
    return {status,headers:headersOut,body:data,url:effectiveUrl};
  }finally{await Promise.all([hdr,out,post].map(f=>fs.rm(f,{force:true}).catch(()=>{})))}
}

const t=Date.now();const home=await curlRequest('https://skilldocs.pl/');console.log('curl home',home.status,home.body.length,Date.now()-t,home.headers['content-type']);
const browser=await chromium.launch({headless:true});const context=await browser.newContext({ignoreHTTPSErrors:true,userAgent:ua});
const cache=new Map();let proxied=0,aborted=0;
await context.route('**/*',async route=>{
 const req=route.request();const u=new URL(req.url());
 if(['image','media','font'].includes(req.resourceType())){aborted++;return route.abort('blockedbyclient')}
 if(u.hostname.replace(/^www\./,'')!=='skilldocs.pl') return route.continue();
 const key=req.method()==='GET'?req.url():null;
 try{
  let p=key?cache.get(key):null;
  if(!p){p=curlRequest(req.url(),{method:req.method(),headers:req.headers(),body:req.postDataBuffer()});if(key)cache.set(key,p)}
  const r=await p;proxied++;
  await route.fulfill({status:r.status||200,headers:r.headers,body:r.body});
 }catch(e){console.error('proxy error',req.url(),e);await route.abort('failed')}
});
const page=await context.newPage();page.on('console',m=>console.log('console',m.type(),m.text().slice(0,200)));page.on('requestfailed',r=>console.log('failed',r.resourceType(),r.url(),r.failure()?.errorText));
try{
 const response=await page.goto('https://skilldocs.pl/',{waitUntil:'domcontentloaded',timeout:90000});
 console.log('goto',response?.status(),page.url(),await page.title(),(await page.content()).length,'proxied',proxied,'cache',cache.size,'aborted',aborted);
 await page.waitForTimeout(5000);
 console.log('counts','buttons',await page.locator('button,a.elementor-button').count(),'forms',await page.locator('form').count(),'popups',await page.locator('.elementor-popup-modal').count());
 await page.screenshot({path:'probe-curl-route.png',fullPage:false});
}catch(e){console.error('browser failed',e)}
await browser.close();

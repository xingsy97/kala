#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'

const root = new URL('../..', import.meta.url).pathname
const bundle = join(root, 'release', 'bundle-dashboard-with-runtime.cjs')
const executor = join(root, 'release', 'agent-kernel-executor.cjs')
const hostPort = Number(process.env.PERF_STREAM_HOST_PORT ?? 3216)
const providerPort = Number(process.env.PERF_STREAM_PROVIDER_PORT ?? 3217)
const origin = `http://127.0.0.1:${hostPort}`
const stateRoot = mkdtempSync(join(tmpdir(), 'runlab-stream-profile-'))
const sessionsDir = join(stateRoot, 'sessions')
const workspace = join(stateRoot, 'workspace')
const home = join(stateRoot, 'home')
const evidenceRoot = process.env.PERF_EVIDENCE_ROOT ?? join(stateRoot, 'evidence')
const token = `perf-${process.pid}-${Date.now()}`
const chrome = process.env.CHROME_PATH ?? ['/usr/bin/chromium','/snap/bin/chromium','/usr/bin/google-chrome'].find(existsSync)
let call = 0
let host
let executorProcess
let browser
const processLogs=[]

mkdirSync(sessionsDir,{recursive:true});mkdirSync(workspace,{recursive:true});mkdirSync(join(home,'.config','agent-kernel'),{recursive:true});mkdirSync(evidenceRoot,{recursive:true});writeFileSync(join(home,'.config','agent-kernel','agent.json'),'{}\n')
for(let i=0;i<8;i++)writeFileSync(join(workspace,`stream-${i}.txt`),`STREAM_FILE_${i}\n`)

const provider=createServer(async(req,res)=>{
 if(req.method!=='POST'){res.writeHead(404).end();return}
 const chunks=[];for await(const chunk of req)chunks.push(chunk)
 JSON.parse(Buffer.concat(chunks).toString())
 call+=1;res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'})
 if(call===1){
  sse(res,{type:'message_start',message:{id:'stream-text',usage:{input_tokens:20,output_tokens:0}}});sse(res,{type:'content_block_start',index:0,content_block:{type:'text',text:''}})
  const chunks=Array.from({length:240},(_,i)=>`token-${i} **bold** \`code\` `)
  for(const text of chunks){sse(res,{type:'content_block_delta',index:0,delta:{type:'text_delta',text}});await sleep(12)}
  sse(res,{type:'content_block_stop',index:0});sse(res,{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1200}})
 }else if(call===2){
  sse(res,{type:'message_start',message:{id:'stream-tools',usage:{input_tokens:20,output_tokens:0}}})
  for(let i=0;i<8;i++){sse(res,{type:'content_block_start',index:i,content_block:{type:'tool_use',id:`perf-read-${i}`,name:'read_file',input:{}}});sse(res,{type:'content_block_delta',index:i,delta:{type:'input_json_delta',partial_json:JSON.stringify({path:`stream-${i}.txt`,_intent:`Read streaming fixture ${i}.`})}});sse(res,{type:'content_block_stop',index:i});await sleep(35)}
  sse(res,{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:100}})
 }else{
  sse(res,{type:'message_start',message:{id:'stream-final',usage:{input_tokens:20,output_tokens:0}}});sse(res,{type:'content_block_start',index:0,content_block:{type:'text',text:''}})
  for(const text of ['STREAMING_PROFILE_','COMPLETE']){sse(res,{type:'content_block_delta',index:0,delta:{type:'text_delta',text}});await sleep(40)}
  sse(res,{type:'content_block_stop',index:0});sse(res,{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:8}})
 }
 sse(res,{type:'message_stop'});res.end()
})

try{
 if(!existsSync(bundle)||!existsSync(executor)||!chrome)throw new Error('production artifacts or Chromium missing')
 await new Promise(r=>provider.listen(providerPort,'127.0.0.1',r))
 host=spawn(process.execPath,[bundle],{cwd:root,env:{...process.env,HOME:home,HOST_LISTEN_HOST:'127.0.0.1',HOST_PORT:String(hostPort),SESSIONS_DIR:sessionsDir,EXECUTOR_TOKENS:JSON.stringify([{token}]),ANTHROPIC_API_KEY:'perf',ANTHROPIC_MODEL:'perf-model',ANTHROPIC_BASE_URL:`http://127.0.0.1:${providerPort}/v1/messages`},stdio:['ignore','pipe','pipe']});captureLogs('host',host)
 await waitHttp(`${origin}/settings`)
 executorProcess=spawn(executor,['--host',origin,'--sandbox-root',workspace],{cwd:workspace,env:{...process.env,HOME:stateRoot,HOST_URL:origin,EXECUTOR_TOKEN:token,WORKSPACE_NAME:'perf-stream-workspace'},stdio:['ignore','pipe','pipe']});captureLogs('executor',executorProcess)
 await waitFor(()=>processLogs.some(line=>line.includes('executor announced')),30000)
 browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage'],protocolTimeout:180000})
 const page=await browser.newPage();await page.setViewport({width:1440,height:900});await page.setCacheEnabled(false)
 await page.evaluateOnNewDocument(()=>{window.__perf={long:[]};new PerformanceObserver(list=>{for(const e of list.getEntries())window.__perf.long.push({startTime:e.startTime,duration:e.duration})}).observe({type:'longtask',buffered:true})})
 await page.goto(origin,{waitUntil:'networkidle2'});await page.waitForFunction(()=>[...document.querySelectorAll('[data-testid^="workspace-new-session-"]')].some(e=>!e.hasAttribute('disabled')),{timeout:60000});await page.evaluate(()=>[...document.querySelectorAll('[data-testid^="workspace-new-session-"]')].find(e=>!e.hasAttribute('disabled'))?.click());await page.waitForSelector('[data-testid="new-session-dialog"]');await page.click('[data-testid="new-session-create"]');await page.waitForSelector('[data-testid="new-session-dialog"]',{hidden:true});await page.waitForSelector('[data-testid="composer-input"]')
 const cdp=await page.target().createCDPSession();await cdp.send('Performance.enable');await cdp.send('Profiler.enable');await cdp.send('Profiler.setSamplingInterval',{interval:200});await cdp.send('Profiler.start');await startTrace(cdp);await startFrames(page);await page.evaluate(()=>window.__perf.long=[])
 const started=performance.now()
 await page.type('[data-testid="composer-input"]','stream a long markdown response');await page.click('[data-testid="composer-send"]');await page.waitForFunction(()=>document.body.innerText.includes('token-239'),{timeout:60000})
 await page.waitForSelector('[data-testid="composer-send"]');await page.type('[data-testid="composer-input"]','run eight read tools');await page.click('[data-testid="composer-send"]');await page.waitForFunction(()=>document.body.innerText.includes('STREAMING_PROFILE_COMPLETE'),{timeout:60000})
 const durationMs=performance.now()-started;const {profile}=await cdp.send('Profiler.stop');writeFileSync(join(evidenceRoot,'streaming.cpuprofile.json'),JSON.stringify(profile));const traceComplete=new Promise(r=>cdp.once('Tracing.tracingComplete',r));await cdp.send('Tracing.end');const event=await traceComplete;await copy(cdp,event.stream,join(evidenceRoot,'streaming.trace.json'))
 const frames=await stopFrames(page);const pageData=await page.evaluate(()=>({longTasks:window.__perf.long,domNodes:document.getElementsByTagName('*').length,transcriptRows:document.querySelectorAll('[data-virt-index]').length,traceRows:document.querySelectorAll('[data-testid="timeline-row"]').length,minimapItems:document.querySelectorAll('[data-testid="timeline-minimap-item"]').length}))
 const metrics=Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));const report={durationMs,frames,...pageData,metrics,providerCalls:call};writeFileSync(join(evidenceRoot,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({evidenceRoot,report},null,2))
}catch(error){console.error(error);console.error(processLogs.slice(-50).join(''));throw error}finally{await browser?.close().catch(()=>{});for(const p of [executorProcess,host])if(p?.exitCode===null)p.kill('SIGTERM');await new Promise(r=>provider.close(r)).catch(()=>{});if(!process.env.PERF_KEEP_STATE)rmSync(stateRoot,{recursive:true,force:true})}

function sse(res,value){res.write(`data: ${JSON.stringify(value)}\n\n`)}
function captureLogs(name,process){process.stdout?.on('data',chunk=>processLogs.push(`[${name}] ${chunk}`));process.stderr?.on('data',chunk=>processLogs.push(`[${name}] ${chunk}`))}
async function waitFor(check,timeout){const end=Date.now()+timeout;while(Date.now()<end){if(check())return;await sleep(100)}throw new Error(`condition timeout; logs=${processLogs.slice(-30).join('')}`)}
async function waitHttp(url){for(let i=0;i<150;i++){try{if((await fetch(url)).ok)return}catch{}await sleep(200)}throw new Error(`timeout ${url}; logs=${processLogs.slice(-30).join('')}`)}
async function startTrace(cdp){await cdp.send('Tracing.start',{transferMode:'ReturnAsStream',categories:'devtools.timeline,v8.execute,blink.user_timing,disabled-by-default-devtools.timeline,disabled-by-default-v8.cpu_profiler',options:'sampling-frequency=10000'})}
async function copy(cdp,handle,path){const out=createWriteStream(path);while(true){const x=await cdp.send('IO.read',{handle});out.write(x.base64Encoded?Buffer.from(x.data,'base64'):x.data);if(x.eof)break}out.end();await new Promise((r,j)=>{out.on('finish',r);out.on('error',j)});await cdp.send('IO.close',{handle})}
async function startFrames(page){await page.evaluate(()=>{window.__frames=[];window.__framesOn=true;let p=performance.now();const f=n=>{window.__frames.push(n-p);p=n;if(window.__framesOn)requestAnimationFrame(f)};requestAnimationFrame(f)})}
async function stopFrames(page){return page.evaluate(()=>{window.__framesOn=false;const v=window.__frames.filter(x=>x>0).sort((a,b)=>a-b),q=p=>v[Math.min(v.length-1,Math.floor(v.length*p))]??0;return{count:v.length,avgMs:v.reduce((a,b)=>a+b,0)/(v.length||1),p95Ms:q(.95),p99Ms:q(.99),maxMs:v.at(-1)??0,over33Ms:v.filter(x=>x>33).length,over50Ms:v.filter(x=>x>50).length,over100Ms:v.filter(x=>x>100).length}})}

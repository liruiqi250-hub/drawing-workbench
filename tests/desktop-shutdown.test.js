'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {requestJson} = require('../desktop/backend.cjs');
const app = path.resolve(__dirname,'..');
const work = path.join(app,'.test-tmp');
fs.mkdirSync(work,{recursive:true});
const localAgent = new http.Agent({keepAlive:false,proxyEnv:{}});
function request(port,route,payload={}) {
  return new Promise((resolve,reject) => {
    const bytes=Buffer.from(JSON.stringify(payload));
    const req=http.request({host:'127.0.0.1',port,path:route,method:'POST',agent:localAgent,headers:{'X-Requested-With':'DrawingWorkbench','Content-Type':'application/json','Content-Length':bytes.length}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',chunk=>{text+=chunk;});res.on('end',()=>resolve({status:res.statusCode,json:JSON.parse(text)}));res.on('error',reject);
    });
    req.setTimeout(5000,()=>req.destroy(new Error('fixture timeout')));req.on('error',reject);req.end(bytes);
  });
}
function message(child,name) {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.off('message',receive);reject(new Error('Missing fixture event: '+name));},5000);
    function receive(value){if(value.event===name){clearTimeout(timer);child.off('message',receive);resolve(value);}}
    child.on('message',receive);
  });
}
async function launch(t) {
  const temporary=fs.mkdtempSync(path.join(work,'shutdown-http-'));
  const roots=path.join(temporary,'fixture-roots'),data=path.join(temporary,'fixture-data');fs.mkdirSync(roots);fs.mkdirSync(data);
  fs.writeFileSync(path.join(roots,'关闭竞态.pdf'),'%PDF-fixture');
  fs.writeFileSync(path.join(data,'settings.json'),JSON.stringify({roots:[roots],watch:false,pdf:{indexText:false},ai:{enabled:true,sendPdfText:true}}));
  const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const preload=path.join(temporary,'fixture-preload.cjs');
  fs.writeFileSync(preload,`const target=${JSON.stringify(path.join(app,'src','ai.js'))};
    let busy=false;
    require.cache[target]={id:target,filename:target,loaded:true,exports:{createAiService:()=>({
      status:()=>({busy,configured:true}),
      testConnection:async()=>{busy=true;process.send({event:'ai-started'});await new Promise(resolve=>process.once('message',resolve));busy=false;return {ok:true};},
      search:async()=>{process.send({event:'unexpected-paid-call'});throw new Error('unexpected call');},
      classify:async()=>{process.send({event:'unexpected-paid-call'});throw new Error('unexpected call');}
    })}};
    require(${JSON.stringify(path.join(app,'src','preview.js'))}).ensure=async()=>{process.send({event:'preview-pending'});await new Promise(resolve=>process.once('message',resolve));return null;};`);
  const child=spawn(process.execPath,['-r',preload,path.join(app,'server.js')],{cwd:app,windowsHide:true,stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,DRAWING_WORKBENCH_DATA:data,DRAWING_WORKBENCH_ROOTS:JSON.stringify([roots]),DRAWING_WORKBENCH_PORT:String(port)}});
  let logs='',paidCalls=0;child.stderr.on('data',chunk=>{logs=(logs+chunk).slice(-5000);});child.on('message',value=>{if(value.event==='unexpected-paid-call')paidCalls++;});
  t.after(async()=>{
    if(child.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;}
    if(!path.resolve(temporary).startsWith(path.resolve(work)+path.sep))throw new Error('Fixture cleanup outside workspace');
    fs.rmSync(temporary,{recursive:true,force:true});
  });
  let files;
  for(let attempt=0;attempt<100;attempt++) {
    if(child.exitCode!==null)throw new Error('Fixture exited: '+logs);
    try{files=await requestJson(`http://127.0.0.1:${port}`,'/api/files');if(files.total===1)break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,40));
  }
  assert.equal(files?.total,1,'isolated server must index fixture');
  return {child,port,id:files.items[0].id,paidCalls:()=>paidCalls};
}
test.after(()=>localAgent.destroy());
test('真实 HTTP：AI busy 时 shutdown 返回409，任务完成后才正常退出',async t=>{
  const f=await launch(t);const started=message(f.child,'ai-started');const task=request(f.port,'/api/ai/test');await started;
  const rejected=await request(f.port,'/api/system/shutdown');assert.equal(rejected.status,409);assert.match(rejected.json.error,/AI 任务正在进行/);
  assert.equal((await requestJson(`http://127.0.0.1:${f.port}`,'/api/health')).ok,true);
  f.child.send({release:true});assert.equal((await task).status,200);
  const exited=new Promise(resolve=>f.child.once('exit',resolve));assert.equal((await request(f.port,'/api/system/shutdown')).status,200);assert.equal(await exited,0);
});
test('真实 HTTP：确认 shutdown 后，异步预览与未读完请求体都不能启动新 AI',async t=>{
  const f=await launch(t);const pending=message(f.child,'preview-pending');const classification=request(f.port,'/api/ai/classify',{ids:[f.id]});await pending;
  let partial;
  const result=new Promise((resolve,reject)=>{
    partial=http.request({host:'127.0.0.1',port:f.port,path:'/api/ai/test',method:'POST',agent:localAgent,headers:{'X-Requested-With':'DrawingWorkbench','Content-Type':'application/json','Content-Length':2}},res=>{
      let text='';res.on('data',chunk=>{text+=chunk;});res.on('end',()=>resolve({status:res.statusCode,json:JSON.parse(text)}));
    });partial.on('error',reject);partial.write('{');
  });
  // A health round trip gives the already-open body request time to enter its await.
  await requestJson(`http://127.0.0.1:${f.port}`,'/api/health');
  const exited=new Promise(resolve=>f.child.once('exit',resolve));
  assert.equal((await request(f.port,'/api/system/shutdown')).status,200);
  partial.end('}');f.child.send({release:true});
  assert.equal((await result).status,503);const cancelled=await classification;assert.equal(cancelled.status,503);assert.match(cancelled.json.error,/正在退出/);
  assert.equal(await exited,0);assert.equal(f.paidCalls(),0);
});
test('真实 HTTP：慢备份和退出允许超过1.8秒，health仍快速超时',async()=>{
  const server=http.createServer((_req,res)=>{setTimeout(()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');},2100);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
  try {
    const checks=await Promise.allSettled([requestJson(origin,'/api/health'),requestJson(origin,'/api/backup','POST'),requestJson(origin,'/api/system/shutdown','POST')]);
    assert.equal(checks[0].status,'rejected');assert.match(checks[0].reason.message,/超时/);
    assert.deepEqual(checks.slice(1).map(value=>value.status),['fulfilled','fulfilled']);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('真实 Node 代理环境：桌面IPC绕过环境代理，仅直连本机',async()=>{
  let proxied=0,local=0;
  const proxy=http.createServer((_req,res)=>{proxied++;res.writeHead(502);res.end('proxy fixture');});
  const backend=http.createServer((_req,res)=>{local++;res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');});
  await Promise.all([new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve)),new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve))]);
  const origin=`http://127.0.0.1:${backend.address().port}`,proxyUrl=`http://127.0.0.1:${proxy.address().port}`;
  try {
    const source=`const http=require('node:http');const {requestJson}=require(${JSON.stringify(path.join(app,'desktop','backend.cjs'))});
      http.get(${JSON.stringify(origin+'/api/health')},res=>{res.resume();res.on('end',async()=>{try{const result=await requestJson(${JSON.stringify(origin)},'/api/health');console.log(JSON.stringify({baselineStatus:res.statusCode,healthy:result.ok}));}catch(error){console.error(error.message);process.exitCode=1;}});}).on('error',error=>{console.error(error.message);process.exitCode=1;});`;
    const child=spawn(process.execPath,['-e',source],{cwd:app,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_USE_ENV_PROXY:'1',HTTP_PROXY:proxyUrl,HTTPS_PROXY:proxyUrl,http_proxy:proxyUrl,https_proxy:proxyUrl,NO_PROXY:'wechat.invalid',no_proxy:'wechat.invalid'}});
    let output='',errors='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{errors+=chunk;});
    assert.equal(await new Promise(resolve=>child.once('exit',resolve)),0,errors);
    assert.deepEqual(JSON.parse(output.trim()),{baselineStatus:502,healthy:true});assert.equal(proxied,1);assert.equal(local,1);
    await assert.rejects(requestJson('https://example.com','/api/health'),/仅允许/);
    await assert.rejects(requestJson(origin,'https://example.com/api/health'),/仅允许/);
  } finally {
    proxy.closeAllConnections();backend.closeAllConnections();await Promise.all([new Promise(resolve=>proxy.close(resolve)),new Promise(resolve=>backend.close(resolve))]);
  }
});

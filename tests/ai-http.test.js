'use strict';
require('node:fs').mkdirSync(require('node:path').resolve(__dirname,'../.test-tmp'),{recursive:true});
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),net=require('node:net');
const {spawn}=require('node:child_process');
const temporary=fs.mkdtempSync(path.join(path.resolve(__dirname,'../.test-tmp'),'ai-http-test-'));
const app=path.resolve(__dirname,'..'),roots=path.join(temporary,'图纸夹');fs.mkdirSync(roots);
fs.writeFileSync(path.join(roots,'霸王龙钢架.dwg'),'fixture only');fs.writeFileSync(path.join(roots,'三角龙.pdf'),'fixture only');
const localAgent=new http.Agent({keepAlive:false,proxyEnv:{}}),children=[];
async function freePort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
function request(port,route,method='GET',payload,extraHeaders={}){return new Promise((resolve,reject)=>{const bytes=payload===undefined?null:Buffer.from(JSON.stringify(payload));const req=http.request({host:'127.0.0.1',port,path:route,method,agent:localAgent,headers:{'X-Requested-With':'DrawingWorkbench',...(bytes?{'Content-Type':'application/json','Content-Length':bytes.length}:{}),...extraHeaders}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const text=Buffer.concat(chunks).toString();let json;try{json=JSON.parse(text);}catch{}resolve({status:res.statusCode,json,text});});});req.on('error',reject);req.setTimeout(7000,()=>req.destroy(new Error('fixture timeout')));if(bytes)req.write(bytes);req.end();});}
async function launch(mock){const port=await freePort(),data=path.join(temporary,mock?'mock-data':'real-data');fs.mkdirSync(data);fs.writeFileSync(path.join(data,'settings.json'),JSON.stringify({roots:[roots],watch:false,ai:{enabled:mock,model:'deepseek-flash'}}));
  const mockFactory=opts=>{let classifyCalls=0;return {
    status:()=>({...opts.getSettings().ai,configured:true,busy:false,fixtureClassifyCalls:classifyCalls}),saveCredentials:async()=>{},testConnection:async()=>({ok:true,model:'mock'}),
    search:async(q,find)=>{const plan={groups:[['霸王龙']],keywords:['钢架'],formats:[]},c=await find(plan);return{matches:c.map(x=>({id:x.id,reason:'fixture依据名称'})),plan,totalCandidates:c.length,usage:{requests:2}};},
    classify:async(files)=>{classifyCalls++;return {suggestions:files.map(x=>({id:x.id,project:'AI建议项目',type:'钢架',tags:['fixture'],reason:'fixture依据名称',summary:'fixture'})),usage:{requests:1}};}
  };};
  const preload=path.join(temporary,'mock.cjs');fs.writeFileSync(preload,`const target=${JSON.stringify(path.join(app,'src/ai.js'))};require.cache[target]={id:target,filename:target,loaded:true,exports:{createAiService:(${mockFactory.toString()})}};const desktop=require(${JSON.stringify(path.join(app,'src/desktop.js'))});desktop.setAutoStart=()=>new Promise(resolve=>{process.send({fixture:'startupPending'});process.once('message',resolve);});const preview=require(${JSON.stringify(path.join(app,'src/preview.js'))});preview.ensure=()=>new Promise(resolve=>{process.send({fixture:'previewPending'});process.once('message',()=>resolve(null));});`);
  const child=spawn(process.execPath,[...(mock?['-r',preload]:[]),path.join(app,'server.js')],{cwd:app,windowsHide:true,stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,DRAWING_WORKBENCH_DATA:data,DRAWING_WORKBENCH_PORT:String(port),DRAWING_WORKBENCH_ROOTS:JSON.stringify([roots])}});children.push(child);let logs='';child.stderr.on('data',chunk=>{logs=(logs+chunk.toString()).slice(-8000);});
  for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error('隔离AI HTTP服务提前退出：'+logs);try{const r=await request(port,'/api/files');if(r.json?.total===2)return{port,data,child,files:r.json.items};}catch{}await new Promise(resolve=>setTimeout(resolve,40));}throw new Error('隔离AI HTTP服务未启动：'+logs);
}
let real,mock;
test.before(async()=>{real=await launch(false);mock=await launch(true);});
test.after(async()=>{localAgent.destroy();for(const child of children){if(child.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;}}fs.rmSync(temporary,{recursive:true,force:true});});
test('无Key的真实HTTP接口拒绝云端任务，配置读取没有secret',async()=>{
  assert.equal((await request(real.port,'/api/ai/test','POST',{})).status,400);
  assert.equal((await request(real.port,'/api/ai/search','POST',{query:'霸王龙'})).status,400);
  const settings=await request(real.port,'/api/ai/settings');assert.equal(settings.json.configured,false);assert.equal(settings.json.settings.model,'deepseek-flash');assert.ok(!settings.text.includes('apiKey'));
});
test('凭证HTTP保存使用DPAPI、不会返回Key，清除会自动关闭AI',async()=>{
  const fixtureKey='sk-local-fixture-not-a-real-provider-key';
  const saved=await request(real.port,'/api/ai/settings','PUT',{apiKey:fixtureKey,enabled:true});assert.equal(saved.status,200);assert.equal(saved.json.configured,true);assert.ok(!saved.text.includes(fixtureKey));
  const status=await request(real.port,'/api/status');assert.ok(!status.text.includes(fixtureKey));
  assert.ok(!fs.readFileSync(path.join(real.data,'settings.json'),'utf8').includes(fixtureKey));
  const backup=await request(real.port,'/api/backup','POST',{});assert.equal(backup.status,200);assert.deepEqual(fs.readdirSync(backup.json.path).sort(),['drawings.sqlite','settings.json']);
  const cleared=await request(real.port,'/api/ai/settings','PUT',{clearKey:true,enabled:true});assert.equal(cleared.status,200);assert.equal(cleared.json.configured,false);assert.equal(cleared.json.enabled,false);
});
test('AI写入与付费入口也受同源和请求标记校验',async()=>{
  for(const route of ['/api/ai/test','/api/ai/search','/api/ai/classify'])assert.equal((await request(real.port,route,'POST',{query:'霸王龙',ids:[]},{Origin:'https://attacker.example'})).status,403);
});
test('mock仅替代云服务，真实HTTP候选检索遵守scope且返回已索引文件和依据',async()=>{
  const found=await request(mock.port,'/api/ai/search','POST',{query:'找霸王龙的钢架图',scope:{format:'DWG'}});assert.equal(found.status,200);assert.equal(found.json.items.length,1);assert.equal(found.json.items[0].name,'霸王龙钢架.dwg');assert.equal(found.json.items[0].aiReason,'fixture依据名称');
  const excluded=await request(mock.port,'/api/ai/search','POST',{query:'霸王龙',scope:{format:'PDF'}});assert.equal(excluded.json.items.length,0);
});
test('mock建议经真实HTTP落库、可恢复和编辑确认，不会自动写分类',async()=>{
  const file=mock.files.find(x=>x.extension==='DWG');const response=await request(mock.port,'/api/ai/classify','POST',{ids:[file.id]});assert.equal(response.status,200);
  const suggestion=response.json.suggestions[0];assert.notEqual(suggestion.id,file.id);assert.equal(suggestion.fileId,file.id);
  const details=await request(mock.port,`/api/files/${file.id}`);assert.equal(details.json.classified,false);
  const restored=await request(mock.port,`/api/ai/suggestions?fileId=${file.id}`);assert.equal(restored.json.suggestions.length,1);
  const applied=await request(mock.port,`/api/ai/suggestions/${suggestion.id}/apply`,'POST',{project:'人工确认项目',type:'钢架',tags:['确认']});assert.equal(applied.status,200);assert.equal(applied.json.file.project,'人工确认项目');assert.equal((await request(mock.port,`/api/ai/suggestions?fileId=${file.id}`)).json.suggestions.length,0);
});
test('未知id、超额批量和坏范围不能绕过AI入口',async()=>{
  assert.equal((await request(mock.port,'/api/ai/classify','POST',{ids:['0123456789abcdef01234567']})).status,400);
  assert.equal((await request(mock.port,'/api/ai/classify','POST',{ids:Array(11).fill(mock.files[0].id)})).status,400);
  assert.equal((await request(mock.port,'/api/ai/search','POST',{query:'霸王龙',scope:{format:"' OR 1=1--"}})).status,400);
});
test('普通设置等待启动项I/O时，AI独立保存不被旧快照覆盖',async()=>{
  const pending=new Promise(resolve=>mock.child.once('message',resolve));
  const ordinary=request(mock.port,'/api/settings','PUT',{autoStart:true});
  await pending;
  const changed=await request(mock.port,'/api/ai/settings','PUT',{model:'deepseek-v4-pro',enabled:false});assert.equal(changed.status,200);
  mock.child.send({fixture:'releaseStartup'});assert.equal((await ordinary).status,200);
  const current=(await request(mock.port,'/api/settings')).json;assert.equal(current.ai.model,'deepseek-v4-pro');assert.equal(current.ai.enabled,false);
});
test('批量PDF只用现成文字，不进入慢预览队列',async()=>{
  await request(mock.port,'/api/ai/settings','PUT',{enabled:true,sendPdfText:true});
  const response=await request(mock.port,'/api/ai/classify','POST',{ids:mock.files.map(file=>file.id)});
  assert.equal(response.status,200);assert.match(response.json.notice,/批量仅使用已有 PDF 文字/);
});
test('单PDF提取期间客户端断开，后端不会再开始付费AI分类',async()=>{
  const file=mock.files.find(file=>file.extension==='PDF'),before=(await request(mock.port,'/api/status')).json.ai.fixtureClassifyCalls;
  const pending=new Promise(resolve=>mock.child.once('message',resolve));
  const payload=Buffer.from(JSON.stringify({ids:[file.id]}));
  const req=http.request({host:'127.0.0.1',port:mock.port,path:'/api/ai/classify',method:'POST',agent:localAgent,headers:{'X-Requested-With':'DrawingWorkbench','Content-Type':'application/json','Content-Length':payload.length}},res=>res.resume());req.on('error',()=>{});req.end(payload);
  assert.equal((await pending).fixture,'previewPending');
  req.destroy();await request(mock.port,'/api/status');
  let timer,listener;
  const rejected=new Promise((resolve,reject)=>{listener=chunk=>{if(chunk.toString().includes('本次请求已结束'))resolve();};mock.child.stderr.on('data',listener);timer=setTimeout(()=>reject(new Error('客户端关闭未阻止AI调用')),3000);});
  mock.child.send({fixture:'releasePreview'});
  try{await rejected;}finally{clearTimeout(timer);mock.child.stderr.off('data',listener);}
  assert.equal((await request(mock.port,'/api/status')).json.ai.fixtureClassifyCalls,before);
});

test('自动启动已为true时再次保存true仍同步新目录入口',async()=>{
  let timer;const pending=new Promise((resolve,reject)=>{mock.child.once('message',resolve);timer=setTimeout(()=>reject(new Error('重复true未同步启动项')),3000);});
  const saving=request(mock.port,'/api/settings','PUT',{autoStart:true});
  try{assert.equal((await pending).fixture,'startupPending');mock.child.send({fixture:'releaseStartup'});assert.equal((await saving).status,200);}finally{clearTimeout(timer);}
});

test('本机批量规则走真实HTTP预览与确认，并受同源校验保护',async()=>{
  const rejected=await request(real.port,'/api/rules/preview','POST',{}, {Origin:'https://attacker.example'});assert.equal(rejected.status,403);
  const result=await request(real.port,'/api/rules/preview','POST',{query:'霸王龙',includeClassified:true,limit:10});assert.equal(result.status,200);assert.ok(result.json.items.length);
  const item=result.json.items.find(item=>item.actionable&&!item.conflict);assert.ok(item);
  const applied=await request(real.port,'/api/rules/apply','POST',{previewId:result.json.previewId,selections:[{id:item.id,stamp:item.stamp}]});assert.equal(applied.status,200);assert.equal(applied.json.applied,1);
});

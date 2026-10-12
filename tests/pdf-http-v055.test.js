'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),net=require('node:net'),{spawn}=require('node:child_process');
const app=path.resolve(__dirname,'..'),base=path.join(app,'.test-tmp');fs.mkdirSync(base,{recursive:true});const temp=fs.mkdtempSync(path.join(base,'pdf-http-v055-')),root=path.join(temp,'fixtures'),data=path.join(temp,'data');fs.mkdirSync(root);fs.mkdirSync(data);
const file=path.join(root,'普通文件.pdf'),bytes=Buffer.from('%PDF-synthetic-http-fixture');fs.writeFileSync(file,bytes);fs.writeFileSync(path.join(data,'settings.json'),JSON.stringify({roots:[root],watch:false,rescanMinutes:1440}));
const preload=path.join(temp,'instrument.cjs');fs.writeFileSync(preload,`const indexer=require(${JSON.stringify(path.join(app,'src/indexer.js'))});let count=0;const original=indexer.configure,status=indexer.status;indexer.configure=(...args)=>{count++;return original(...args)};indexer.status=()=>({...status(),fixtureConfigureCalls:count});`);
const agent=new http.Agent({keepAlive:false,proxyEnv:{}});let port,child,id,logs='';
function request(route,method='GET',payload,headers={}){return new Promise((resolve,reject)=>{const body=payload===undefined?null:Buffer.from(JSON.stringify(payload)),req=http.request({host:'127.0.0.1',port,path:route,method,agent,headers:{'X-Requested-With':'DrawingWorkbench',...(body?{'Content-Type':'application/json','Content-Length':body.length}:{}),...headers}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const raw=Buffer.concat(chunks);let json;try{json=JSON.parse(raw.toString());}catch{}resolve({status:res.statusCode,json,raw});});});req.on('error',reject);req.setTimeout(7000,()=>req.destroy(new Error('HTTP fixture timeout')));if(body)req.write(body);req.end();});}
test.before(async()=>{
  const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  child=spawn(process.execPath,['-r',preload,path.join(app,'server.js')],{cwd:app,windowsHide:true,stdio:['ignore','ignore','pipe'],env:{...process.env,DRAWING_WORKBENCH_DATA:data,DRAWING_WORKBENCH_ROOTS:JSON.stringify([root]),DRAWING_WORKBENCH_PORT:String(port),DRAWING_WORKBENCH_DISABLE_PDF_INDEX:'1'}});child.stderr.on('data',chunk=>logs=(logs+chunk).slice(-5000));
  for(let i=0;i<150;i++){try{const found=await request('/api/files');if(found.json?.items?.length===1){id=found.json.items[0].id;return;}}catch{}if(child.exitCode!==null)throw new Error(logs);await new Promise(resolve=>setTimeout(resolve,30));}throw new Error('隔离 PDF HTTP 服务未启动：'+logs);
});
test.after(async()=>{agent.destroy();if(child?.exitCode===null){const exit=new Promise(resolve=>child.once('exit',resolve));child.kill();await exit;}assert.ok(temp.startsWith(base+path.sep));fs.rmSync(temp,{recursive:true,force:true});});
test('PDF 状态与手工分类API经真实HTTP返回；普通PDF隐藏仍可原文查看恢复且原文件不变',async()=>{
  const status=await request('/api/status');assert.equal(status.status,200);assert.equal(status.json.pdfIndex.enabled,false);assert.equal((await request('/api/pdf/status')).json.queued,1);
  const hidden=await request(`/api/files/${id}/pdf-kind`,'POST',{kind:'document'});assert.equal(hidden.status,200);assert.equal(hidden.json.file.pdfInfo.override,'document');assert.equal((await request('/api/files')).json.total,0);
  const documents=await request('/api/files?pdfMode=documents');assert.equal(documents.json.items[0].id,id);assert.equal((await request(`/api/files/${id}`)).json.pdfInfo.kind,'document');
  assert.deepEqual((await request(`/api/files/${id}/raw`)).raw,bytes);assert.deepEqual(fs.readFileSync(file),bytes);
  const restored=await request(`/api/files/${id}/pdf-kind`,'POST',{kind:'drawing'});assert.equal(restored.status,200);assert.equal((await request('/api/files')).json.total,1);
  assert.equal((await request('/api/pdf/reindex','POST',{})).status,200);assert.equal((await request(`/api/files/${id}`)).json.pdfInfo.override,'drawing');
  assert.equal((await request('/api/pdf/reindex','POST',{cancel:true})).json.pdfIndex.cancelled,true);
});
test('仅PDF设置、规则与显示修改不会触发全盘扫描，扫描范围实际变化才调用configure',async()=>{
  const before=(await request('/api/status')).json.indexing.fixtureConfigureCalls;
  for(const pdf of [{displayMode:'all'},{includeKeywords:['特定关键词']},{maxPages:2,ocrEnabled:false},{skipNamedDrawings:false},{skipNamedDrawings:true}]){const saved=await request('/api/settings','PUT',{pdf});assert.equal(saved.status,200);assert.equal(saved.json.reindexing,false);assert.equal((await request('/api/status')).json.indexing.fixtureConfigureCalls,before);}
  const saved=await request('/api/settings','PUT',{excludeDirs:['.git','不扫描的测试文件夹']});assert.equal(saved.status,200);assert.equal(saved.json.reindexing,true);assert.equal((await request('/api/status')).json.indexing.fixtureConfigureCalls,before+1);
});
test('临时范围经真实HTTP贯穿搜索和详情分类，版本文档分类不会因默认隐藏而丢失',async()=>{
  const backupFile=path.join(root,'普通文件 2026-03-02 14_41_24.pdf');fs.writeFileSync(backupFile,bytes);
  await request('/api/index/scan','POST',{});let backupId;
  for(let i=0;i<100;i++){const found=await request('/api/files?pdfMode=all&grouped=0');backupId=found.json.items.find(row=>row.path===backupFile)?.id;if(backupId)break;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.ok(backupId);await request(`/api/files/${backupId}/pdf-kind?pdfMode=all`,'POST',{kind:'document'});await request(`/api/files/${backupId}/classify?pdfMode=all`,'POST',{project:'隐藏备份HTTP项目',type:'说明',tags:[],scope:'version'});
  await request('/api/settings','PUT',{pdf:{displayMode:'drawings-pending'}});
  const found=await request('/api/files?pdfMode=all&project='+encodeURIComponent('隐藏备份HTTP项目'));assert.equal(found.json.total,1);assert.equal(found.json.items[0].project,'隐藏备份HTTP项目');assert.equal(found.json.items[0].classification.variants.length,2);
  const detail=await request(`/api/files/${id}?pdfMode=all`);assert.equal(detail.json.project,'隐藏备份HTTP项目');assert.equal(detail.json.classification.variants.length,2);assert.equal(detail.json.versions.find(row=>row.id===backupId).visible,true);
  const defaults=await request(`/api/files/${id}`);assert.equal(defaults.json.project,'');assert.equal(defaults.json.classification.variants.length,1);
  const document=await request(`/api/files/${backupId}?pdfMode=documents`);assert.equal(document.json.group.representativeId,backupId);assert.equal(document.json.classification.variants.length,1);
  assert.equal((await request(`/api/files/${id}?pdfMode=invalid`)).status,400);
});
test('PDF新增写入接口拒绝跨源、未知文件、错误类别及无效显示范围',async()=>{
  for(const route of ['/api/pdf/reindex',`/api/files/${id}/pdf-kind`,`/api/files/${id}/pdf-index`])assert.equal((await request(route,'POST',{kind:'drawing'},{Origin:'https://attacker.example'})).status,403);
  assert.equal((await request('/api/files/0123456789abcdef01234567/pdf-kind','POST',{kind:'drawing'})).status,404);
  assert.equal((await request(`/api/files/${id}/pdf-kind`,'POST',{kind:'delete'})).status,400);
  assert.equal((await request('/api/files?pdfMode=delete')).status,400);
  assert.equal((await request('/api/settings','PUT',{pdf:{maxPages:200}})).status,400);
});


test('单份补提取HTTP保留同源与文件保护，隔离关闭时明确503且不伪造成功',async()=>{
  assert.equal((await request(`/api/files/${id}/pdf-index`,'POST',{})).status,503);
  assert.match((await request(`/api/files/${id}/pdf-index`,'POST',{})).json.error,/隔离/);
  assert.equal((await request(`/api/files/${id}`)).json.pdfInfo.forceIndexPending,false);
  assert.equal((await request('/api/files/0123456789abcdef01234567/pdf-index','POST',{})).status,404);
  assert.equal((await request(`/api/files/${id}/pdf-index?pdfMode=invalid`,'POST',{})).status,400);
  // A directory junction exercises the actual allowedRow realpath guard on Windows.
  const aliasDir=path.join(root,'外部链接'),outsideDir=path.join(temp,'outside');fs.mkdirSync(outsideDir);fs.writeFileSync(path.join(outsideDir,'外部.pdf'),bytes);fs.symlinkSync(outsideDir,aliasDir,'junction');
  await request('/api/index/scan','POST',{});
  let aliasId;for(let i=0;i<100;i++){const found=await request('/api/files?pdfMode=all&grouped=0');aliasId=found.json.items.find(row=>row.path===path.join(aliasDir,'外部.pdf'))?.id;if(aliasId)break;await new Promise(resolve=>setTimeout(resolve,10));}
  // Scanner may reject the junction before creating a row; either outcome must deny extraction.
  const response=await request(`/api/files/${aliasId||'0123456789abcdef01234567'}/pdf-index`,'POST',{});assert.equal(response.status,404);
});

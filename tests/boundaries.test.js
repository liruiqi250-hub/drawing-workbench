'use strict';
require('node:fs').mkdirSync(require('node:path').resolve(__dirname,'../.test-tmp'),{recursive:true});
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

const work=path.resolve(__dirname,'../.test-tmp');
fs.mkdirSync(work,{recursive:true});
const temporary=fs.mkdtempSync(path.join(work,'boundaries-test-'));
const baseline=path.join(temporary,'baseline');fs.mkdirSync(baseline);
process.env.DRAWING_WORKBENCH_DATA=path.join(temporary,'data');
process.env.DRAWING_WORKBENCH_ROOTS=JSON.stringify([baseline]);
const config=require('../src/config');
const store=require('../src/store');
const indexer=require('../src/indexer');
let sequence=0;

test.beforeEach(async()=>{
  await indexer.scan('settle-before-case');
  store.db.exec('DELETE FROM files; DELETE FROM events;');store.invalidateStats();
});
test.after(async()=>{
  await indexer.scan('settle-after-cases');
  indexer.stop();store.close();fs.rmSync(temporary,{recursive:true,force:true});
});

function makeCase(){
  const root=path.join(temporary,`case-${++sequence}`),replacement=path.join(temporary,`replacement-${sequence}`);
  fs.mkdirSync(root);fs.mkdirSync(replacement);
  return {root,replacement,file:path.join(root,'中文 边界.pdf')};
}
function meta(file){const s=fs.statSync(file,{bigint:true});return{
  path:file,name:path.basename(file),extension:'.pdf',size:Number(s.size),modified:Number(s.mtimeMs),
  fileKey:`${path.parse(file).root.toLowerCase()}:${s.dev}:${s.ino}`,
};}
async function scope(root){
  config.saveSettings({roots:[root],watch:false});indexer.configure();await indexer.scan('scope-ready');
}

test('设置收窄范围时，旧监听事件的 lstat 结果不能重新放回越界记录',async()=>{
  const fixture=makeCase();await scope(fixture.root);fs.writeFileSync(fixture.file,'fixture');
  const original=fs.promises.lstat;const frozen=fs.lstatSync(fixture.file,{bigint:true});
  let release,entered;
  const started=new Promise(resolve=>{entered=resolve;});
  fs.promises.lstat=(file,...args)=>file===fixture.file?new Promise(resolve=>{
    release=()=>resolve(frozen);entered();
  }):original.call(fs.promises,file,...args);
  let event;
  try{
    event=indexer.processPath(fixture.file);await started;
    config.saveSettings({roots:[fixture.replacement],watch:false});indexer.configure();
    release();await event;await indexer.scan('after-scope-change');
    assert.equal(config.isAllowed(fixture.file),false);
    assert.equal(store.search().total,0);
  }finally{fs.promises.lstat=original;if(release)release();if(event)await event;}
});

test('全量扫描等待 stat 时切换范围，旧扫描不能在 prune 后写回记录',async()=>{
  const fixture=makeCase();await scope(fixture.root);fs.writeFileSync(fixture.file,'fixture');
  const original=fs.promises.stat,frozen=fs.statSync(fixture.file,{bigint:true});
  let release,entered;const started=new Promise(resolve=>{entered=resolve;});
  fs.promises.stat=(file,...args)=>file===fixture.file?new Promise(resolve=>{
    release=()=>resolve(frozen);entered();
  }):original.call(fs.promises,file,...args);
  let scanning;
  try{
    scanning=indexer.scan('controlled-stat');await started;
    config.saveSettings({roots:[fixture.replacement],watch:false});indexer.configure();
    release();await scanning;
    assert.equal(config.isAllowed(fixture.file),false);assert.equal(store.search().total,0);
  }finally{fs.promises.stat=original;if(release)release();if(scanning)await scanning;}
});

test('扫描根暂时失联时报告错误但保留原有索引、分类与标签',async()=>{
  const fixture=makeCase();await scope(fixture.root);fs.writeFileSync(fixture.file,'fixture');
  await indexer.processPath(fixture.file);
  const id=store.idFor?store.idFor(fixture.file):store.search().items[0].id;
  store.classify(id,{project:'失联仍保留',type:'测试',tags:['已确认']});
  fs.renameSync(fixture.root,fixture.root+'-offline');
  await indexer.scan('offline-root');
  assert.ok(indexer.status().errors>0);
  assert.equal(store.search().total,1);
  const row=store.publicFile(store.getRaw(id));
  assert.equal(row.exists,true);assert.equal(row.project,'失联仍保留');
  assert.deepEqual(row.tags,['已确认']);
  await indexer.processPath(fixture.file);
  assert.equal(store.getRaw(id).alive,1,'失联根上的监听删除事件也不能误删索引');
});

test('同文件改名后拒绝旧路径的预览结果，允许当前路径重新提交',async()=>{
  const fixture=makeCase();await scope(fixture.root);fs.writeFileSync(fixture.file,'fixture');
  const original=meta(fixture.file),id=store.upsert(original).id;
  const renamed=path.join(fixture.root,'改名后的图纸.pdf');fs.renameSync(fixture.file,renamed);
  assert.equal(store.upsert(meta(renamed)).id,id);
  const version=`${original.modified}-${original.size}`;
  assert.equal(store.setPreview(id,version,{status:'error',text:'旧任务错误',preview:false},fixture.file),false);
  assert.equal(store.getRaw(id).content_status,'pending');
  assert.equal(store.setPreview(id,version,{status:'ready',text:'当前路径文字',preview:true,pages:1},renamed),true);
  assert.equal(store.getRaw(id).content,'当前路径文字');
});

test('错误子树补查期间根再次掉线时，也不能把失联文件当成删除',async()=>{
  const fixture=makeCase();await scope(fixture.root);
  const child=path.join(fixture.root,'暂不可读子树');fs.mkdirSync(child);
  const file=path.join(child,'保留.pdf');fs.writeFileSync(file,'fixture');
  const id=store.upsert(meta(file)).id;
  const originalRead=fs.promises.readdir,originalStat=fs.promises.stat;
  let disconnected=false;
  fs.promises.readdir=async(directory,...args)=>{
    if(directory===child){const error=new Error('fixture inaccessible subtree');error.code='EACCES';throw error;}
    return originalRead.call(fs.promises,directory,...args);
  };
  fs.promises.stat=async(candidate,...args)=>{
    // visitTree 读不到子树，第一次 stat(file) 必定发生在末尾可读性检查后的补查。
    if(candidate===file&&!disconnected){disconnected=true;fs.renameSync(fixture.root,fixture.root+'-offline');}
    return originalStat.call(fs.promises,candidate,...args);
  };
  try{
    await indexer.scan('disconnect-during-missing-reconcile');
    assert.equal(disconnected,true);assert.equal(store.getRaw(id).alive,1);
  }finally{fs.promises.readdir=originalRead;fs.promises.stat=originalStat;}
});

test('损坏的已有配置必须停止加载，不能悄悄扩大成默认全盘扫描',()=>{
  const data=path.join(temporary,'broken-config');fs.mkdirSync(data);
  fs.writeFileSync(path.join(data,'settings.json'),'{"roots": BROKEN','utf8');
  const env={...process.env,DRAWING_WORKBENCH_DATA:data};delete env.DRAWING_WORKBENCH_ROOTS;
  const run=spawnSync(process.execPath,['-e',`require(${JSON.stringify(path.resolve(__dirname,'../src/config.js'))})`],
    {env,encoding:'utf8',windowsHide:true});
  assert.notEqual(run.status,0);assert.match(run.stderr,/设置文件无法读取/);
  assert.equal(fs.readFileSync(path.join(data,'settings.json'),'utf8'),'{"roots": BROKEN');
});

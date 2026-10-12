'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const parent=path.resolve(__dirname,'../.test-tmp');fs.mkdirSync(parent,{recursive:true});
const temporary=fs.mkdtempSync(path.join(parent,'upgrade-start-')),root=path.join(temporary,'drawings');fs.mkdirSync(root);
process.env.DRAWING_WORKBENCH_DATA=path.join(temporary,'data');process.env.DRAWING_WORKBENCH_ROOTS=JSON.stringify([root]);process.env.DRAWING_WORKBENCH_SKIP_STARTUP_SCAN='1';
const config=require('../src/config'),store=require('../src/store'),indexer=require('../src/indexer');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,message){const end=Date.now()+5000;while(Date.now()<end){if(check())return;await delay(25);}assert.fail(message+JSON.stringify(indexer.status()));}
test('已有索引升级首次启动仅建立监听，仍索引新保存；之后重新启动恢复扫描',{timeout:15000},async()=>{
  const seed=path.join(root,'已有原图.dwg');fs.writeFileSync(seed,'fixture');
  const stat=fs.statSync(seed,{bigint:true}),id=store.upsert({path:seed,name:path.basename(seed),extension:'.dwg',size:Number(stat.size),modified:Number(stat.mtimeMs),fileKey:`${path.parse(seed).root.toLowerCase()}:${stat.dev}:${stat.ino}`}).id;
  store.classify(id,{project:'已有分类',tags:['人工标签']});
  const settings=fs.readFileSync(config.CONFIG_PATH),original=fs.promises.readdir;let enumerations=0;
  fs.promises.readdir=async function(dir,...args){if(config.contained(path.resolve(dir),root))enumerations++;return original.call(this,dir,...args);};
  try{
    indexer.start();await until(()=>indexer.status().watching.includes(root),'升级监听未建立');
    assert.equal(indexer.status().running,false);assert.equal(indexer.status().scanned,0);assert.equal(indexer.status().lastScanReason,'existing-index-startup');assert.equal(enumerations,0);
    assert.equal(store.getClassification(store.getRaw(id)).project,'已有分类');
    const added=path.join(root,'升级后新保存.pdf');fs.writeFileSync(added,'fixture-after-upgrade');
    await until(()=>store.search({q:'升级后新保存'}).total===1,'跳过初扫后新保存没有实时索引');
    assert.equal(enumerations,0);assert.equal(indexer.status().startedAt,null);assert.deepEqual(fs.readFileSync(config.CONFIG_PATH),settings);
    indexer.stop();indexer.start();await until(()=>indexer.status().finishedAt!==null&&!indexer.status().running,'一次性跳过标记未恢复正常扫描');
    assert.ok(enumerations>0);assert.equal(store.getClassification(store.getRaw(id)).project,'已有分类');assert.deepEqual(fs.readFileSync(config.CONFIG_PATH),settings);
  }finally{
    indexer.stop();fs.promises.readdir=original;store.close();assert.ok(temporary.startsWith(parent+path.sep));fs.rmSync(temporary,{recursive:true,force:true});
  }
});

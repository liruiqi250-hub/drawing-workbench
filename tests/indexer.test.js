'use strict';
require('node:fs').mkdirSync(require('node:path').resolve(__dirname,'../.test-tmp'),{recursive:true});
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

// 所有写入仅为 work 内的假图纸，不接触五盘实际图纸或软件正式数据库。
const work=path.resolve(__dirname,'../.test-tmp');
fs.mkdirSync(work,{recursive:true});
const temporary=fs.mkdtempSync(path.join(work,'indexer-test-'));
const root=path.join(temporary,'中文 图纸测试夹');
fs.mkdirSync(root,{recursive:true});
process.env.DRAWING_WORKBENCH_DATA=path.join(temporary,'isolated-data');
process.env.DRAWING_WORKBENCH_ROOTS=JSON.stringify([root]);
const config=require('../src/config');
const store=require('../src/store');
const indexer=require('../src/indexer');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function until(check,message,timeout=10000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){if(check())return;await delay(25);}
  assert.fail(`${message}；监听状态：${JSON.stringify(indexer.status())}`);
}
function at(p){return store.db.prepare('SELECT * FROM files WHERE path_key=?').get(config.pathKey(p));}

test('真实 Windows 递归监听和扫描衔接',{timeout:40000},async t=>{
  t.after(async()=>{
    indexer.stop();
    await until(()=>!indexer.status().running,'关闭测试扫描',3000);
    await delay(150);
    store.close();
    const relative=path.relative(work,temporary);
    assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'清理目标必须位于 work 内');
    fs.rmSync(temporary,{recursive:true,force:true});
  });
  const seed=path.join(root,'初次扫描种子.pdf');
  fs.writeFileSync(seed,'fixture PDF name only; no real PDF content','utf8');
  indexer.start();
  await until(()=>!indexer.status().running&&at(seed)?.alive===1,'初次扫描未发现已有文件');
  assert.deepEqual(indexer.status().watching,[root]);
  assert.deepEqual(indexer.status().watchErrors,[]);

  let folder=path.join(root,'新建项目','中文 子目录');
  let drawing=path.join(folder,'递归保存测试 钢架.dwg');
  let originalId;

  await t.test('新建多层目录后保存真实文件，无需手动重扫即可搜索',async()=>{
    fs.mkdirSync(folder,{recursive:true});
    fs.writeFileSync(drawing,'CAD fixture version 1','utf8');
    fs.writeFileSync(path.join(folder,'不可索引普通文本.txt'),'not a drawing','utf8');
    await until(()=>at(drawing)?.alive===1,'递归保存没有进入索引');
    const row=at(drawing);originalId=row.id;
    assert.equal(row.size,fs.statSync(drawing).size);
    assert.equal(store.search({q:'递归保存测试 钢架'}).total,1);
    assert.equal(store.search({q:'不可索引普通文本'}).total,0);
    assert.deepEqual(fs.readFileSync(drawing),Buffer.from('CAD fixture version 1'));
  });

  await t.test('覆盖保存更新大小与修改时间，保留人工分类',async()=>{
    store.classify(originalId,{project:'已确认测试项目',type:'结构图',tags:['人工标签']});
    const body='CAD fixture version 2 with a larger deterministic body';
    fs.writeFileSync(drawing,body,'utf8');
    await until(()=>at(drawing)?.size===Buffer.byteLength(body),'覆盖保存的元数据没有更新');
    const row=at(drawing);
    assert.equal(row.id,originalId);
    assert.equal(row.modified,Number(fs.statSync(drawing,{bigint:true}).mtimeMs));
    assert.equal(row.project,'已确认测试项目');
    assert.deepEqual(JSON.parse(row.tags),['人工标签']);
    assert.equal(fs.readFileSync(drawing,'utf8'),body);
  });

  await t.test('目录改名重新定位其图纸，保留 id 和分类并移除旧路径',async()=>{
    const oldDrawing=drawing;
    const renamed=path.join(path.dirname(folder),'改名后 子目录');
    fs.renameSync(folder,renamed);
    folder=renamed;drawing=path.join(folder,path.basename(drawing));
    await until(()=>at(drawing)?.alive===1&&!at(oldDrawing)?.alive,'目录改名没有完成索引迁移');
    const row=at(drawing);
    assert.equal(row.id,originalId);
    assert.equal(row.project,'已确认测试项目');
    assert.deepEqual(JSON.parse(row.tags),['人工标签']);
    assert.equal(store.search({q:'递归保存测试'}).total,1);
    assert.equal(store.getRaw(originalId).path,drawing);
  });

  await t.test('真实删除文件后自动从搜索结果移除',async()=>{
    fs.unlinkSync(drawing);
    await until(()=>at(drawing)?.alive===0,'删除文件仍显示为存在');
    assert.equal(store.search({q:'递归保存测试'}).total,0);
    assert.equal(store.getRaw(originalId).alive,0);
  });

  await t.test('扫描目录结束后发生的新保存，不被扫描收尾误清除',async()=>{
    // 关闭真实 watcher，避免下一次事件把错误清除的记录补回而掩盖竞态。
    // 通过真实 readdir 的门闩暂停扫描，精确在目录快照之后执行保存与 processPath。
    indexer.stop();
    await until(()=>!indexer.status().running,'准备竞态测试前扫描尚未结束');
    config.saveSettings({watch:false});
    const blocker=path.join(root,'扫描门闩目录');
    fs.mkdirSync(blocker,{recursive:true});
    const readdir=fs.promises.readdir;
    let release,armed=true;
    const gate=new Promise(resolve=>{release=resolve;});
    fs.promises.readdir=async function(dir,options){
      const entries=await readdir.call(this,dir,options);
      if(armed&&path.resolve(dir)===blocker){armed=false;await gate;}
      return entries;
    };
    try{
      indexer.start();
      await until(()=>!armed,'扫描未到达门闩目录',5000);
      const concurrent=path.join(root,'扫描快照之后新增.dwg');
      fs.writeFileSync(concurrent,'fixture saved after root readdir','utf8');
      await indexer.processPath(concurrent);
      assert.equal(at(concurrent)?.alive,1,'事件处理应先写入索引');
      release();
      await until(()=>!indexer.status().running,'扫描未结束');
      assert.equal(at(concurrent)?.alive,1,'扫描收尾不得清除已处理的新保存');
      assert.equal(store.search({q:'扫描快照之后新增'}).total,1);
    }finally{
      release();
      fs.promises.readdir=readdir;
    }
  });
});

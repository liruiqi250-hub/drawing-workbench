'use strict';
require('node:fs').mkdirSync(require('node:path').resolve(__dirname,'../.test-tmp'),{recursive:true});
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

// 每个 Node 测试文件运行在独立进程；数据库与假图纸均只落在工作区 work。
const work=path.resolve(__dirname,'../.test-tmp');
fs.mkdirSync(work,{recursive:true});
const temporary=fs.mkdtempSync(path.join(work,'store-test-'));
const root=path.join(temporary,'中文 图纸夹');
fs.mkdirSync(root,{recursive:true});
process.env.DRAWING_WORKBENCH_DATA=path.join(temporary,'isolated-data');
process.env.DRAWING_WORKBENCH_ROOTS=JSON.stringify([root]);
const config=require('../src/config');
const store=require('../src/store');

test.beforeEach(()=>{
  store.db.exec('DELETE FROM files; DELETE FROM events;');
  store.invalidateStats();
});
test.after(()=>{
  store.close();
  fs.rmSync(temporary,{recursive:true,force:true});
});

function metadata(file){
  const stat=fs.statSync(file);
  return {path:file,name:path.basename(file),extension:path.extname(file).toLowerCase(),
    size:stat.size,modified:Math.trunc(stat.mtimeMs),fileKey:`${stat.dev}:${stat.ino}`};
}
function fixture(name,body='fixture only: not a CAD drawing'){
  const file=path.join(root,name);fs.writeFileSync(file,body,'utf8');
  const meta=metadata(file);return {file,meta,id:store.upsert(meta).id};
}

test('中文多词搜索会合并文件名、项目、标签与真实已提取内容',()=>{
  const dinosaur=fixture('展会霸王龙 钢架.dwg');
  fixture('电机安装.dwg');
  store.classify(dinosaur.id,{project:'成都展会',type:'钢架结构',tags:['机械组','制作中']});
  assert.equal(store.setPreview(dinosaur.id,store.contentVersion(store.getRaw(dinosaur.id)),
    {status:'ready',text:'本机提取的特殊电机座说明',preview:true,pages:1}),true);
  for(const query of ['霸王龙','成都展会 机械组','特殊电机座','展会 钢架']){
    const found=store.search({q:query});assert.equal(found.total,1,query);
    assert.equal(found.items[0].id,dinosaur.id,query);
  }
  assert.equal(store.search({q:'霸王龙 不存在的内容'}).total,0);
});

test('百分号和下划线作为字面字符搜索，不能扩张为 SQL 通配符',()=>{
  const percent=fixture('进度100%完成.pdf');
  const underscore=fixture('零件a_b.dwg');
  fixture('进度100完成.pdf');fixture('零件axb.dwg');
  assert.deepEqual(store.search({q:'%'}).items.map(row=>row.id),[percent.id]);
  assert.deepEqual(store.search({q:'a_'}).items.map(row=>row.id),[underscore.id]);
  assert.deepEqual(store.search({q:'a_b'}).items.map(row=>row.id),[underscore.id]);
});

test('搜索和项目过滤使用参数，注入字符串不能返回全部记录或破坏表',()=>{
  const one=fixture('普通甲.dwg'),two=fixture('普通乙.pdf');
  const injection="施工' OR 1=1 --";
  store.classify(one.id,{project:injection,type:'装配'});
  store.classify(two.id,{project:'正常项目',type:'装配'});
  assert.equal(store.search({q:"%' OR 1=1 --"}).total,0);
  const exact=store.search({project:injection});
  assert.equal(exact.total,1);assert.equal(exact.items[0].id,one.id);
  assert.throws(()=>store.classify("x' OR 1=1 --",{project:'注入'}),/不存在/);
  assert.equal(store.search().total,2);
  assert.equal(store.getClassification(store.getRaw(two.id)).project,'正常项目');
});

test('同一文件改名后保留 id、人工分类和标签，不向源文件写分类信息',()=>{
  const entry=fixture('改名前 钢架.dwg');
  const original=fs.readFileSync(entry.file);
  store.classify(entry.id,{project:'已确认项目',type:'人工类型',tags:['审核通过']});
  const renamed=path.join(root,'改名后 中文.dwg');
  fs.renameSync(entry.file,renamed);
  const changed=store.upsert(metadata(renamed));
  assert.equal(changed.id,entry.id);
  const row=store.publicFile(store.getRaw(entry.id),true);
  assert.equal(row.name,'改名后 中文.dwg');assert.equal(row.path,renamed);
  assert.equal(row.project,'已确认项目');assert.equal(row.type,'人工类型');
  assert.equal(row.classified,true);assert.deepEqual(row.tags,['审核通过']);
  assert.deepEqual(fs.readFileSync(renamed),original);
  assert.equal(store.search().total,1);
});

test('保存改变内容后重置旧文本和预览状态，拒绝较旧版本的异步结果',()=>{
  const entry=fixture('覆盖保存.pdf','first fixture');
  const oldVersion=store.contentVersion(store.getRaw(entry.id));
  store.setPreview(entry.id,oldVersion,{status:'ready',text:'旧文字内容',preview:true,pages:3});
  store.classify(entry.id,{project:'保留项目',type:'文件类型'});
  fs.writeFileSync(entry.file,'new fixture body with a changed length','utf8');
  const updated=store.upsert(metadata(entry.file));
  assert.equal(updated.id,entry.id);assert.equal(updated.changed,true);
  let row=store.getRaw(entry.id);
  assert.equal(row.content,'');assert.equal(row.content_status,'pending');
  assert.equal(row.preview_status,'pending');assert.equal(store.getClassification(row).project,'保留项目');
  assert.equal(store.search({q:'旧文字内容'}).total,0);
  assert.equal(store.setPreview(entry.id,oldVersion,
    {status:'ready',text:'过期任务不能覆盖',preview:true,pages:3}),false);
  row=store.getRaw(entry.id);assert.equal(row.content,'');
});

test('配置拒绝相对扫描路径，范围与排除检查生效，AI仅允许固定DeepSeek端点且不保存Key',()=>{
  assert.throws(()=>config.validateSettings({roots:['relative-folder']}),/完整/);
  const settings=config.validateSettings({roots:[root],excludeDirs:['排除目录'],
    ai:{enabled:true,provider:'external',baseUrl:'https://example.invalid'}});
  assert.equal(settings.ai.provider,'deepseek');assert.equal(settings.ai.baseUrl,'https://api.deepseek.com');
  assert.equal(settings.ai.enabled,true);assert.equal(settings.ai.sendPdfText,false);
  assert.equal(config.validateAiSettings({apiKey:'not-stored'}).apiKey,undefined);
  assert.equal(config.validateSettings({ai:{provider:'disabled',model:'',baseUrl:'',enabled:false}}).ai.model,'deepseek-flash');
  assert.throws(()=>config.validateAiSettings({candidateLimit:101}),/范围/);
  assert.equal(config.isAllowed(path.join(root,'可读.pdf'),settings),true);
  assert.equal(config.isAllowed(path.join(root,'排除目录','私有.pdf'),settings),false);
  assert.equal(config.isAllowed(path.join(temporary,'外部.pdf'),settings),false);
  assert.equal(config.isAllowed(path.join(root,'文本.txt'),settings),false);
});

test('图号派生支持标准日期检索及订单批次导航，保留人工分类',()=>{
  const entry=fixture('26-10.29-03 霸王龙4米.dwg');
  const other=fixture('26-10.30-03 霸王龙4米.dwg');
  const named=store.publicFile(store.getRaw(entry.id));
  assert.equal(named.naming.drawingNumber,'26-10.29-03');
  assert.equal(named.naming.orderDate,'2026-10-29');assert.equal(named.naming.productionSerial,'03');
  assert.equal(named.suggestion.project,'2026-10-29');
  assert.ok(named.suggestion.tags.includes('霸王龙'));
  assert.deepEqual(store.search({q:'2026-10-29 霸王龙',orderBatch:'26-10.29'}).items.map(row=>row.id),[entry.id]);
  assert.equal(store.search({projectKind:'order',format:'DWG'}).total,2);
  assert.equal(store.search({orderBatch:"26-10.29' OR 1=1 --"}).total,0);
  store.classify(entry.id,{project:'人工项目',type:'已审',tags:['人工标签']});
  store.db.prepare("UPDATE files SET naming_json='{}',naming_search='',order_batch='',project_kind='unknown' WHERE id=?").run(entry.id);
  store.db.prepare("DELETE FROM app_meta WHERE key='naming_version'").run();store.migrateNaming();
  const migrated=store.publicFile(store.getRaw(entry.id));
  assert.equal(migrated.project,'人工项目');assert.equal(migrated.type,'已审');assert.deepEqual(migrated.tags,['人工标签']);
  assert.equal(migrated.naming.orderBatch,'26-10.29');assert.equal(migrated.id,entry.id);
  assert.equal(store.getRaw(other.id).classified,0);
  store.invalidateStats();assert.ok(store.stats().orderBatches.some(row=>row.name==='2026-10-29'&&row.count===1));
});

test('展会备份识别独立于项目分类，不把备份日期或归档年月当订单日期',()=>{
  const backup=fixture('郑州展会平面图 2026-03-02 14_52_26.dwg');
  fixture('展会霸王龙3米.dwg');fixture('普通钢架.dwg');
  const file=store.publicFile(store.getRaw(backup.id));
  assert.equal(file.naming.projectKind,'exhibition');assert.equal(file.naming.orderDate,'');
  assert.equal(file.naming.isBackup,true);assert.equal(file.suggestion.project,'郑州展会');
  assert.equal(store.search({projectKind:'exhibition'}).total,2);
  assert.deepEqual(store.search({projectKind:'exhibition',backup:'only'}).items.map(row=>row.id),[backup.id]);
  assert.equal(store.search({projectKind:'exhibition',backup:'exclude'}).total,1);
  assert.equal(store.stats().backupCount,1);assert.equal(store.getRaw(backup.id).classified,0);
  assert.throws(()=>store.search({backup:'unexpected'}),/无效/);
});

test('重命名后重新识别订单批次与尺寸，保留同一ID及人工分类',()=>{
  const entry=fixture('26-10.29-03 霸王龙4米.dwg');store.classify(entry.id,{project:'不变项目',tags:['已核对']});
  const renamed=path.join(root,'26-11.1-05 霸王龙6米.dwg');fs.renameSync(entry.file,renamed);
  assert.equal(store.upsert(metadata(renamed)).id,entry.id);
  const file=store.publicFile(store.getRaw(entry.id));
  assert.equal(file.naming.orderBatch,'26-11.1');assert.equal(file.naming.productSize,'6米');
  assert.equal(file.project,'不变项目');assert.equal(store.search({orderBatch:'26-10.29'}).total,0);
  assert.equal(store.search({orderBatch:'26-11.1'}).total,1);
});

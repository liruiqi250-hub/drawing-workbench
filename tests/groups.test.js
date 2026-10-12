'use strict';
require('node:fs').mkdirSync(require('node:path').resolve(__dirname,'../.test-tmp'),{recursive:true});
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const work=path.resolve(__dirname,'../.test-tmp'),temp=fs.mkdtempSync(path.join(work,'groups-test-'));
process.env.DRAWING_WORKBENCH_DATA=path.join(temp,'data');process.env.DRAWING_WORKBENCH_ROOTS=JSON.stringify([temp]);
const config=require('../src/config'),store=require('../src/store'),aiStore=require('../src/ai-store');
const {groupIdentity}=require('../src/drawing-groups'),{parseDrawingName}=require('../src/drawing-names');
function add(name,folder='source',body='read-only fixture'){
  const file=path.join(temp,folder,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body);
  const stat=fs.statSync(file),meta={path:file,name,extension:path.extname(file).toLowerCase(),size:stat.size,modified:stat.mtimeMs,fileKey:`${stat.dev}:${stat.ino}`};
  return {file,id:store.upsert(meta).id};
}
function mapping(){config.saveSettings({groupingRules:[{name:'已确认自动备份来源',backupRoot:path.join(temp,'archive'),sourceRoot:path.join(temp,'source'),enabled:true}]});store.migrateGroups();store.invalidateStats();}
test.beforeEach(()=>{store.db.exec('DELETE FROM files;DELETE FROM events;');config.saveSettings({groupingRules:[],versionGrouping:true});store.migrateGroups(true);store.invalidateStats();});
test.after(()=>{store.close();const absolute=path.resolve(temp);assert.ok(absolute.startsWith(work+path.sep));fs.rmSync(absolute,{recursive:true,force:true});});

test('映射备份后默认原图；搜索备份特有时间与备份入口仍返回原图，源文件逐字保留',()=>{
  const original=add('郑州展会平面图.dwg'),a=add('郑州展会平面图 2026-03-02 14_41_24.dwg','archive','old drawing'),b=add('郑州展会平面图 2026-03-02 14_52_26.dwg','archive','later drawing');mapping();
  for(const query of [{q:'郑州展会'},{q:'14_41_24'},{backup:'only'}]){
    const found=store.search(query);assert.equal(found.total,1);assert.equal(found.items[0].id,original.id);assert.equal(found.items[0].group.versionCount,3);
  }
  const detail=store.publicFile(store.getRaw(original.id),true);assert.equal(detail.versions.length,3);assert.equal(detail.group.backupCount,2);
  assert.equal(detail.versions[0].isRepresentative,true);assert.equal(detail.versions[1].id,b.id);
  assert.equal(fs.readFileSync(a.file,'utf8'),'old drawing');assert.equal(fs.readFileSync(b.file,'utf8'),'later drawing');assert.equal(store.search({grouped:'0'}).total,3);
});
test('非备份命名目录服从明确映射，停用规则可逆且不覆盖人工分类',()=>{
  const original=add('展会霸王龙3米.dwg'),backup=add('展会霸王龙3米.dwg','archive','copy');
  store.classify(original.id,{project:'已确认展会',type:'钢架',tags:['保留']});mapping();
  assert.equal(store.search().total,1);assert.equal(store.search().items[0].id,original.id);assert.equal(store.search({pending:true}).total,0);assert.equal(store.search({pending:true,q:'展会'}).matchingFiles,0);assert.equal(store.stats().pending,0);assert.equal(store.getRaw(backup.id).is_backup,1);
  config.saveSettings({groupingRules:[]});store.migrateGroups();store.invalidateStats();assert.equal(store.search().total,2);assert.equal(store.getRaw(backup.id).is_backup,0);
  assert.equal(store.getRaw(original.id).project,'已确认展会');assert.equal(store.getRaw(original.id).tags,'["保留"]');
});
test('只有备份时选备份时间最新者；新增原图即时优先，失效时回退，磁盘文件仍存在',()=>{
  const a=add('展会西方龙 2026-03-02 14_41_24.dwg'),b=add('展会西方龙 2026-03-02 14_52_26.dwg');
  assert.equal(store.search().total,1);assert.equal(store.search().items[0].id,b.id);assert.equal(store.search().items[0].group.hasOriginal,false);
  const original=add('展会西方龙.dwg');assert.equal(store.search().items[0].id,original.id);
  store.markMissing(original.file);assert.equal(store.search().items[0].id,b.id);assert.ok(fs.existsSync(original.file));assert.ok(fs.existsSync(a.file));
});
test('多层时间戳去除，但跨目录同名、跨格式、模型后缀、不同产品序号绝不误并',()=>{
  const a=add('双冠龙6米展会样式.dwg'),b=add('双冠龙6米展会样式 2026-03-05 15_12_05 2026-07-10 14_15_58.dwg');
  add('双冠龙6米展会样式.dwg','other-project');add('双冠龙6米展会样式.pdf');add('双冠龙6米展会样式-Model.pdf');
  add('26-10.29-01霸王龙4米.dwg');add('26-10.29-01霸王龙6米.dwg');add('26-10.29-02霸王龙4米.dwg');
  assert.equal(store.search().total,7);assert.equal(store.publicFile(store.getRaw(a.id)).group.versionCount,2);assert.equal(store.publicFile(store.getRaw(b.id)).naming.baseName,'双冠龙6米展会样式');
  const parsed=parseDrawingName('展会霸王龙3.2米 2026-05-11 14_05_04-模型.pdf');assert.equal(parsed.baseName,'展会霸王龙3.2米-模型');assert.equal(parsed.backupTimestamp,'2026-05-11T14:05:04');assert.equal(parseDrawingName('图纸 2026-02-30 14_05_04.dwg').isBackup,false);
});
test('归组后分页准确，备份不会占后续页；关闭归组显示所有原始文件',()=>{
  for(let i=0;i<15;i++){const name=`图${String(i).padStart(2,'0')}`;add(name+'.dwg');for(let j=1;j<=3;j++)add(`${name} 2026-03-02 14_52_0${j}.dwg`);}
  const page1=store.search({sort:'name',limit:10}),page2=store.search({sort:'name',limit:10,page:2});
  assert.equal(page1.total,15);assert.equal(page1.items.length,10);assert.equal(page2.items.length,5);assert.equal(new Set([...page1.items,...page2.items].map(f=>f.id)).size,15);
  assert.equal(store.search({grouped:'0'}).total,60);assert.equal(store.stats().physicalTotal,60);assert.equal(store.stats().groupTotal,15);
  config.saveSettings({versionGrouping:false});store.invalidateStats();assert.equal(store.search().total,60);assert.equal(store.stats().total,60);
});
test('AI 候选上限前按组去重，返回原图且不发送绝对路径',()=>{
  const original=add('霸王龙钢架0.dwg');for(let i=0;i<25;i++)add(`霸王龙钢架0 2026-03-02 14_52_${String(i).padStart(2,'0')}.dwg`);
  for(let i=1;i<21;i++)add(`霸王龙钢架${i}.dwg`);
  const candidates=aiStore.candidates({groups:[['霸王龙']],keywords:['钢架']},{},20,false);
  assert.equal(candidates.length,20);assert.equal(new Set(candidates.map(f=>f.id)).size,20);assert.ok(candidates.every(f=>!f.naming.isBackup&&!f.path));assert.equal(aiStore.candidates({groups:[['14_52_03']]},{},20,false)[0].id,original.id);
});
test('Windows 路径映射不能匹配名称相似的目录',()=>{
  const rules=[{name:'E盘',backupRoot:'D:\\cad自动备份\\E',sourceRoot:'E:\\',enabled:true}],p=path.win32;
  const file={name:'郑州展会平面图 2026-03-02 14_52_26.dwg',extension:'.dwg',path:'D:\\cad自动备份\\E\\订单\\郑州展会平面图 2026-03-02 14_52_26.dwg'};
  assert.equal(groupIdentity(file,parseDrawingName(file.name),rules,p).key,'e:\\订单\\郑州展会平面图.dwg');const other={...file,path:file.path.replace('\\E\\','\\E-other\\')};assert.equal(groupIdentity(other,parseDrawingName(other.name),rules,p).mapped,false);
});
test('映射设置拒绝相同或重叠目录及重复启用来源',()=>{
  assert.throws(()=>config.validateSettings({groupingRules:[{backupRoot:temp,sourceRoot:path.join(temp,'child')}]}),/位于/);
  const rule={name:'来源',backupRoot:path.join(temp,'archive'),sourceRoot:path.join(temp,'source')};assert.throws(()=>config.validateSettings({groupingRules:[rule,rule]}),/只能启用一条/);
});

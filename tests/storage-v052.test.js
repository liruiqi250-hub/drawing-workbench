'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const work=path.resolve(__dirname,'../.test-tmp');fs.mkdirSync(work,{recursive:true});
const temporary=fs.mkdtempSync(path.join(work,'storage-v052-')),root=path.join(temporary,'drawings');fs.mkdirSync(root);
process.env.DRAWING_WORKBENCH_DATA=path.join(temporary,'data');process.env.DRAWING_WORKBENCH_ROOTS=JSON.stringify([root]);
const config=require('../src/config'),store=require('../src/store'),indexer=require('../src/indexer');
function meta(file,identity){const stat=fs.statSync(file,{bigint:true});return {path:file,name:path.basename(file),extension:path.extname(file),size:Number(stat.size),modified:Number(stat.mtimeMs),fileKey:identity||`${path.parse(file).root.toLowerCase()}:${stat.dev}:${stat.ino}`};}
function add(name,folder='',identity){const file=path.join(root,folder,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'synthetic only');return {file,id:store.upsert(meta(file,identity)).id};}
function raw(entry){return store.getRaw(entry.id);}
function legacy(entry,project,type,tags=[]){store.db.prepare('UPDATE files SET project=?,type=?,tags=?,classified=1 WHERE id=?').run(project,type,JSON.stringify(tags),entry.id);}
test.beforeEach(()=>{store.db.exec('DELETE FROM files;DELETE FROM events;DELETE FROM classification_members;DELETE FROM group_confirmations;DELETE FROM group_classifications');config.saveSettings({roots:[root],groupingRules:[],excludeDirs:[],versionGrouping:true,watch:false});store.invalidateStats();});
test.after(()=>{indexer.stop();store.close();assert.ok(path.resolve(temporary).startsWith(work+path.sep));fs.rmSync(temporary,{recursive:true,force:true});});

test('同日期补零批次使用规范键导航及规则项目，字母批次独立，迁移不改原图号',()=>{
  const a=add('26-7.2-01 恐龙.dwg'),b=add('26-07.02-02 恐龙.dwg'),c=add('26-07.02A-03 恐龙.dwg'),d=add('26-7.2B-04 恐龙.dwg');
  store.db.prepare("UPDATE app_meta SET value='0.4.0' WHERE key='naming_version'").run();store.migrateNaming();
  assert.equal(store.search({orderBatch:'26-7.02'}).total,2);assert.equal(store.search({orderBatch:'2026-07-02A'}).total,1);assert.equal(store.search({orderBatch:'26-07.2B'}).total,1);
  assert.deepEqual(store.stats().orderBatches.map(item=>item.name).sort(),['2026-07-02','2026-07-02A','2026-07-02B']);
  assert.equal(store.namingFor(raw(a)).orderBatch,'26-7.2');assert.equal(store.namingFor(raw(b)).drawingNumber,'26-07.02-02');
  assert.equal(store.suggestion(raw(a)).project,store.suggestion(raw(b)).project);assert.notEqual(store.suggestion(raw(c)).project,store.suggestion(raw(d)).project);
});

test('A 改名占 B 历史路径时保留 A 身份和分类，B 墓碑保留路径与分类而不复活',()=>{
  const a=add('身份 A.dwg','collision','identity-A'),b=add('身份 B.dwg','collision','identity-B');
  legacy(a,'项目 A','类型 A',['A原分类']);legacy(b,'项目 B','类型 B',['B原分类']);
  store.classify(a.id,{project:'确认 A',type:'共用 A'});store.classify(b.id,{project:'确认 B',type:'共用 B'});
  fs.unlinkSync(b.file);store.markMissing(b.file);fs.renameSync(a.file,b.file);
  assert.equal(store.upsert(meta(b.file,'identity-A')).id,a.id);assert.equal(raw(a).path,b.file);assert.equal(store.getClassification(raw(a)).project,'确认 A');
  assert.equal(raw(b).alive,0);assert.equal(raw(b).path,b.file);assert.equal(raw(b).project,'项目 B');assert.equal(store.getClassification(raw(b)).project,'确认 B');
  assert.equal(store.search({project:'确认 B'}).total,0);assert.equal(store.search({project:'确认 A'}).total,1);
  const replacement=store.upsert({...meta(b.file,'identity-C')});assert.notEqual(replacement.id,a.id);assert.notEqual(replacement.id,b.id);assert.equal(store.getClassification(store.getRaw(replacement.id)).classified,false);
});

test('同长同时间的物理身份替换使签名改变并拒绝旧异步预览，不继承旧版分类',()=>{
  const entry=add('身份替换.pdf','replacement','first-identity'),previous=raw(entry),stamp=store.contentVersion(previous);
  store.classify(entry.id,{project:'历史项目'});assert.equal(store.setPreview(entry.id,stamp,{status:'ready',text:'旧内容',preview:true}),true);
  const next=store.upsert({...meta(entry.file,'second-identity'),size:previous.size,modified:previous.modified});
  assert.equal(next.changed,true);assert.notEqual(next.id,entry.id);assert.notEqual(store.contentVersion(store.getRaw(next.id)),stamp);assert.equal(store.getRaw(next.id).content_revision,previous.content_revision+1);assert.equal(raw(entry).alive,0);
  assert.equal(store.getClassification(store.getRaw(next.id)).classified,false);assert.equal(store.setPreview(entry.id,stamp,{status:'ready',text:'过期内容',preview:true}),false);
});

test('普通扫描不失效，同长同时间 change 强制递增修订并拒绝未完成的旧预览',async()=>{
  const entry=add('监听同长.pdf','forcechange'),before=raw(entry),stamp=store.contentVersion(before);
  assert.equal(store.setPreview(entry.id,stamp,{status:'ready',text:'原文字',preview:true}),true);
  assert.equal(store.upsert(meta(entry.file)).changed,false);assert.equal(store.contentVersion(raw(entry)),stamp);
  await indexer.processPath(entry.file,0,'change');const after=raw(entry);
  assert.equal(after.id,entry.id);assert.equal(after.size,before.size);assert.equal(after.modified,before.modified);assert.equal(after.content_revision,before.content_revision+1);assert.equal(after.content_status,'pending');assert.equal(after.content,'');
  assert.equal(store.setPreview(entry.id,stamp,{status:'ready',text:'不得覆盖',preview:true}),false);assert.equal(store.setPreview(entry.id,store.contentVersion(after),{status:'ready',text:'新文字',preview:true}),true);
});

test('legacy 迁移无损合并标签，保留完整冲突变体；明确整组确认才解决冲突',()=>{
  const a=add('分类迁移.dwg','legacy'),b=add('分类迁移 2026-03-02 14_52_26.dwg','legacy');legacy(a,'同项目','钢架',['甲']);legacy(b,'同项目','钢架',['乙']);
  store.migrateGroups(true);let classification=store.getClassification(raw(a));assert.equal(classification.classified,true);assert.equal(classification.conflict,false);assert.deepEqual([...classification.tags].sort(),['乙','甲']);assert.deepEqual(JSON.parse(raw(a).tags),['甲']);
  legacy(b,'冲突项目','总装',['乙']);classification=store.getClassification(raw(a));assert.equal(classification.conflict,true);assert.equal(classification.classified,false);assert.equal(classification.variants.length,2);assert.equal(store.stats().pending,1);
  assert.throws(()=>store.classify(a.id,{project:'共同项目'}),error=>error.status===409);
  store.db.exec('BEGIN');store.classify(a.id,{project:'共同项目',type:'共同类型',tags:['确认'],resolveConflict:true});store.db.exec('COMMIT');
  assert.equal(store.getClassification(raw(a)).conflict,false);assert.equal(store.search({pending:true}).total,0);assert.equal(raw(a).project,'同项目');assert.equal(raw(b).project,'冲突项目');assert.equal(store.publicFile(raw(a),true).versions.find(item=>item.id===b.id).versionClassification.project,'冲突项目');
});

test('标签并集超过 50 不静默截断，明确确认前保留全部标签和版本原值',()=>{
  const a=add('标签集合.dwg','tags'),b=add('标签集合 2026-03-02 14_52_26.dwg','tags');legacy(a,'项目','类型',Array.from({length:30},(_,i)=>'A'+i));legacy(b,'项目','类型',Array.from({length:30},(_,i)=>'B'+i));
  const c=store.getClassification(raw(a));assert.equal(c.tags.length,60);assert.equal(c.conflict,true);assert.equal(c.variants[0].tags.length,30);assert.equal(c.variants[1].tags.length,30);assert.equal(store.search({pending:true}).total,1);
});

test('先分类仅备份组再新增原图，代表变化后仍已整理；显式版本分类会重新检查冲突',()=>{
  const backup=add('先备份分类 2026-03-02 14_52_26.dwg','backup-first');store.classify(backup.id,{project:'已确认项目',type:'钢架',tags:['已审']});
  const original=add('先备份分类.dwg','backup-first');assert.equal(store.search().items[0].id,original.id);assert.equal(store.getClassification(raw(original)).classified,true);assert.equal(store.stats().pending,0);assert.equal(raw(original).classified,0);
  store.classify(original.id,{scope:'version',project:'新版本项目',type:'其他类型'});assert.equal(store.getClassification(raw(original)).conflict,true);assert.equal(raw(original).project,'新版本项目');assert.equal(raw(backup).project,'');
});

test('组检索允许项目、主题、备份时间和 only 分别命中不同版本，AI 保留实际匹配备份证据',()=>{
  const original=add('组主题钢架.dwg','evidence'),backup=add('组主题钢架 2026-03-02 14_52_26.dwg','evidence');store.classify(original.id,{project:'客户共同项目',type:'结构'});
  assert.equal(store.search({q:'客户共同项目 14_52_26',project:'客户共同项目',backup:'only'}).items[0].id,original.id);
  const candidates=store.candidateRows({groups:[['客户共同项目','同义词'],['14_52_26']],keywords:['钢架']},{project:'客户共同项目',backup:'only'},20,false);
  assert.equal(candidates.length,1);assert.equal(candidates[0].row.id,original.id);assert.ok(candidates[0].evidenceRows.some(row=>row.id===backup.id&&row.is_backup===1));assert.equal(store.search({q:'14_52_26',grouped:'0',project:'客户共同项目'}).total,0);
});

test('规则重映射和排除不丢已确认分类；被排除版本不能继续满足组主题',()=>{
  const original=add('重映射.dwg','source'),backup=add('重映射 2026-03-02 14_52_26.dwg','archive');
  config.saveSettings({groupingRules:[{name:'映射一',backupRoot:path.join(root,'archive'),sourceRoot:path.join(root,'source'),enabled:true}]});store.migrateGroups();store.classify(backup.id,{project:'永久共同分类',source:'manual'});
  config.saveSettings({groupingRules:[]});store.migrateGroups();assert.equal(store.getClassification(raw(original)).project,'永久共同分类');assert.equal(store.getClassification(raw(backup)).project,'永久共同分类');assert.equal(store.getClassification(raw(backup)).source,'manual');
  config.saveSettings({groupingRules:[{name:'映射二',backupRoot:path.join(root,'archive'),sourceRoot:path.join(root,'source'),enabled:true}]});store.migrateGroups();assert.equal(store.search().total,1);
  config.saveSettings({excludeDirs:[path.join(root,'archive')]});store.pruneScope(config.getSettings());store.invalidateStats();assert.equal(raw(backup).alive,0);assert.equal(store.search({q:'14_52_26'}).total,0);assert.equal(store.candidateRows({groups:[['14_52_26']]},{},20).length,0);assert.equal(store.getClassification(raw(original)).project,'永久共同分类');assert.equal(store.getClassification(raw(backup)).project,'永久共同分类');
});

test('missing 的旧人工验收行迁移后保留分类和 alive=0，不为计数复活',()=>{
  const sample=add('历史验收样本.dwg','missing');legacy(sample,'历史项目','历史类型',['历史标签']);store.markMissing(sample.file);store.migrateGroups(true);store.migrateNaming();
  assert.equal(raw(sample).alive,0);assert.equal(raw(sample).project,'历史项目');assert.equal(store.getClassification(raw(sample)).project,'历史项目');assert.equal(store.search().total,0);assert.equal(store.stats().total,0);
});

test('已分别确认的两个组重映射合组时明示共同分类冲突，保留真实 choices 供界面复核',()=>{
  const original=add('共同确认冲突.dwg','choices-source'),backup=add('共同确认冲突.dwg','choices-backup');
  store.classify(original.id,{project:'共同确认甲',type:'甲型'});store.classify(backup.id,{project:'共同确认乙',type:'乙型'});
  config.saveSettings({groupingRules:[{name:'冲突映射',backupRoot:path.join(root,'choices-backup'),sourceRoot:path.join(root,'choices-source'),enabled:true}]});store.migrateGroups();
  const classification=store.getClassification(raw(original));assert.equal(classification.conflict,true);assert.equal(classification.variants.every(item=>!item.project),true);assert.deepEqual(classification.confirmedVariants.map(item=>item.project).sort(),['共同确认乙','共同确认甲']);
  assert.equal(store.publicFile(raw(original)).contentVersion,store.contentVersion(raw(original)));
});

test('八个独立主题分散到八个备份版本时 AI 证据全部覆盖，不只截取前六个版本',()=>{
  const original=add('八主题样本.pdf','eight-evidence'),members=[original];
  for(let i=0;i<8;i++){const member=add(`八主题样本 2026-03-02 14_52_0${i}.pdf`,'eight-evidence');members.push(member);store.setPreview(member.id,store.contentVersion(raw(member)),{status:'ready',text:`独有主题${i}标识`,preview:false});}
  const groups=Array.from({length:8},(_,i)=>[`独有主题${i}标识`]);
  const candidates=store.candidateRows({groups},{backup:'only'},20,true);assert.equal(candidates.length,1);assert.equal(candidates[0].row.id,original.id);assert.equal(candidates[0].evidenceRows.length,8);
  for(const group of groups)assert.ok(candidates[0].evidenceRows.some(row=>row.content.includes(group[0])),group[0]);
});

test('八个独立主题和额外独立备份条件需要第九条证据，所有主题仍完整保留',()=>{
  const original=add('九证据样本.pdf','nine-source');
  for(let i=0;i<8;i++){const member=add(`九证据样本 ${i}.pdf`,'nine-source');store.db.prepare('UPDATE files SET group_key=? WHERE id=?').run(raw(original).group_key,member.id);store.setPreview(member.id,store.contentVersion(raw(member)),{status:'ready',text:`独占条件${i}标识`,preview:false});}
  const backup=add('九证据样本 2026-03-02 14_52_26.pdf','nine-source');const groups=Array.from({length:8},(_,i)=>[`独占条件${i}标识`]);
  const candidates=store.candidateRows({groups},{backup:'only'},20,true);assert.equal(candidates.length,1);assert.equal(candidates[0].evidenceRows.length,9);assert.ok(candidates[0].evidenceRows.some(row=>row.id===backup.id));
  for(const group of groups)assert.ok(candidates[0].evidenceRows.some(row=>row.content.includes(group[0])),group[0]);
});

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
  for(const grouped of [true,false]){
    config.saveSettings({versionGrouping:grouped});store.invalidateStats();
    assert.deepEqual(store.stats().orderBatches.map(item=>({...item})),[{name:'2026-07-02B',count:1},{name:'2026-07-02A',count:1},{name:'2026-07-02',count:2}]);
  }
  assert.equal(store.namingFor(raw(a)).orderBatch,'26-7.2');assert.equal(store.namingFor(raw(b)).drawingNumber,'26-07.02-02');
  assert.equal(store.suggestion(raw(a)).project,store.suggestion(raw(b)).project);assert.notEqual(store.suggestion(raw(c)).project,store.suggestion(raw(d)).project);
});

for(const grouped of [true,false])test(`超过 200 批订单先按规范日期倒序取最近 100 批，保留小订单及${grouped?'归组':'物理文件'}计数`,()=>{
  config.saveSettings({versionGrouping:grouped});
  const keys=[];let secondNewest='';
  for(let day=0;day<241;day++){
    const date=new Date(Date.UTC(2026,0,1+day)),key=date.toISOString().slice(0,10);
    const batch=`26-${date.getUTCMonth()+1}.${date.getUTCDate()}`;keys.push(key);
    for(let serial=1;serial<=(day===240?1:4);serial++){
      const extension=day===240?'.pdf':'.dwg',name=`${batch}-${serial} 导航样本${extension}`;
      const entry=add(name,'navigation');legacy(entry,day===240?'近期小订单':'大量旧订单',day===240?'近期类型':'大量类型');
      if(day===239&&serial===1)secondNewest=name.slice(0,-extension.length);
    }
  }
  for(const timestamp of ['2026-09-01 10_00_00','2026-09-02 10_00_00'])add(`${secondNewest} ${timestamp}.dwg`,'navigation');
  const missing=add('26-12.31-1 已移出范围.dwg','navigation');store.markMissing(missing.file);
  add('无订单批次.dwg','navigation');
  store.invalidateStats();const stats=store.stats(),batches=stats.orderBatches;
  assert.equal(batches.length,100);assert.ok(batches.some(item=>item.name===keys.at(-1)),'最新单文件订单必须进入导航');
  assert.deepEqual(batches.map(item=>item.name),keys.slice(-100).reverse(),'先排序完整批次集合再截取，不能先按数量筛掉小订单');
  assert.equal(batches[0].count,1);assert.equal(batches[1].count,grouped?4:6);
  assert.equal(stats.physicalTotal,964);assert.equal(stats.groupTotal,962);assert.equal(stats.total,grouped?962:964);
  assert.deepEqual(stats.projects.map(item=>item.name),['大量旧订单','近期小订单']);
  assert.deepEqual(stats.types.map(item=>item.name),['大量类型','近期类型']);
  assert.deepEqual(stats.formats.map(item=>item.name),['DWG','PDF']);
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

test('十个备份中最旧版本独有 legacy 标签必须保留真实 owner，不能由共同并集冒充新版命中',()=>{
  const members=[];for(let i=0;i<10;i++)members.push(add(`标签真实归属 2026-03-02 14_52_${String(i).padStart(2,'0')}.dwg`,'legacy-owner'));
  store.classify(members[0].id,{scope:'version',project:'历史项目',tags:['唯一旧版本标签']});
  const classification=store.getClassification(raw(members[9]));assert.equal(classification.source,'legacy');assert.ok(classification.tags.includes('唯一旧版本标签'));
  const candidates=store.candidateRows({groups:[['唯一旧版本标签']]},{backup:'only'},20,false);assert.equal(candidates.length,1);assert.equal(candidates[0].row.id,members[9].id);
  const evidence=candidates[0].evidenceRows;assert.ok(evidence.some(row=>row.id===members[0].id));assert.equal(evidence.length,1);assert.equal(evidence[0].evidenceOrigin.kind,'version');assert.deepEqual(evidence[0].evidenceOrigin.versionTerms,['唯一旧版本标签']);assert.deepEqual(evidence[0].evidenceOrigin.groupTerms,[]);assert.equal(evidence[0].tags,'["唯一旧版本标签"]');
});

test('明确共同确认标签可以作为 group 来源证据，但不伪造各物理版本 legacy 标签',()=>{
  const original=add('共同标签来源.dwg','group-origin');add('共同标签来源 2026-03-02 14_52_26.dwg','group-origin');
  store.classify(original.id,{project:'确认共同项目',tags:['整组确认专用标签']});
  const candidates=store.candidateRows({groups:[['整组确认专用标签']]},{},20,false);assert.equal(candidates.length,1);const evidence=candidates[0].evidenceRows;
  assert.equal(evidence.length,1);assert.equal(evidence[0].tags,'[]');assert.equal(evidence[0].evidenceOrigin.kind,'group');assert.deepEqual(evidence[0].evidenceOrigin.versionTerms,[]);assert.deepEqual(evidence[0].evidenceOrigin.groupTerms,['整组确认专用标签']);assert.deepEqual(evidence[0].evidenceOrigin.groupClassification.tags,['整组确认专用标签']);assert.equal(evidence[0].evidenceOrigin.groupClassification.source,'manual');
});

test('SQLite 候选限额前对物理版本及共同分类的项目、类型、标签评分，最旧高相关目标不被20组挤掉',()=>{
  for(const scope of ['version','group'])for(const field of ['project','type','tags']){
    const directory=`ranking-${scope}-${field}`,target=add('评分主体 最旧目标.dwg',directory);
    const keyword=`专用高相关${scope}${field}`,data={scope,project:'普通项目',type:'普通类型',tags:[]};data[field]=field==='tags'?[keyword]:keyword;store.classify(target.id,data);
    store.db.prepare('UPDATE files SET modified=1 WHERE id=?').run(target.id);
    for(let i=0;i<20;i++){const member=add(`评分主体 普通${i}.dwg`,directory);store.db.prepare('UPDATE files SET modified=? WHERE id=?').run(100+i,member.id);}
    const candidates=store.candidateRows({groups:[['评分主体']],keywords:[keyword]},{},20,false);assert.equal(candidates.length,20);assert.equal(candidates[0].row.id,target.id,`${scope}/${field} 必须在 LIMIT 前获得分类关键词加分`);
    if(scope==='version')assert.equal(store.candidateRows({groups:[['评分主体']],keywords:[keyword]},{grouped:'0'},20,false)[0].row.id,target.id,`${field} 物理字段评分不能依赖共同分类补偿`);
  }
});

test('必要主题均命中名称时仍优先保留最旧备份的 optional 标签真实 owner',()=>{
  add('可选证据主体.dwg','optional-owner');let owner;
  for(let i=0;i<10;i++){const member=add(`可选证据主体 2026-03-02 14_52_${String(i).padStart(2,'0')}.dwg`,'optional-owner');if(i===0)owner=member;}
  store.classify(owner.id,{scope:'version',project:'证据项目',tags:['可选词唯一旧版本标签']});
  const candidates=store.candidateRows({groups:[['可选证据主体']],keywords:['可选词唯一旧版本标签']},{},20,false),evidence=candidates[0].evidenceRows;
  assert.ok(evidence.some(row=>row.id===owner.id&&row.evidenceOrigin.versionTerms.includes('可选词唯一旧版本标签')));assert.deepEqual(candidates[0].truncatedKeywords,[]);assert.ok(evidence.length<=9);
});

test('optional 仅命中明确共同确认标签时附 group 来源，不伪造版本标签也不报截断',()=>{
  const original=add('共同可选证据主体.dwg','optional-group');store.classify(original.id,{project:'共同项目',tags:['共同可选专用标签']});
  const [candidate]=store.candidateRows({groups:[['共同可选证据主体']],keywords:['共同可选专用标签']},{},20,false);
  assert.equal(candidate.evidenceRows[0].tags,'[]');assert.equal(candidate.evidenceRows[0].evidenceOrigin.kind,'mixed');assert.deepEqual(candidate.evidenceRows[0].evidenceOrigin.groupTerms,['共同可选专用标签']);assert.deepEqual(candidate.truncatedKeywords,[]);
});

test('必要八主题占满时 optional 证据不足明确记录截断词，同时保留独立备份条件证明',()=>{
  const original=add('截断证据主体.pdf','optional-truncation');
  for(let i=0;i<10;i++){const member=add(`截断证据主体 ${i}.pdf`,'optional-truncation');store.db.prepare('UPDATE files SET group_key=? WHERE id=?').run(raw(original).group_key,member.id);store.setPreview(member.id,store.contentVersion(raw(member)),{status:'ready',text:i<8?`必需主题${i}标识`:`可选主题${i}标识`,preview:false});}
  const backup=add('截断证据主体 2026-03-02 14_52_26.pdf','optional-truncation'),groups=Array.from({length:8},(_,i)=>[`必需主题${i}标识`]),keywords=['可选主题8标识','可选主题9标识'];
  const [candidate]=store.candidateRows({groups,keywords},{backup:'only'},20,true);assert.equal(candidate.evidenceRows.length,9);assert.ok(candidate.evidenceRows.some(row=>row.id===backup.id));assert.deepEqual(candidate.truncatedKeywords,keywords);
  for(const group of groups)assert.ok(candidate.evidenceRows.some(row=>row.content.includes(group[0])));
});

test('合法八主题各八同义词超过40个唯一词时，后排 optional 仍参与限额前评分',()=>{
  const groups=Array.from({length:8},(_,i)=>[`必需评分主题${i}标识`,...Array.from({length:7},(_,j)=>`备用评分同义${i}号${j}词`)]),requiredName=groups.map(group=>group[0]).join(' '),keyword='后排独有可选评分标签';
  assert.equal(new Set(groups.flat()).size,64);
  const target=add(`${requiredName} 最旧目标.dwg`,'ranking-full-plan');store.classify(target.id,{scope:'version',project:'普通项目',tags:[keyword]});store.db.prepare('UPDATE files SET modified=1 WHERE id=?').run(target.id);
  for(let i=0;i<20;i++){const member=add(`${requiredName} 普通${i}.dwg`,'ranking-full-plan');store.db.prepare('UPDATE files SET modified=? WHERE id=?').run(100+i,member.id);}
  const candidates=store.candidateRows({groups,keywords:[keyword]},{},20,false);assert.equal(candidates.length,20);assert.equal(candidates[0].row.id,target.id);assert.ok(candidates[0].evidenceRows.some(row=>row.evidenceOrigin.versionTerms.includes(keyword)));
});

test('已确认 B 身份连续移入已缓存 A 组后，新增版本不能未经查询便继承 A；拆组仍未分类',()=>{
  const destination=add('连续入组目的.dwg','inheritance-move'),incoming=add('连续入组别名.dwg','inheritance-move');
  store.classify(destination.id,{project:'目的组确认 A'});store.classify(incoming.id,{project:'来访组确认 B'});
  const moved=path.join(root,'inheritance-move','连续入组目的 2026-03-02 14_52_26.dwg');fs.renameSync(incoming.file,moved);assert.equal(store.upsert(meta(moved)).id,incoming.id);
  // Deliberately do not search or call getClassification between these upserts.
  const joined=add('连续入组目的 2026-03-02 14_52_27.dwg','inheritance-move');
  assert.equal(store.db.prepare('SELECT confirmation_id FROM classification_members WHERE file_id=?').get(joined.id),undefined);
  assert.equal(store.getClassification(raw(destination)).conflict,true);
  const separated=path.join(root,'inheritance-move','连续入组分离身份.dwg');fs.renameSync(joined.file,separated);assert.equal(store.upsert(meta(separated)).id,joined.id);
  assert.equal(store.getClassification(raw(joined)).classified,false);assert.equal(store.getClassification(raw(joined)).project,'');assert.equal(raw(joined).classified,0);
});

test('只有一条共同确认但新加入 legacy 分类矛盾时，连续新增版本也不能继承该确认',()=>{
  const destination=add('单确认冲突目的.dwg','inheritance-legacy'),incoming=add('单确认冲突别名.dwg','inheritance-legacy');
  store.classify(destination.id,{project:'共同确认 A'});store.classify(incoming.id,{scope:'version',project:'物理版本 B'});
  const moved=path.join(root,'inheritance-legacy','单确认冲突目的 2026-03-02 14_52_26.dwg');fs.renameSync(incoming.file,moved);store.upsert(meta(moved));
  const joined=add('单确认冲突目的 2026-03-02 14_52_27.dwg','inheritance-legacy');assert.equal(store.db.prepare('SELECT confirmation_id FROM classification_members WHERE file_id=?').get(joined.id),undefined);assert.equal(store.getClassification(raw(destination)).conflict,true);
  const separated=path.join(root,'inheritance-legacy','单确认冲突分离身份.dwg');fs.renameSync(joined.file,separated);store.upsert(meta(separated));assert.equal(store.getClassification(raw(joined)).classified,false);
});

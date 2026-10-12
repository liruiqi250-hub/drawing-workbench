'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const parent=path.resolve(__dirname,'../.test-tmp');fs.mkdirSync(parent,{recursive:true});
const temporary=fs.mkdtempSync(path.join(parent,'rulesai-')),roots=path.join(temporary,'图纸');fs.mkdirSync(roots);
process.env.DRAWING_WORKBENCH_DATA=path.join(temporary,'data');process.env.DRAWING_WORKBENCH_ROOTS=JSON.stringify([roots]);
const store=require('../src/store'),aiStore=require('../src/ai-store'),rules=require('../src/local-rules'),config=require('../src/config');
let sequence=0;
function add(name){const file=path.join(roots,String(++sequence),name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'fixture-only');const stat=fs.statSync(file,{bigint:true});return store.getRaw(store.upsert({path:file,name:path.basename(file),extension:path.extname(file),size:Number(stat.size),modified:Number(stat.mtimeMs),fileKey:`${path.parse(file).root.toLowerCase()}:${stat.dev}:${stat.ino}`}).id);}
function suggestion(row,tags=[]){return aiStore.saveSuggestions([{id:row.id,project:'规则建议项目',type:'钢架',tags,reason:'fixture',summary:''}],new Map([[row.id,aiStore.captureSnapshot(row)]]))[0];}
test.after(()=>{store.close();fs.rmSync(temporary,{recursive:true,force:true});});

test('AI接受有界建议仍保留22个人工标签和80字标签，只有显式确认才删除',()=>{
  const row=add('AI标签保留.dwg'),long='长'.repeat(80),tags=[long,...Array.from({length:21},(_,i)=>'人工'+i)];
  store.classify(row.id,{project:'人工项目',tags});
  const first=suggestion(store.getRaw(row.id),tags.slice(0,20).map(tag=>tag.slice(0,60)));
  assert.equal(first.existingClassification.tags.length,22);assert.ok(first.tagDiff.omitted.includes(long));
  aiStore.applySuggestion(first.id,{project:'人工项目',tags:first.tags});
  const after=store.getClassification(store.getRaw(row.id));assert.ok(after.tags.includes(long));for(const tag of tags)assert.ok(after.tags.includes(tag));
  const second=suggestion(store.getRaw(row.id),['追加']);
  const saved=aiStore.applySuggestion(second.id,{project:'人工项目',tags:['追加'],confirmTagRemoval:true});assert.deepEqual(saved.tags,['追加']);
});

test('AI合并超标签上限拒绝整批，不截短旧标签',()=>{
  const row=add('AI满标签.dwg'),tags=Array.from({length:50},(_,i)=>'手工标签'+i);store.classify(row.id,{project:'原项目',tags});
  const proposal=suggestion(store.getRaw(row.id),['新增']);assert.throws(()=>aiStore.applySuggestion(proposal.id,{project:'原项目',tags:proposal.tags}),/超过/);
  assert.deepEqual(store.getClassification(store.getRaw(row.id)).tags,tags);
});

test('AI请求期间人工分类已更新，响应不能用新时间戳将旧输入建议包装成有效',()=>{
  const row=add('AI进行中人工更新.dwg');store.classify(row.id,{project:'旧项目',tags:['旧标签']});
  const original=aiStore.captureSnapshot(store.getRaw(row.id));
  store.classify(row.id,{project:'新人工项目',tags:['最新标签']});
  assert.throws(()=>aiStore.saveSuggestions([{id:row.id,project:'旧项目',tags:['旧标签']}],new Map([[row.id,original]])),error=>error.status===409);
  assert.equal(store.getClassification(store.getRaw(row.id)).project,'新人工项目');assert.deepEqual(store.getClassification(store.getRaw(row.id)).tags,['最新标签']);assert.equal(aiStore.listSuggestions(row.id).length,0);
});

test('AI候选保留真实命中的备份标签、字段与片段，代表仍为原图且没有绝对路径',()=>{
  const original=add('专用机械.dwg'),backupPath=path.join(path.dirname(original.path),'专用机械 2026-10-12 10_30_00.dwg');fs.copyFileSync(original.path,backupPath);
  const stat=fs.statSync(backupPath,{bigint:true}),backup=store.getRaw(store.upsert({path:backupPath,name:path.basename(backupPath),extension:'.dwg',size:Number(stat.size),modified:Number(stat.mtimeMs),fileKey:`${path.parse(backupPath).root.toLowerCase()}:${stat.dev}:${stat.ino}`}).id);
  store.classify(backup.id,{project:'机械',tags:['专用转向关节'],scope:'version'});
  const found=aiStore.candidates({groups:[['专用转向关节']],keywords:[],formats:[]});assert.equal(found.length,1);assert.equal(found[0].id,original.id);
  const evidence=found[0].evidence.find(v=>v.fileId===backup.id);assert.ok(evidence);assert.ok(evidence.matches.some(v=>v.field==='tags'&&v.snippet.includes('专用转向关节')));
  assert.ok(!JSON.stringify(found).includes(roots));
});

test('PDF末尾可选词被有限证据裁剪时明确提示未展开',()=>{
  const row=add('有限证据.pdf'),groups=Array.from({length:8},(_,i)=>['必要主题'+i]),optional='末尾独有可选词';
  store.setPreview(row.id,store.contentVersion(row),{status:'ready',text:groups.flat().join(' ')+'填'.repeat(3000)+optional,preview:false});
  const candidate=aiStore.candidates({groups,keywords:[optional,'完全不匹配的关键词']}, {},20,true).find(item=>item.id===row.id);
  assert.ok(candidate);assert.ok(candidate.truncatedKeywords.includes(optional));
  assert.ok(!candidate.truncatedKeywords.includes('完全不匹配的关键词'));
  assert.ok(!JSON.stringify(candidate.evidence).includes(optional));
});

test('本机规则预览不写分类，分批确认写共同分类但不修改源字节；重复应用拒绝',()=>{
  const row=add('26-06.23-01 霸王龙4米钢架.dwg'),bytes=fs.readFileSync(row.path);
  const result=rules.preview({query:row.name,limit:10});const item=result.items.find(v=>v.id===row.id);assert.ok(item?.actionable);assert.equal(store.getClassification(row).classified,false);
  const applied=rules.apply({previewId:result.previewId,selections:[{id:row.id,stamp:item.stamp}]});assert.equal(applied.applied,1);
  assert.equal(store.getClassification(store.getRaw(row.id)).classified,true);assert.deepEqual(fs.readFileSync(row.path),bytes);
  assert.throws(()=>rules.apply({previewId:result.previewId,selections:[{id:row.id,stamp:item.stamp}]}),/变化|应用/);
});

test('本机批量规则冲突需明确复核，变更配置或分类使预览过期',()=>{
  const row=add('郑州展会平面图.dwg');store.classify(row.id,{project:'已有项目',tags:['人工保留']});
  let result=rules.preview({query:row.name,includeClassified:true}),item=result.items.find(v=>v.id===row.id);assert.ok(item.conflict);
  assert.throws(()=>rules.apply({previewId:result.previewId,selections:[{id:row.id,stamp:item.stamp}]}),/冲突/);
  rules.apply({previewId:result.previewId,selections:[{id:row.id,stamp:item.stamp,resolveConflict:true}]});assert.equal(store.getClassification(store.getRaw(row.id)).project,'郑州展会');assert.ok(store.getClassification(store.getRaw(row.id)).tags.includes('人工保留'));
  result=rules.preview({query:row.name,includeClassified:true});item=result.items.find(v=>v.id===row.id);
  config.saveSettings({classificationRules:[...config.getSettings().classificationRules,{keyword:'新增',project:'新规则',type:''}]});
  assert.throws(()=>rules.apply({previewId:result.previewId,selections:[{id:row.id,stamp:item.stamp,resolveConflict:true}]}),/规则已变化/);
});

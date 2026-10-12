'use strict';
const crypto=require('node:crypto');
const config=require('./config'),store=require('./store'),aiStore=require('./ai-store'),db=store.db;
const LIFETIME=15*60*1000;
db.exec('CREATE TABLE IF NOT EXISTS local_rule_previews(id TEXT PRIMARY KEY,created INTEGER NOT NULL,payload TEXT NOT NULL)');
const error=(message,status=409)=>Object.assign(new Error(message),{status});
function rulesStamp(){const s=config.getSettings();return crypto.createHash('sha256').update(JSON.stringify([s.roots,s.extensions,s.excludeDirs,s.classificationRules,s.groupingRules])).digest('hex');}
function proposal(row){
  const current=store.getClassification(row),suggested=store.suggestion(row),conflicts=[];
  const members=db.prepare('SELECT * FROM files WHERE alive=1 AND group_key=? ORDER BY id').all(row.group_key);
  const versionSuggestions=members.map(member=>({fileId:member.id,name:member.name,...store.suggestion(member)}));
  if(current.conflict)conflicts.push('这组已有版本分类冲突，需复核并明确采用共同分类。');
  for(const key of ['project','type']){
    if(current[key]&&suggested[key]&&current[key]!==suggested[key])conflicts.push(`${key==='project'?'项目':'类型'}：已有“${current[key]}”，规则建议“${suggested[key]}”。`);
    const values=[...new Set(versionSuggestions.map(value=>value[key]).filter(Boolean))];
    if(values.length>1)conflicts.push(`组内不同版本的${key==='project'?'项目':'类型'}规则建议不一致：${values.join(' / ')}`);
  }
  const tags=[...new Set([...(current.tags||[]),...(suggested.tags||[])])];
  const valid=!!(suggested.project||suggested.type)&&tags.length<=50&&tags.every(tag=>tag.length<=100);
  if(tags.length>50)conflicts.push('合并标签超过50个，不能批量应用；请在详情手工核对。');
  return {id:row.id,name:row.name,groupId:store.publicFile(row).group.id,stamp:aiStore.stamp(row),current,suggestion:suggested,
    proposed:{project:current.project||suggested.project,type:current.type||suggested.type,tags},conflicts,conflict:conflicts.length>0,actionable:valid,versionSuggestions};
}
function preview(input={}){
  const scope=aiStore.normalizeScope(input.scope||{}),limit=Math.max(10,Math.min(50,Math.floor(Number(input.limit)||20)));
  const params={...scope,format:scope.format,grouped:'1',q:String(input.query||'').slice(0,300),page:Math.max(1,Math.floor(Number(input.page)||1)),limit,sort:'name'};
  if(input.includeClassified!==true)params.pending='1';
  const result=store.search(params),items=result.items.map(file=>proposal(store.getRaw(file.id)));
  const id=crypto.randomBytes(12).toString('hex'),created=Date.now();
  const payload={scope:params,rulesStamp:rulesStamp(),items,appliedIds:[]};
  db.prepare('INSERT INTO local_rule_previews(id,created,payload)VALUES(?,?,?)').run(id,created,JSON.stringify(payload));
  db.prepare('DELETE FROM local_rule_previews WHERE created<?').run(created-LIFETIME*2);
  return {previewId:id,created,expires:created+LIFETIME,items,total:result.total,page:result.page,limit:result.limit,notice:'纯本机规则预览；默认合并保留人工标签。每批最多50组，冲突不自动采用，原图只读。'};
}
function apply(input={}){
  if(typeof input.previewId!=='string'||!/^[a-f0-9]{24}$/.test(input.previewId))throw error('请先生成本机规则预览。',400);
  const saved=db.prepare('SELECT * FROM local_rule_previews WHERE id=?').get(input.previewId);
  if(!saved||Date.now()-saved.created>LIFETIME)throw error('这批预览已过期，请重新预览后确认。');
  const payload=JSON.parse(saved.payload);
  if(payload.rulesStamp!==rulesStamp())throw error('扫描范围、归组或规则已变化，请重新预览。');
  if(!Array.isArray(input.selections)||!input.selections.length||input.selections.length>50)throw error('每批请选择1–50组图纸。',400);
  const seen=new Set(),selected=[];
  for(const choice of input.selections){
    if(!choice||seen.has(choice.id))throw error('确认列表包含无效或重复图纸。',400);seen.add(choice.id);
    const item=payload.items.find(item=>item.id===choice.id),row=store.getRaw(choice.id);
    if(!item||!row?.alive||payload.appliedIds.includes(choice.id)||choice.stamp!==item.stamp||item.stamp!==aiStore.stamp(row)||!config.isAllowed(row.path))throw error('其中一组图纸或分类已变化、已应用或移出范围，请重新预览。');
    aiStore.assertDisk(row);
    if(!item.actionable)throw error('所选图纸建议不完整或超过标签限制，请在详情手工处理。',400);
    if(item.conflict&&choice.resolveConflict!==true)throw error('存在分类或规则冲突，需逐组勾选明确采用规则后确认。');
    const data={...item.proposed,scope:'group',source:'local-rule',resolveConflict:choice.resolveConflict===true};
    if(item.conflict){data.project=item.suggestion.project||data.project;data.type=item.suggestion.type||data.type;}
    selected.push({id:row.id,data});
  }
  db.exec('SAVEPOINT local_rule_apply');
  try{
    const files=selected.map(choice=>store.classify(choice.id,choice.data));
    payload.appliedIds.push(...selected.map(choice=>choice.id));
    db.prepare('UPDATE local_rule_previews SET payload=? WHERE id=?').run(JSON.stringify(payload),input.previewId);
    db.exec('RELEASE local_rule_apply');return {ok:true,applied:files.length,files,notice:'已确认的共同分类写入本机索引，版本原值和原图保留。'};
  }catch(cause){db.exec('ROLLBACK TO local_rule_apply;RELEASE local_rule_apply');throw cause;}
}
module.exports={preview,apply};

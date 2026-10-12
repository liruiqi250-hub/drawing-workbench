'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const config=require('./config'),store=require('./store'),db=store.db;
const pdfRules=require('./pdf-rules');
db.exec("CREATE TABLE IF NOT EXISTS ai_suggestions(id TEXT PRIMARY KEY,file_id TEXT NOT NULL,source_stamp TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created INTEGER NOT NULL)");
const text=(value,max)=>String(value||'').trim().slice(0,max);
const classification=(row,mode)=>store.getClassification(row,mode);
function stamp(row){
  if(!row)return '';
  const members=db.prepare('SELECT id,path,file_key,modified,size,content_revision,project,type,tags,classified,pdf_kind,pdf_override,pdf_metadata FROM files WHERE alive=1 AND group_key=? ORDER BY id').all(row.group_key);
  return crypto.createHash('sha256').update(JSON.stringify([row.id,row.path,store.contentVersion(row),classification(row,'all'),members,config.getSettings().pdf])).digest('hex');
}
function captureSnapshot(row){return {...row,aiSourceStamp:stamp(row)};}
function publicSuggestion(suggestion){
  const row=store.getRaw(suggestion.file_id),payload=JSON.parse(suggestion.payload),current=row?classification(row):{project:'',type:'',tags:[]};
  const proposed=payload.tags||[],existing=current.tags||[];
  return {id:suggestion.id,fileId:suggestion.file_id,name:row?.name||'图纸已不可用',path:row?.path||'',...payload,
    existingClassification:current,tagDiff:{added:proposed.filter(v=>!existing.includes(v)),omitted:existing.filter(v=>!proposed.includes(v)),defaultAction:'merge-preserve'},
    rulesVersion:payload.rulesVersion||'0.3.0',status:suggestion.status==='pending'&&(!row?.alive||stamp(row)!==suggestion.source_stamp)?'stale':suggestion.status,created:suggestion.created};
}
function saveSuggestions(proposals,originals){
  const result=[];db.exec('SAVEPOINT ai_suggestion_save');
  try{
    for(const proposal of proposals){
      const row=originals.get(proposal.id);if(!row)throw new Error('AI 返回了未提供的图纸。');
      if(!row.aiSourceStamp)throw new Error('AI 输入缺少请求前快照，未保存建议，请重新分析。');
      const sourceStamp=row.aiSourceStamp,fresh=store.getRaw(row.id);
      if(!fresh?.alive||stamp(fresh)!==sourceStamp)throw staleError();
      const payload={project:text(proposal.project,120),type:text(proposal.type,120),tags:[...new Set((proposal.tags||[]).map(v=>text(v,100)).filter(Boolean))].slice(0,20),reason:text(proposal.reason,500),summary:text(proposal.summary,500),rulesVersion:config.VERSION};
      const id=crypto.randomBytes(12).toString('hex');
      db.prepare("UPDATE ai_suggestions SET status='superseded' WHERE file_id=? AND status='pending'").run(row.id);
      db.prepare('INSERT INTO ai_suggestions(id,file_id,source_stamp,payload,created)VALUES(?,?,?,?,?)').run(id,row.id,sourceStamp,JSON.stringify(payload),Date.now());
      result.push(publicSuggestion(getSuggestion(id)));
    }
    db.exec('RELEASE ai_suggestion_save');return result;
  }catch(error){db.exec('ROLLBACK TO ai_suggestion_save;RELEASE ai_suggestion_save');throw error;}
}
function getSuggestion(id){return /^[a-f0-9]{24}$/.test(id)?db.prepare('SELECT * FROM ai_suggestions WHERE id=?').get(id):null;}
function listSuggestions(fileId){
  const rows=fileId?db.prepare("SELECT * FROM ai_suggestions WHERE status='pending' AND file_id=? ORDER BY created DESC LIMIT 50").all(fileId):db.prepare("SELECT * FROM ai_suggestions WHERE status='pending' ORDER BY created DESC LIMIT 50").all();
  return rows.filter(s=>{const row=store.getRaw(s.file_id);return row?.alive&&config.isAllowed(row.path);}).map(publicSuggestion);
}
function staleError(){const error=new Error('原图、组成员或分类已变化，这条 AI 建议已过期。请重新分析后再确认。');error.status=409;return error;}
function assertDisk(row){
  try{
    const stat=fs.statSync(row.path,{bigint:true});
    const key=stat.ino?`${path.parse(row.path).root.toLowerCase()}:${stat.dev}:${stat.ino}`:'';
    if(Number(stat.size)!==row.size||Number(stat.mtimeMs)!==Math.trunc(row.modified)||(row.file_key&&key!==row.file_key)||!config.isAllowed(fs.realpathSync(row.path)))throw staleError();
  }catch{throw staleError();}
}
function applySuggestion(id,data={}){
  const suggestion=getSuggestion(id);if(!suggestion)throw new Error('AI 建议不存在。');
  const row=store.getRaw(suggestion.file_id);
  if(suggestion.status!=='pending'||!row?.alive||stamp(row)!==suggestion.source_stamp||!config.isAllowed(row.path))throw staleError();
  assertDisk(row);
  const current=classification(row),proposal=JSON.parse(suggestion.payload);
  const proposedTags=Array.isArray(data.tags)?data.tags:(proposal.tags||[]);
  const requested=[...new Set(proposedTags.map(v=>String(v).trim()).filter(Boolean))];
  const tags=data.confirmTagRemoval===true?requested:[...new Set([...(current.tags||[]),...requested])];
  if(tags.length>50||tags.some(v=>v.length>100))throw new Error('合并后标签超过 50 个或单项超过 100 字；请编辑建议并明确确认需要删除的人工标签，已有标签未改动。');
  db.exec('SAVEPOINT ai_suggestion_apply');
  try{
    const file=store.classify(row.id,{project:data.project===undefined?(proposal.project||current.project):data.project,type:data.type===undefined?(proposal.type||current.type):data.type,tags,scope:'group',resolveConflict:data.resolveConflict===true});
    db.prepare("UPDATE ai_suggestions SET status='applied' WHERE id=?").run(id);db.exec('RELEASE ai_suggestion_apply');return file;
  }catch(error){db.exec('ROLLBACK TO ai_suggestion_apply;RELEASE ai_suggestion_apply');throw error;}
}
function dismissSuggestion(id){const suggestion=getSuggestion(id);if(!suggestion)throw new Error('AI 建议不存在。');db.prepare("UPDATE ai_suggestions SET status='dismissed' WHERE id=? AND status='pending'").run(id);}
function metadataForAi(row,includeText=false,ownVersion=false,mode=config.getSettings().pdf.displayMode){
  const folders=path.dirname(row.path).split(/[\\/]/).filter(Boolean).slice(-3).filter(part=>!/:$/.test(part));
  const common=ownVersion?row:classification(row,mode),tags=ownVersion?JSON.parse(row.tags):common.tags;
  const result={id:row.id,name:row.name,folders,format:row.extension.slice(1).toUpperCase(),project:common.project,type:common.type,tags,naming:store.namingFor(row)};
  if(includeText&&row.extension==='.pdf'&&row.content)result.text=row.content.slice(0,2000);
  return result;
}
function evidenceFor(row,plan,includeText){
  const terms=[...new Set([...(plan.groups||[]).flat(),...(plan.keywords||[])])].filter(v=>typeof v==='string'&&v.trim());
  const meta=metadataForAi(row,includeText,true),origin=row.evidenceOrigin||{kind:'version'},group=origin.groupClassification;
  const values={name:row.name,project:row.project,type:row.type,tags:JSON.parse(row.tags).join('，'),naming:row.naming_search||'',...(includeText&&row.extension==='.pdf'?{text:row.content||''}:{}),...(group?{groupProject:group.project,groupType:group.type,groupTags:(group.tags||[]).join('，')}:{})};
  const matches=[];
  for(const [field,value] of Object.entries(values)){
    const found=terms.filter(term=>field==='text'?pdfRules.normalize(value).includes(pdfRules.normalize(term)):value.toLowerCase().includes(term.toLowerCase()));if(!found.length)continue;
    const pageEvidence=field==='text'?store.pdfMatches([row],found)[0]:null;
    const start=Math.max(0,value.toLowerCase().indexOf(found[0].toLowerCase())-50);
    matches.push({field,terms:found.slice(0,8),snippet:pageEvidence?.snippet||value.slice(start,start+240),...(pageEvidence?{page:pageEvidence.page,source:pageEvidence.source,dimensions:pageEvidence.dimensions}:{})});
  }
  const folderMatches=path.dirname(row.path).split(/[\\/]/).filter(part=>!/:$/.test(part)&&terms.some(term=>part.toLowerCase().includes(term.toLowerCase()))).slice(-3);
  if(folderMatches.length)matches.push({field:'folder',terms:terms.filter(term=>folderMatches.join(' ').toLowerCase().includes(term.toLowerCase())).slice(0,8),snippet:folderMatches.join(' / ').slice(0,240)});
  return {...meta,fileId:row.id,matches:matches.slice(0,8),pdfMatches:includeText?store.pdfMatches([row],terms):[],sourceStamp:stamp(row),isBackup:!!row.is_backup,evidenceOrigin:origin.kind,...(group?{groupClassification:group}:{})};
}
function normalizeScope(input={}){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('检索范围格式不正确。');
  const result={};for(const key of ['project','type'])if(input[key])result[key]=text(input[key],120);
  if(input.pdfMode){if(!pdfRules.MODES.includes(input.pdfMode))throw new Error('PDF 显示范围无效。');result.pdfMode=input.pdfMode;}
  if(input.format){const format=String(input.format).trim().toLowerCase().replace(/^\./,'');if(!/^[a-z0-9]{1,12}$/.test(format))throw new Error('文件格式筛选不正确。');result.format='.'+format;}
  if(input.pending===true||input.pending==='1')result.pending=true;
  if(input.orderBatch){if(typeof input.orderBatch!=='string'||input.orderBatch.length>40)throw new Error('订单批次筛选无效。');result.orderBatch=input.orderBatch;}
  if(input.projectKind){if(!['order','exhibition','unknown'].includes(input.projectKind))throw new Error('项目来源筛选无效。');result.projectKind=input.projectKind;}
  if(input.backup){if(!['only','exclude'].includes(input.backup))throw new Error('备份筛选无效。');result.backup=input.backup;}
  return result;
}
function candidates(plan,scope={},limit=60,includeText=false){
  return store.candidateRows(plan,scope,limit,includeText).filter(({row})=>config.isAllowed(row.path)).map(({row,evidenceRows,truncatedKeywords})=>{
    const evidence=evidenceRows.filter(member=>config.isAllowed(member.path)).map(member=>evidenceFor(member,plan,includeText));
    // Candidate ownership is established before excerpts are bounded. Report optional
    // terms lost by that final bound, rather than silently claiming visible evidence.
    const omitted=(plan.keywords||[]).filter(term=>{
      const lower=term.toLowerCase();
      const matched=evidenceRows.some(member=>[member.name,member.path,member.project,member.type,member.tags,member.naming_search,includeText&&member.extension==='.pdf'?member.content:'',member.evidenceOrigin?.groupClassification?.project,member.evidenceOrigin?.groupClassification?.type,...(member.evidenceOrigin?.groupClassification?.tags||[])].some(value=>String(value||'').toLowerCase().includes(lower)));
      return matched&&!evidence.some(version=>version.matches.some(match=>match.terms.includes(term)||match.snippet.toLowerCase().includes(lower)));
    });
    return {...metadataForAi(row,includeText,false,scope.pdfMode||config.getSettings().pdf.displayMode),truncatedKeywords:[...new Set([...(truncatedKeywords||[]),...omitted])],evidence};
  });
}
module.exports={stamp,captureSnapshot,saveSuggestions,getSuggestion,listSuggestions,applySuggestion,dismissSuggestion,metadataForAi,normalizeScope,candidates,assertDisk};

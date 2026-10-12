'use strict';
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const config=require('./config');
const store=require('./store');
const db=store.db;
db.exec(`CREATE TABLE IF NOT EXISTS ai_suggestions(
 id TEXT PRIMARY KEY,file_id TEXT NOT NULL,source_stamp TEXT NOT NULL,payload TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending',created INTEGER NOT NULL
);CREATE INDEX IF NOT EXISTS ai_suggestions_file ON ai_suggestions(file_id,status);`);
function stamp(row){return crypto.createHash('sha256').update(JSON.stringify([config.pathKey(row.path),row.modified,row.size,row.project,row.type,row.tags,row.classified])).digest('hex');}
function text(value,max){return String(value||'').trim().slice(0,max);}
function publicSuggestion(suggestion){
  const row=store.getRaw(suggestion.file_id);const payload=JSON.parse(suggestion.payload);
  return {id:suggestion.id,fileId:suggestion.file_id,name:row?.name||'图纸已不可用',path:row?.path||'',...payload,rulesVersion:payload.rulesVersion||'0.3.0',
    status:suggestion.status==='pending'&&(!row?.alive||stamp(row)!==suggestion.source_stamp)?'stale':suggestion.status,created:suggestion.created};
}
function saveSuggestions(proposals,originals){
  const result=[];
  db.exec('BEGIN');
  try{
    for(const proposal of proposals){
      const row=originals.get(proposal.id);if(!row)throw new Error('AI 返回了未提供的图纸。');
      const payload={project:text(proposal.project,120),type:text(proposal.type,120),tags:[...new Set((proposal.tags||[]).map(v=>text(v,100)).filter(Boolean))].slice(0,20),reason:text(proposal.reason,500),summary:text(proposal.summary,500),rulesVersion:config.VERSION};
      const id=crypto.randomBytes(12).toString('hex');
      db.prepare("UPDATE ai_suggestions SET status='superseded' WHERE file_id=? AND status='pending'").run(row.id);
      db.prepare('INSERT INTO ai_suggestions(id,file_id,source_stamp,payload,created)VALUES(?,?,?,?,?)').run(id,row.id,stamp(row),JSON.stringify(payload),Date.now());
      result.push(publicSuggestion(db.prepare('SELECT * FROM ai_suggestions WHERE id=?').get(id)));
    }
    db.exec('COMMIT');return result;
  }catch(error){db.exec('ROLLBACK');throw error;}
}
function getSuggestion(id){return /^[a-f0-9]{24}$/.test(id)?db.prepare('SELECT * FROM ai_suggestions WHERE id=?').get(id):null;}
function listSuggestions(fileId){
  const rows=fileId?db.prepare("SELECT * FROM ai_suggestions WHERE status='pending' AND file_id=? ORDER BY created DESC LIMIT 50").all(fileId):db.prepare("SELECT * FROM ai_suggestions WHERE status='pending' ORDER BY created DESC LIMIT 50").all();
  return rows.filter(s=>{const row=store.getRaw(s.file_id);return row?.alive&&config.isAllowed(row.path);}).map(publicSuggestion);
}
function staleError(){const error=new Error('原图或分类已变化，这条 AI 建议已过期。请重新分析后再确认。');error.status=409;return error;}
function applySuggestion(id,data){
  const suggestion=getSuggestion(id);if(!suggestion)throw new Error('AI 建议不存在。');
  const row=store.getRaw(suggestion.file_id);
  if(suggestion.status!=='pending'||!row?.alive||stamp(row)!==suggestion.source_stamp||!config.isAllowed(row.path))throw staleError();
  // Confirm the actual disk version even when its watch event is still being processed.
  try{const stat=fs.statSync(row.path);if(stat.size!==row.size||Math.trunc(stat.mtimeMs)!==Math.trunc(row.modified)||!config.isAllowed(fs.realpathSync(row.path)))throw staleError();}catch{throw staleError();}
  db.exec('BEGIN');
  try{const file=store.classify(row.id,data);db.prepare("UPDATE ai_suggestions SET status='applied' WHERE id=?").run(id);db.exec('COMMIT');return file;}catch(error){db.exec('ROLLBACK');throw error;}
}
function dismissSuggestion(id){const suggestion=getSuggestion(id);if(!suggestion)throw new Error('AI 建议不存在。');db.prepare("UPDATE ai_suggestions SET status='dismissed' WHERE id=? AND status='pending'").run(id);}
function metadataForAi(row,includeText=false){
  // Never send an absolute path or a complete library listing.
  const folders=path.dirname(row.path).split(/[\\/]/).filter(Boolean).slice(-3).filter(part=>!/:$/.test(part));
  const result={id:row.id,name:row.name,folders,format:row.extension.slice(1).toUpperCase(),project:row.project,type:row.type,tags:JSON.parse(row.tags),naming:store.namingFor(row)};
  if(includeText&&row.extension==='.pdf'&&row.content)result.text=row.content.slice(0,2000);
  return result;
}
function normalizeScope(input={}){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('检索范围格式不正确。');
  const result={};for(const key of ['project','type'])if(input[key])result[key]=text(input[key],120);
  if(input.format){const format=String(input.format).trim().toLowerCase().replace(/^\./,'');if(!/^[a-z0-9]{1,12}$/.test(format))throw new Error('文件格式筛选不正确。');result.format='.'+format;}
  if(input.pending===true||input.pending==='1')result.pending=true;
  if(input.orderBatch){if(typeof input.orderBatch!=='string'||input.orderBatch.length>40)throw new Error('订单批次筛选无效。');result.orderBatch=input.orderBatch;}
  if(input.projectKind){if(!['order','exhibition','unknown'].includes(input.projectKind))throw new Error('项目来源筛选无效。');result.projectKind=input.projectKind;}
  if(input.backup){if(!['only','exclude'].includes(input.backup))throw new Error('备份筛选无效。');result.backup=input.backup;}
  return result;
}
function candidates(plan,scope={},limit=60,includeText=false){
  const filters=['alive=1'];const args=[];
  for(const key of ['project','type'])if(scope[key]){filters.push(key+'=?');args.push(scope[key]);}
  store.addNamingFilters(filters,args,scope);
  if(scope.format){filters.push('extension=?');args.push(scope.format);}
  if(scope.pending)filters.push('classified=0');
  const pattern=term=>'%'+term.replace(/[\\%_]/g,'\\$&')+'%';
  const columns=['name','path','project','type','tags','naming_search',...(includeText?['content']:[])];
  const matchTerm=term=>{args.push(...columns.map(()=>pattern(term)));return '('+columns.map(col=>`${col} LIKE ? ESCAPE '\\'`).join(' OR ')+')';};
  // AND between subjects, OR between synonyms. Optional terms affect local ranking only.
  const groups=(plan.groups||[]).map(g=>g.filter(v=>typeof v==='string'&&v.trim()));
  if(!groups.length&&plan.keywords?.length)groups.push(plan.keywords);
  if(!groups.length)throw new Error('AI 未生成有效检索条件，请补充名称、项目、用途或零件特征。');
  for(const group of groups)filters.push('('+group.map(matchTerm).join(' OR ')+')');
  const formats=(plan.formats||[]).filter(f=>/^\.?[a-zA-Z0-9]{1,12}$/.test(f)).map(f=>'.'+f.toLowerCase().replace(/^\./,''));
  if(formats.length&&!scope.format){filters.push('extension IN ('+formats.map(()=>'?').join(',')+')');args.push(...formats);}
  const optional=(plan.keywords||[]).filter(v=>typeof v==='string'&&v.trim()).slice(0,12);
  const scoring=[],scoreArgs=[];
  for(const term of [...new Set([...groups.flat(),...optional])]){
    scoring.push("CASE WHEN name LIKE ? ESCAPE '\\' THEN 4 ELSE 0 END");scoreArgs.push(pattern(term));
    scoring.push("CASE WHEN (path||' '||project||' '||type||' '||tags"+(includeText?"||' '||content":"")+") LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END");scoreArgs.push(pattern(term));
  }
  // Rank all scoped subject matches in SQLite before applying the candidate cap.
  const grouped=config.getSettings().versionGrouping;
  const sql=grouped?`WITH matched AS (SELECT group_key,(${scoring.join('+')}) AS ai_score FROM files WHERE ${filters.join(' AND ')}),scores AS (SELECT group_key,MAX(ai_score) AS ai_score FROM matched GROUP BY group_key),ranked AS (SELECT files.*,ROW_NUMBER() OVER(PARTITION BY group_key ORDER BY ${store.representativeOrder}) AS rn FROM files WHERE alive=1 AND group_key IN (SELECT group_key FROM scores)) SELECT ranked.*,scores.ai_score FROM ranked JOIN scores USING(group_key) WHERE rn=1${scope.pending?' AND classified=0':''} ORDER BY ai_score DESC,modified DESC LIMIT ?`:'SELECT *,('+scoring.join('+')+') AS ai_score FROM files WHERE '+filters.join(' AND ')+' ORDER BY ai_score DESC,modified DESC LIMIT ?';
  const rows=db.prepare(sql).all(...scoreArgs,...args,Math.max(20,Math.min(100,limit)));
  return rows.filter(row=>config.isAllowed(row.path)).map(row=>metadataForAi(row,includeText));
}
module.exports={stamp,saveSuggestions,getSuggestion,listSuggestions,applySuggestion,dismissSuggestion,metadataForAi,normalizeScope,candidates};

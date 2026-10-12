'use strict';
const {DatabaseSync}=require('node:sqlite');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const config=require('./config');
const {parseDrawingName}=require('./drawing-names');
const {groupIdentity}=require('./drawing-groups');
const DB_PATH=path.join(config.DATA_DIR,'drawings.sqlite');
const db=new DatabaseSync(DB_PATH,{timeout:5000});
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
CREATE TABLE IF NOT EXISTS files(
 id TEXT PRIMARY KEY,path TEXT NOT NULL,path_key TEXT NOT NULL UNIQUE,file_key TEXT NOT NULL DEFAULT '',name TEXT NOT NULL,
 extension TEXT NOT NULL,size INTEGER NOT NULL,modified INTEGER NOT NULL,project TEXT NOT NULL DEFAULT '',type TEXT NOT NULL DEFAULT '',
 tags TEXT NOT NULL DEFAULT '[]',classified INTEGER NOT NULL DEFAULT 0,content TEXT NOT NULL DEFAULT '',content_status TEXT NOT NULL DEFAULT 'pending',
 preview_status TEXT NOT NULL DEFAULT 'pending',preview_version TEXT NOT NULL DEFAULT '',pages INTEGER,
 alive INTEGER NOT NULL DEFAULT 1,seen_generation TEXT NOT NULL DEFAULT '',updated INTEGER NOT NULL
);CREATE INDEX IF NOT EXISTS files_file_key ON files(file_key);CREATE INDEX IF NOT EXISTS files_modified ON files(modified);
CREATE INDEX IF NOT EXISTS files_project ON files(project);CREATE INDEX IF NOT EXISTS files_type ON files(type);CREATE INDEX IF NOT EXISTS files_alive ON files(alive);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,action TEXT NOT NULL,file_id TEXT,details TEXT);`);
// Derived naming data is separate from manually confirmed project/type/tags.
const namingColumns={naming_json:"TEXT NOT NULL DEFAULT '{}'",naming_search:"TEXT NOT NULL DEFAULT ''",order_batch:"TEXT NOT NULL DEFAULT ''",project_kind:"TEXT NOT NULL DEFAULT 'unknown'",is_backup:'INTEGER NOT NULL DEFAULT 0',group_key:"TEXT NOT NULL DEFAULT ''",group_basis:"TEXT NOT NULL DEFAULT ''",group_rule:"TEXT NOT NULL DEFAULT ''"};
const existingColumns=new Set(db.prepare('PRAGMA table_info(files)').all().map(row=>row.name));
for(const [column,definition] of Object.entries(namingColumns))if(!existingColumns.has(column))db.exec(`ALTER TABLE files ADD COLUMN ${column} ${definition}`);
db.exec("CREATE INDEX IF NOT EXISTS files_order_batch ON files(order_batch); CREATE INDEX IF NOT EXISTS files_project_kind ON files(project_kind); CREATE INDEX IF NOT EXISTS files_is_backup ON files(is_backup); CREATE TABLE IF NOT EXISTS app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
db.exec('CREATE INDEX IF NOT EXISTS files_group ON files(group_key,alive,is_backup)');
function parseNaming(row){const naming=parseDrawingName(row.name,path.dirname(row.path).split(/[\\/]/).filter(Boolean));if(config.getSettings().groupingRules.some(rule=>rule.enabled&&config.contained(row.path,rule.backupRoot))){naming.isBackup=true;naming.backupBasis='directory';naming.backupLabel='备份来源';}return naming;}
function namingValues(naming){return [JSON.stringify(naming),naming.searchText||'',naming.orderBatch||'',naming.projectKind||'unknown',naming.isBackup?1:0];}
function namingFor(row){try{const value=JSON.parse(row.naming_json||'{}');if('projectKind' in value)return value;}catch{}return parseNaming(row);}
function migrateNaming(){
  if(db.prepare("SELECT value FROM app_meta WHERE key='naming_version'").get()?.value==='0.4.0')return;
  const rows=db.prepare('SELECT id,name,path FROM files').all();
  const update=db.prepare('UPDATE files SET naming_json=?,naming_search=?,order_batch=?,project_kind=?,is_backup=? WHERE id=?');
  db.exec('BEGIN');try{for(const row of rows)update.run(...namingValues(parseNaming(row)),row.id);db.prepare("INSERT INTO app_meta(key,value)VALUES('naming_version','0.4.0') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
}
migrateNaming();
function migrateGroups(force=false){
  const rules=config.getSettings().groupingRules,signature=JSON.stringify(['0.4.0',rules]);
  if(!force&&db.prepare("SELECT value FROM app_meta WHERE key='grouping_version'").get()?.value===signature)return;
  const rows=db.prepare('SELECT id,path,name,extension,naming_json FROM files').all(),update=db.prepare('UPDATE files SET naming_json=?,naming_search=?,order_batch=?,project_kind=?,is_backup=?,group_key=?,group_basis=?,group_rule=? WHERE id=?');
  db.exec('BEGIN');try{for(const row of rows){const naming=parseNaming(row),group=groupIdentity(row,naming,rules);update.run(...namingValues(naming),group.key,group.basis,group.ruleName,row.id);}db.prepare("INSERT INTO app_meta(key,value)VALUES('grouping_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(signature);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
}
migrateGroups();
const representativeOrder="is_backup ASC,COALESCE(NULLIF(json_extract(naming_json,'$.backupTimestamp'),''),strftime('%Y-%m-%dT%H:%M:%S',modified/1000,'unixepoch','localtime')) DESC,modified DESC,path_key";
function groupRows(row){return db.prepare(`SELECT * FROM files WHERE alive=1 AND group_key=? ORDER BY ${representativeOrder}`).all(row.group_key);}
function representative(row){return db.prepare(`SELECT * FROM files WHERE alive=1 AND group_key=? ORDER BY ${representativeOrder} LIMIT 1`).get(row.group_key)||row;}
function groupSummary(row){
  const data=db.prepare('SELECT COUNT(*) AS versions,SUM(is_backup) AS backups,SUM(modified+size) AS revision FROM files WHERE alive=1 AND group_key=?').get(row.group_key),main=representative(row);
  return {id:crypto.createHash('sha256').update(row.group_key).digest('hex').slice(0,24),representativeId:main.id,versionCount:data.versions,backupCount:data.backups||0,hasOriginal:data.versions>(data.backups||0),revision:data.revision,basis:row.group_basis,ruleName:row.group_rule};
}
function idFor(p){return crypto.createHash('sha256').update(config.pathKey(p)).digest('hex').slice(0,24);}
function suggestion(row){
  const text=(row.name+' '+row.path).toLowerCase();let project='',type='';const reasons=[];const naming=namingFor(row);
  for(const r of config.getSettings().classificationRules){if(text.includes(r.keyword.toLowerCase())){if(r.project&&!project)project=r.project;if(r.type&&!type)type=r.type;reasons.push(`文件名或路径包含“${r.keyword}”`);}}
  if(!project&&naming.projectKind==='exhibition'){project=naming.exhibitionName||'展会项目';reasons.unshift('名称或末级目录明确标有展会；具体展会名称不明时统一建议展会项目');}
  if(!project&&naming.orderBatch){project=naming.orderBatch;reasons.unshift(`图号前缀 ${naming.orderBatch} 作为订单批次；下单日期 ${naming.orderDate}`);}
  if(!type&&/平面图|平面布置/.test(naming.baseName||row.name))type='平面图';
  if(!project){const parent=path.basename(path.dirname(row.path));const generic=/^(?:共享|订单CAD|订单图|CAD图纸|DWG恐龙钢架机械图纸|CAD|DWG|PDF|图纸|硬盘|\d{4}年?|\d{1,2}月|\d{4}[-.]\d{1,2}|cad自动备份|自动备份|备份|dwgbak files|modify_backup|backup)$/i;
    if(parent&&!/^[a-z]:$/i.test(parent)&&!generic.test(parent)&&parent.length<80){project=parent;reasons.push('上级文件夹名称作为项目候选，需确认');}}
  const tags=[naming.drawingNumber,naming.orderDate,naming.productionSerial?`序号${naming.productionSerial}`:'',naming.productName,naming.productSize,naming.projectKind==='exhibition'?'展会':''].filter(Boolean);
  return {project,type,tags:[...new Set(tags)].slice(0,20),reasons:[...new Set(reasons)].slice(0,6)};
}
function publicFile(row,detail=false){
  if(!row)return null;
  const item={id:row.id,name:row.name,path:row.path,extension:row.extension.slice(1).toUpperCase(),size:row.size,modified:row.modified,project:row.project,type:row.type,tags:JSON.parse(row.tags),classified:!!row.classified,exists:!!row.alive,contentStatus:row.content_status,previewStatus:row.preview_status,pages:row.pages,suggestion:row.classified?null:suggestion(row)};
  item.naming=namingFor(row);
  item.group=groupSummary(row);
  if(detail){item.contentSnippet=row.content.slice(0,4000);item.versions=groupRows(row).map(member=>({id:member.id,name:member.name,path:member.path,extension:member.extension.slice(1).toUpperCase(),size:member.size,modified:member.modified,isBackup:!!member.is_backup,backupTimestamp:namingFor(member).backupTimestamp||'',basis:member.group_basis,ruleName:member.group_rule,isRepresentative:member.id===item.group.representativeId}));}
  return item;
}
const getRaw=id=>db.prepare('SELECT * FROM files WHERE id=?').get(id);
function upsert(meta,generation=''){
  const key=config.pathKey(meta.path);let old=db.prepare('SELECT * FROM files WHERE path_key=?').get(key);
  if(!old&&meta.fileKey){const candidates=db.prepare('SELECT * FROM files WHERE file_key=? LIMIT 8').all(meta.fileKey);old=candidates.find(x=>!fs.existsSync(x.path));}
  const id=old?.id||idFor(meta.path);const changed=!old||old.modified!==meta.modified||old.size!==meta.size;
  if(old){db.prepare(`UPDATE files SET path=?,path_key=?,file_key=?,name=?,extension=?,size=?,modified=?,alive=1,seen_generation=CASE WHEN ?='' THEN seen_generation ELSE ? END,updated=?,content=CASE WHEN ? THEN '' ELSE content END,content_status=CASE WHEN ? THEN 'pending' ELSE content_status END,preview_status=CASE WHEN ? THEN 'pending' ELSE preview_status END WHERE id=?`).run(meta.path,key,meta.fileKey||'',meta.name,meta.extension,meta.size,meta.modified,generation,generation,Date.now(),changed?1:0,changed?1:0,changed?1:0,id);}
  else db.prepare('INSERT INTO files(id,path,path_key,file_key,name,extension,size,modified,seen_generation,updated)VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,meta.path,key,meta.fileKey||'',meta.name,meta.extension,meta.size,meta.modified,generation,Date.now());
  const naming=parseNaming(meta),group=groupIdentity(meta,naming,config.getSettings().groupingRules);
  db.prepare('UPDATE files SET naming_json=?,naming_search=?,order_batch=?,project_kind=?,is_backup=?,group_key=?,group_basis=?,group_rule=? WHERE id=?').run(...namingValues(naming),group.key,group.basis,group.ruleName,id);
  return {id,changed};
}
function event(action,id,details=''){db.prepare('INSERT INTO events(at,action,file_id,details)VALUES(?,?,?,?)').run(Date.now(),action,id||null,details);db.exec('DELETE FROM events WHERE id < (SELECT COALESCE(MAX(id),0)-3000 FROM events)');}
function markMissing(p){const key=config.pathKey(p);return db.prepare('UPDATE files SET alive=0,updated=? WHERE path_key=? AND alive=1').run(Date.now(),key).changes;}
function markPrefixMissing(p){const key=config.pathKey(p);return db.prepare("UPDATE files SET alive=0,updated=? WHERE alive=1 AND (path_key=? OR substr(path_key,1,?)=?)").run(Date.now(),key,key.length+1,key+path.sep).changes;}
function finishRoot(root,generation,startedAt){
  const key=config.pathKey(root);db.prepare("UPDATE files SET alive=0,updated=? WHERE alive=1 AND seen_generation<>? AND updated<? AND (path_key=? OR substr(path_key,1,?)=?)").run(Date.now(),generation,startedAt,key,key.length+1,key+path.sep);
}
function pruneScope(settings){
  const rows=db.prepare('SELECT id,path FROM files WHERE alive=1').all();const stmt=db.prepare('UPDATE files SET alive=0 WHERE id=?');db.exec('BEGIN');try{for(const row of rows)if(!config.isAllowed(row.path,settings))stmt.run(row.id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
}
function search(params={}){
  const filters=['alive=1'];const args=[];
  const q=String(params.q||'').trim().slice(0,300);
  for(const token of q.split(/\s+/).filter(Boolean).slice(0,12)){
    const pattern='%'+token.replace(/[\\%_]/g,'\\$&')+'%';
    filters.push("(name LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\' OR project LIKE ? ESCAPE '\\' OR type LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR naming_search LIKE ? ESCAPE '\\')");args.push(pattern,pattern,pattern,pattern,pattern,pattern,pattern);
  }
  for(const k of ['project','type'])if(params[k]){filters.push(k+'=?');args.push(String(params[k]));}
  addNamingFilters(filters,args,params);
  if(params.format){filters.push('extension=?');args.push('.'+String(params.format).replace(/^\./,'').toLowerCase());}
  const grouped=params.grouped==='0'?false:params.grouped==='1'?true:config.getSettings().versionGrouping;
  const onlyPending=params.pending==='1'||params.pending===true;
  if(onlyPending&&!grouped)filters.push('classified=0');
  const where=filters.join(' AND ');
  const cte=grouped?`WITH matched AS (SELECT DISTINCT group_key FROM files WHERE ${where}),ranked AS (SELECT files.*,ROW_NUMBER() OVER(PARTITION BY group_key ORDER BY ${representativeOrder}) AS rn FROM files WHERE alive=1 AND group_key IN (SELECT group_key FROM matched)),result AS (SELECT * FROM ranked WHERE rn=1${onlyPending?' AND classified=0':''}) `:`WITH result AS (SELECT * FROM files WHERE ${where}) `;
  const total=db.prepare(cte+'SELECT COUNT(*) AS n FROM result').get(...args).n;
  const limit=Math.max(10,Math.min(200,Math.floor(Number(params.limit)||config.getSettings().pageSize)));const maxPage=Math.max(1,Math.ceil(total/limit));const page=Math.max(1,Math.min(maxPage,Math.floor(Number(params.page)||1)));
  const sort={modified:'modified DESC,name COLLATE NOCASE',name:'name COLLATE NOCASE',size:'size DESC,modified DESC'}[params.sort]||'modified DESC,name COLLATE NOCASE';
  const rows=db.prepare(cte+`SELECT * FROM result ORDER BY ${sort} LIMIT ? OFFSET ?`).all(...args,limit,(page-1)*limit);
  const matchingFiles=grouped?db.prepare(cte+'SELECT COUNT(*) AS n FROM files WHERE '+where+' AND group_key IN (SELECT group_key FROM result)').get(...args,...args).n:db.prepare('SELECT COUNT(*) AS n FROM files WHERE '+where).get(...args).n;
  return {items:rows.map(r=>publicFile(r)),total,page,limit,grouped,matchingFiles};
}
let statsCache=null,statsAt=0;
function addNamingFilters(filters,args,params={}){
  if(params.orderBatch){const value=String(params.orderBatch);if(value.length>40)throw new Error('订单批次过长。');filters.push('order_batch=?');args.push(value);}
  if(params.projectKind){if(!['order','exhibition','unknown'].includes(params.projectKind))throw new Error('项目来源筛选无效。');filters.push('project_kind=?');args.push(params.projectKind);}
  if(params.backup){if(!['only','exclude'].includes(params.backup))throw new Error('备份筛选无效。');filters.push('is_backup=?');args.push(params.backup==='only'?1:0);}
}
function stats(){
  if(statsCache&&Date.now()-statsAt<1500)return statsCache;
  const grouped=config.getSettings().versionGrouping,count=grouped?'COUNT(DISTINCT group_key)':'COUNT(*)';
  const group=col=>db.prepare(`SELECT ${col} AS name,${count} AS count FROM files WHERE alive=1 AND ${col}<>'' GROUP BY ${col} ORDER BY count DESC,name LIMIT 200`).all();
  const pending=grouped?db.prepare(`WITH ranked AS (SELECT classified,ROW_NUMBER() OVER(PARTITION BY group_key ORDER BY ${representativeOrder}) AS rn FROM files WHERE alive=1) SELECT COUNT(*) AS n FROM ranked WHERE rn=1 AND classified=0`).get().n:db.prepare('SELECT COUNT(*) AS n FROM files WHERE alive=1 AND classified=0').get().n;
  const physicalTotal=db.prepare('SELECT COUNT(*) AS n FROM files WHERE alive=1').get().n,groupTotal=db.prepare('SELECT COUNT(DISTINCT group_key) AS n FROM files WHERE alive=1').get().n;
  statsCache={total:grouped?groupTotal:physicalTotal,physicalTotal,groupTotal,grouped,pending,projects:group('project'),types:group('type'),formats:group('extension').map(r=>({name:r.name.slice(1).toUpperCase(),count:r.count})),orderBatches:db.prepare(`SELECT order_batch AS name,${count} AS count FROM files WHERE alive=1 AND order_batch<>'' GROUP BY order_batch ORDER BY MAX(json_extract(naming_json,'$.orderDate')) DESC,order_batch LIMIT 100`).all(),projectKinds:group('project_kind'),backupCount:db.prepare(`SELECT ${count} AS n FROM files WHERE alive=1 AND is_backup=1`).get().n,backupFileCount:db.prepare('SELECT COUNT(*) AS n FROM files WHERE alive=1 AND is_backup=1').get().n,versionGroups:db.prepare('SELECT COUNT(*) AS n FROM (SELECT group_key FROM files WHERE alive=1 GROUP BY group_key HAVING COUNT(*)>1)').get().n,groupingRules:config.getSettings().groupingRules.map(rule=>({...rule,matchedFiles:db.prepare('SELECT COUNT(*) AS n FROM files WHERE alive=1 AND group_rule=?').get(rule.name).n}))};
  statsAt=Date.now();return statsCache;
}
function invalidateStats(){statsAt=0;}
function classify(id,data){
  const old=getRaw(id);if(!old||!old.alive)throw new Error('图纸不存在或已移出扫描范围。');
  const project=String(data.project||'').trim(),type=String(data.type||'').trim();
  if(project.length>120||type.length>120)throw new Error('项目或类型名称不能超过 120 个字符。');
  if(!project&&!type)throw new Error('请至少填写项目或类型。');
  const tags=[...new Set((Array.isArray(data.tags)?data.tags:[]).map(x=>String(x).trim()).filter(Boolean))];if(tags.length>50||tags.some(x=>x.length>100))throw new Error('标签最多 50 个，每个最多 100 字。');
  db.prepare('UPDATE files SET project=?,type=?,tags=?,classified=1,updated=? WHERE id=?').run(project,type,JSON.stringify(tags),Date.now(),id);event('classify',id,JSON.stringify({project,type,tags}));invalidateStats();return publicFile(getRaw(id),true);
}
function setPreview(id,version,result,expectedPath){
  const row=getRaw(id);if(!row||`${row.modified}-${row.size}`!==version||(expectedPath&&config.pathKey(row.path)!==config.pathKey(expectedPath)))return false;
  db.prepare('UPDATE files SET content=?,content_status=?,preview_status=?,preview_version=?,pages=? WHERE id=?').run(String(result.text||'').slice(0,12000),result.status||'error',result.preview?'ready':(result.status==='error'?'error':'unavailable'),version,result.pages??null,id);return true;
}
async function backup(destination){await require('node:sqlite').backup(db,destination);return destination;}
function listAlive(){return db.prepare('SELECT id,path FROM files WHERE alive=1').all();}
function close(){db.close();}
module.exports={db,DB_PATH,getRaw,publicFile,namingFor,migrateNaming,migrateGroups,representative,representativeOrder,addNamingFilters,upsert,event,markMissing,markPrefixMissing,finishRoot,pruneScope,search,stats,invalidateStats,classify,setPreview,backup,listAlive,close};

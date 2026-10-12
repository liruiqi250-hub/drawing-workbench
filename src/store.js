'use strict';
const {DatabaseSync}=require('node:sqlite');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const config=require('./config');
const {parseDrawingName,normalizeOrderBatch}=require('./drawing-names');
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
const namingColumns={content_revision:"INTEGER NOT NULL DEFAULT 1",classification_revision:"INTEGER NOT NULL DEFAULT 0",naming_json:"TEXT NOT NULL DEFAULT '{}'",naming_search:"TEXT NOT NULL DEFAULT ''",order_batch:"TEXT NOT NULL DEFAULT ''",project_kind:"TEXT NOT NULL DEFAULT 'unknown'",is_backup:'INTEGER NOT NULL DEFAULT 0',group_key:"TEXT NOT NULL DEFAULT ''",group_basis:"TEXT NOT NULL DEFAULT ''",group_rule:"TEXT NOT NULL DEFAULT ''"};
const existingColumns=new Set(db.prepare('PRAGMA table_info(files)').all().map(row=>row.name));
for(const [column,definition] of Object.entries(namingColumns))if(!existingColumns.has(column))db.exec(`ALTER TABLE files ADD COLUMN ${column} ${definition}`);
db.exec("CREATE INDEX IF NOT EXISTS files_order_batch ON files(order_batch); CREATE INDEX IF NOT EXISTS files_project_kind ON files(project_kind); CREATE INDEX IF NOT EXISTS files_is_backup ON files(is_backup); CREATE TABLE IF NOT EXISTS app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
db.exec('CREATE INDEX IF NOT EXISTS files_group ON files(group_key,alive,is_backup)');
function parseNaming(row){const naming=parseDrawingName(row.name,path.dirname(row.path).split(/[\\/]/).filter(Boolean));if(config.getSettings().groupingRules.some(rule=>rule.enabled&&config.contained(row.path,rule.backupRoot))){naming.isBackup=true;naming.backupBasis='directory';naming.backupLabel='备份来源';}return naming;}
function namingValues(naming){return [JSON.stringify(naming),naming.searchText||'',naming.orderBatchKey||'',naming.projectKind||'unknown',naming.isBackup?1:0];}
function namingFor(row){try{const value=JSON.parse(row.naming_json||'{}');if('projectKind' in value)return value;}catch{}return parseNaming(row);}
function migrateNaming(){
  if(db.prepare("SELECT value FROM app_meta WHERE key='naming_version'").get()?.value==='0.5.2')return;
  const rows=db.prepare('SELECT id,name,path FROM files').all();
  const update=db.prepare('UPDATE files SET naming_json=?,naming_search=?,order_batch=?,project_kind=?,is_backup=? WHERE id=?');
  db.exec('BEGIN');try{for(const row of rows)update.run(...namingValues(parseNaming(row)),row.id);db.prepare("INSERT INTO app_meta(key,value)VALUES('naming_version','0.5.2') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
}
migrateNaming();
function migrateGroups(force=false){
  const rules=config.getSettings().groupingRules,signature=JSON.stringify(['0.5.2',rules]);
  if(!force&&db.prepare("SELECT value FROM app_meta WHERE key='grouping_version'").get()?.value===signature)return;
  refreshClassifications();
  const rows=db.prepare('SELECT id,path,name,extension,naming_json FROM files').all(),update=db.prepare('UPDATE files SET naming_json=?,naming_search=?,order_batch=?,project_kind=?,is_backup=?,group_key=?,group_basis=?,group_rule=? WHERE id=?');
  db.exec('BEGIN');try{for(const row of rows){const naming=parseNaming(row),group=groupIdentity(row,naming,rules);update.run(...namingValues(naming),group.key,group.basis,group.ruleName,row.id);}db.prepare("INSERT INTO app_meta(key,value)VALUES('grouping_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(signature);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
  inheritanceByGroup.clear();classificationsDirty=true;refreshClassifications();invalidateStats();
}
db.exec(`CREATE TABLE IF NOT EXISTS group_confirmations(id TEXT PRIMARY KEY,project TEXT NOT NULL,type TEXT NOT NULL,tags TEXT NOT NULL,source TEXT NOT NULL,revision INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS classification_members(file_id TEXT PRIMARY KEY,confirmation_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS group_classifications(group_key TEXT PRIMARY KEY,project TEXT NOT NULL,type TEXT NOT NULL,tags TEXT NOT NULL,classified INTEGER NOT NULL,conflict INTEGER NOT NULL,revision INTEGER NOT NULL,source TEXT NOT NULL);`);
const representativeOrder="is_backup ASC,COALESCE(NULLIF(json_extract(naming_json,'$.backupTimestamp'),''),strftime('%Y-%m-%dT%H:%M:%S',modified/1000,'unixepoch','localtime')) DESC,modified DESC,path_key";
function groupRows(row){return db.prepare(`SELECT * FROM files WHERE alive=1 AND group_key=? ORDER BY ${representativeOrder}`).all(row.group_key);}
function representative(row){return db.prepare(`SELECT * FROM files WHERE alive=1 AND group_key=? ORDER BY ${representativeOrder} LIMIT 1`).get(row.group_key)||row;}
function groupSummary(row){
  const data=db.prepare('SELECT COUNT(*) AS versions,SUM(is_backup) AS backups,SUM(modified+size) AS revision FROM files WHERE alive=1 AND group_key=?').get(row.group_key),main=representative(row);
  const revision=crypto.createHash('sha256').update(JSON.stringify(groupRows(row).map(member=>[member.id,member.path_key,contentVersion(member)]))).digest('hex').slice(0,24);
  return {id:crypto.createHash('sha256').update(row.group_key).digest('hex').slice(0,24),representativeId:main.id,versionCount:data.versions,backupCount:data.backups||0,hasOriginal:data.versions>(data.backups||0),revision,basis:row.group_basis,ruleName:row.group_rule};
}
function idFor(p){return crypto.createHash('sha256').update(config.pathKey(p)).digest('hex').slice(0,24);}
function suggestion(row){
  const text=(row.name+' '+row.path).toLowerCase();let project='',type='';const reasons=[];const naming=namingFor(row);
  for(const r of config.getSettings().classificationRules){if(text.includes(r.keyword.toLowerCase())){if(r.project&&!project)project=r.project;if(r.type&&!type)type=r.type;reasons.push(`文件名或路径包含“${r.keyword}”`);}}
  if(!project&&naming.projectKind==='exhibition'){project=naming.exhibitionName||'展会项目';reasons.unshift('名称或末级目录明确标有展会；具体展会名称不明时统一建议展会项目');}
  if(!project&&naming.orderBatch){project=naming.orderBatchKey||naming.orderBatch;reasons.unshift(`图号前缀 ${naming.orderBatch} 作为订单批次；下单日期 ${naming.orderDate}`);}
  if(!type&&/平面图|平面布置/.test(naming.baseName||row.name))type='平面图';
  if(!project){const parent=path.basename(path.dirname(row.path));const generic=/^(?:共享|订单CAD|订单图|CAD图纸|DWG恐龙钢架机械图纸|CAD|DWG|PDF|图纸|硬盘|\d{4}年?|\d{1,2}月|\d{4}[-.]\d{1,2}|cad自动备份|自动备份|备份|dwgbak files|modify_backup|backup)$/i;
    if(parent&&!/^[a-z]:$/i.test(parent)&&!generic.test(parent)&&parent.length<80){project=parent;reasons.push('上级文件夹名称作为项目候选，需确认');}}
  const tags=[naming.drawingNumber,naming.orderDate,naming.productionSerial?`序号${naming.productionSerial}`:'',naming.productName,naming.productSize,naming.projectKind==='exhibition'?'展会':''].filter(Boolean);
  return {project,type,tags:[...new Set(tags)].slice(0,20),reasons:[...new Set(reasons)].slice(0,6)};
}
function legacyClassification(row){let tags=[];try{tags=JSON.parse(row.tags);}catch{}return {project:row.project,type:row.type,tags,classified:!!row.classified};}
let classificationsDirty=true;
const dirtyGroups=new Set();
const inheritanceByGroup=new Map();
function dirtyClassification(key,identityRemoved=false){if(key){dirtyGroups.add(key);if(identityRemoved)inheritanceByGroup.delete(key);}}
function getClassification(row){
  if(!row)return null;
  const members=row.alive===0?[row]:db.prepare('SELECT * FROM files WHERE group_key=? AND alive=1 ORDER BY id').all(row.group_key);
  const variants=members.map(member=>({fileId:member.id,name:member.name,...legacyClassification(member)}));
  const values=[],seen=new Set();let revision=0;
  for(const member of members){
    const confirmed=db.prepare('SELECT c.* FROM group_confirmations c JOIN classification_members m ON m.confirmation_id=c.id WHERE m.file_id=?').get(member.id);
    if(confirmed){if(!seen.has(confirmed.id)){seen.add(confirmed.id);values.push({...confirmed,tags:JSON.parse(confirmed.tags),classified:true});revision=Math.max(revision,confirmed.revision);}}
    else if(member.classified||member.project||member.type||legacyClassification(member).tags.length){values.push(legacyClassification(member));revision=Math.max(revision,member.classification_revision||0);}
  }
  const projects=[...new Set(values.map(v=>v.project).filter(Boolean))],types=[...new Set(values.map(v=>v.type).filter(Boolean))],tags=[...new Set(values.flatMap(v=>v.tags))];
  const conflict=projects.length>1||types.length>1||tags.length>50;
  if(row.alive!==0)inheritanceByGroup.set(row.group_key,!conflict&&values.length===1&&seen.size===1?[...seen][0]:'');
  // Persist a sole confirmed classification onto newly joined blank members.
  // It then follows those physical identities if a directory rule later splits the group.
  if(row.alive!==0&&!conflict&&values.length===1&&seen.size===1){const confirmation=[...seen][0];for(const member of members)if(!member.classified&&!member.project&&!member.type&&!legacyClassification(member).tags.length)db.prepare('INSERT OR IGNORE INTO classification_members(file_id,confirmation_id)VALUES(?,?)').run(member.id,confirmation);}
  const confirmedVariants=values.filter(value=>value.source).map(value=>({project:value.project,type:value.type,tags:value.tags,classified:true,source:value.source,revision:value.revision}));
  const value={project:projects.length===1?projects[0]:'',type:types.length===1?types[0]:'',tags,classified:values.some(v=>v.classified)&&!conflict,conflict,revision,source:seen.size?(values.filter(v=>v.source).map(v=>v.source).every(v=>v===values.find(v=>v.source)?.source)?values.find(v=>v.source).source:'mixed'):(values.length?'legacy':'none'),variants,confirmedVariants};
  if(row.alive!==0)db.prepare('INSERT INTO group_classifications(group_key,project,type,tags,classified,conflict,revision,source)VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(group_key) DO UPDATE SET project=excluded.project,type=excluded.type,tags=excluded.tags,classified=excluded.classified,conflict=excluded.conflict,revision=excluded.revision,source=excluded.source WHERE group_classifications.project<>excluded.project OR group_classifications.type<>excluded.type OR group_classifications.tags<>excluded.tags OR group_classifications.classified<>excluded.classified OR group_classifications.conflict<>excluded.conflict OR group_classifications.revision<>excluded.revision OR group_classifications.source<>excluded.source').run(row.group_key,value.project,value.type,JSON.stringify(tags),value.classified?1:0,conflict?1:0,revision,value.source);
  return value;
}
function refreshClassifications(){
  if(!classificationsDirty&&!dirtyGroups.size)return;
  const keys=classificationsDirty?db.prepare('SELECT group_key FROM files WHERE alive=1 GROUP BY group_key').all().map(row=>row.group_key):[...dirtyGroups];
  transaction(()=>{for(const group_key of keys)getClassification({group_key});});
  classificationsDirty=false;dirtyGroups.clear();
}
function transaction(callback){const name='store_'+crypto.randomBytes(5).toString('hex');db.exec('SAVEPOINT '+name);try{const value=callback();db.exec('RELEASE '+name);return value;}catch(error){db.exec('ROLLBACK TO '+name);db.exec('RELEASE '+name);throw error;}}
function contentVersion(row){return crypto.createHash('sha256').update(JSON.stringify([row.id,row.file_key||'',row.content_revision||1,row.modified,row.size])).digest('hex').slice(0,32);}
function publicFile(row,detail=false){
  if(!row)return null;
  const classification=getClassification(row);
  const item={id:row.id,name:row.name,path:row.path,extension:row.extension.slice(1).toUpperCase(),size:row.size,modified:row.modified,contentVersion:contentVersion(row),project:classification.project,type:classification.type,tags:classification.tags,classified:classification.classified,exists:!!row.alive,contentStatus:row.content_status,previewStatus:row.preview_status,pages:row.pages,suggestion:classification.classified?null:suggestion(row)};
  item.classification=classification;item.versionClassification=legacyClassification(row);
  item.naming=namingFor(row);
  item.group=groupSummary(row);
  if(detail){item.contentSnippet=row.content.slice(0,4000);item.versions=groupRows(row).map(member=>({id:member.id,name:member.name,path:member.path,extension:member.extension.slice(1).toUpperCase(),size:member.size,modified:member.modified,isBackup:!!member.is_backup,backupTimestamp:namingFor(member).backupTimestamp||'',basis:member.group_basis,ruleName:member.group_rule,isRepresentative:member.id===item.group.representativeId,versionClassification:legacyClassification(member),classification:legacyClassification(member)}));}
  return item;
}
const getRaw=id=>db.prepare('SELECT * FROM files WHERE id=?').get(id);
function upsert(meta,generation='',options={}){return transaction(()=>upsertPhysical(meta,generation,options));}
function upsertPhysical(meta,generation='',options={}){
  const key=config.pathKey(meta.path),atPath=db.prepare('SELECT * FROM files WHERE path_key=?').get(key);
  // Identity wins over a reused path. Missing occupants remain independent tombstones.
  let old;
  if(meta.fileKey){old=db.prepare('SELECT * FROM files WHERE file_key=? ORDER BY alive DESC,updated DESC').all(meta.fileKey).find(row=>row.path_key===key||!fs.existsSync(row.path));}
  if(!old&&atPath&&(!meta.fileKey||!atPath.file_key||atPath.file_key===meta.fileKey))old=atPath;
  if(atPath&&atPath.id!==old?.id)db.prepare('UPDATE files SET path_key=?,alive=0,updated=? WHERE id=?').run(key+'#history:'+atPath.id,Date.now(),atPath.id);
  let id=old?.id||idFor(meta.path);if(!old&&getRaw(id))id=crypto.randomBytes(12).toString('hex');
  const changed=!old||old.modified!==meta.modified||old.size!==meta.size||old.file_key!==(meta.fileKey||'')||!!options.forceInvalidate||!!meta.forceInvalidate;
  if(old){db.prepare(`UPDATE files SET path=?,path_key=?,file_key=?,name=?,extension=?,size=?,modified=?,alive=1,seen_generation=CASE WHEN ?='' THEN seen_generation ELSE ? END,updated=?,content_revision=content_revision+?,content=CASE WHEN ? THEN '' ELSE content END,content_status=CASE WHEN ? THEN 'pending' ELSE content_status END,preview_status=CASE WHEN ? THEN 'pending' ELSE preview_status END,preview_version=CASE WHEN ? THEN '' ELSE preview_version END WHERE id=?`).run(meta.path,key,meta.fileKey||'',meta.name,meta.extension,meta.size,meta.modified,generation,generation,Date.now(),changed?1:0,changed?1:0,changed?1:0,changed?1:0,changed?1:0,id);}
  else db.prepare('INSERT INTO files(id,path,path_key,file_key,name,extension,size,modified,seen_generation,updated,content_revision)VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,meta.path,key,meta.fileKey||'',meta.name,meta.extension,meta.size,meta.modified,generation,Date.now(),(atPath?.content_revision||0)+1);
  const naming=parseNaming(meta),group=groupIdentity(meta,naming,config.getSettings().groupingRules);
  db.prepare('UPDATE files SET naming_json=?,naming_search=?,order_batch=?,project_kind=?,is_backup=?,group_key=?,group_basis=?,group_rule=? WHERE id=?').run(...namingValues(naming),group.key,group.basis,group.ruleName,id);
  // Inherit by a cached live-group confirmation, without rescanning every prior
  // version for each new backup. Identity moves/replacements invalidate the cache.
  if(old&&(old.group_key!==group.key||!old.alive)){inheritanceByGroup.delete(old.group_key);inheritanceByGroup.delete(group.key);}
  if(atPath&&atPath.id!==old?.id)inheritanceByGroup.delete(atPath.group_key);
  if(!old){
    if(!inheritanceByGroup.has(group.key)){
      const confirmations=db.prepare('SELECT DISTINCT m.confirmation_id FROM classification_members m JOIN files f ON f.id=m.file_id WHERE f.group_key=? AND f.alive=1 AND f.id<>? LIMIT 2').all(group.key,id);
      // A single confirmation ID alone is insufficient: an unassigned legacy
      // member can disagree with it, or the complete tag union can overflow.
      if(confirmations.length===1)getClassification({group_key:group.key});else inheritanceByGroup.set(group.key,'');
    }
    const confirmation=inheritanceByGroup.get(group.key);if(confirmation)db.prepare('INSERT OR IGNORE INTO classification_members(file_id,confirmation_id)VALUES(?,?)').run(id,confirmation);
  }
  if(!old||old.group_key!==group.key||atPath&&atPath.id!==old.id){dirtyClassification(old?.group_key);dirtyClassification(atPath?.group_key);dirtyClassification(group.key);}invalidateStats();return {id,changed};
}
function event(action,id,details=''){db.prepare('INSERT INTO events(at,action,file_id,details)VALUES(?,?,?,?)').run(Date.now(),action,id||null,details);db.exec('DELETE FROM events WHERE id < (SELECT COALESCE(MAX(id),0)-3000 FROM events)');}
function markMissing(p){const key=config.pathKey(p),row=db.prepare('SELECT group_key FROM files WHERE path_key=? AND alive=1').get(key);dirtyClassification(row?.group_key,true);invalidateStats();return db.prepare('UPDATE files SET alive=0,updated=? WHERE path_key=? AND alive=1').run(Date.now(),key).changes;}
function markPrefixMissing(p){const key=config.pathKey(p);for(const row of db.prepare("SELECT DISTINCT group_key FROM files WHERE alive=1 AND (path_key=? OR substr(path_key,1,?)=?)").all(key,key.length+1,key+path.sep))dirtyClassification(row.group_key,true);invalidateStats();return db.prepare("UPDATE files SET alive=0,updated=? WHERE alive=1 AND (path_key=? OR substr(path_key,1,?)=?)").run(Date.now(),key,key.length+1,key+path.sep).changes;}
function finishRoot(root,generation,startedAt){
  const key=config.pathKey(root);for(const row of db.prepare("SELECT DISTINCT group_key FROM files WHERE alive=1 AND seen_generation<>? AND updated<? AND (path_key=? OR substr(path_key,1,?)=?)").all(generation,startedAt,key,key.length+1,key+path.sep))dirtyClassification(row.group_key,true);db.prepare("UPDATE files SET alive=0,updated=? WHERE alive=1 AND seen_generation<>? AND updated<? AND (path_key=? OR substr(path_key,1,?)=?)").run(Date.now(),generation,startedAt,key,key.length+1,key+path.sep);invalidateStats();
}
function pruneScope(settings){
  const rows=db.prepare('SELECT id,path,group_key FROM files WHERE alive=1').all();const stmt=db.prepare('UPDATE files SET alive=0 WHERE id=?');db.exec('BEGIN');try{for(const row of rows)if(!config.isAllowed(row.path,settings)){stmt.run(row.id);dirtyClassification(row.group_key,true);}db.exec('COMMIT');invalidateStats();}catch(e){db.exec('ROLLBACK');throw e;}
}
function pattern(term){return '%'+String(term).replace(/[\\%_]/g,'\\$&')+'%';}
function termSql(alias,term,args,includeText=true,grouped=true){const columns=['name','path','naming_search','project','type','tags',...(includeText?['content']:[])];for(const col of columns)args.push(pattern(term));const clauses=columns.map(col=>alias+'.'+col+" LIKE ? ESCAPE '\\'");if(grouped)for(const col of ['project','type','tags']){args.push(pattern(term));clauses.push('c.'+col+" LIKE ? ESCAPE '\\'");}return '('+clauses.join(' OR ')+')';}
function buildQuery(params={},groups=[],includeText=true){
  refreshClassifications();const grouped=params.grouped==='0'?false:params.grouped==='1'?true:config.getSettings().versionGrouping,args=[],filters=['f.alive=1'];
  const exists=(condition)=>grouped?'EXISTS (SELECT 1 FROM files e WHERE e.alive=1 AND e.group_key=f.group_key AND '+condition+')':condition.replaceAll('e.','f.');
  for(const group of groups)filters.push(exists('('+group.map(term=>termSql('e',term,args,includeText,grouped)).join(' OR ')+')'));
  for(const field of ['project','type'])if(params[field]){filters.push((grouped?'c':'f')+'.'+field+'=?');args.push(String(params[field]));}
  if(params.pending===true||params.pending==='1')filters.push((grouped?'c':'f')+'.classified=0');
  const physical=[],physicalArgs=[];addNamingFilters(physical,physicalArgs,params);if(params.format){physical.push('extension=?');physicalArgs.push('.'+String(params.format).replace(/^\./,'').toLowerCase());}
  // Each scope facet has its own existential condition, just like each subject.
  physical.forEach((condition,i)=>{filters.push(exists(condition.replace(/\b(order_batch|project_kind|is_backup|extension)\b/g,'e.$1')));args.push(physicalArgs[i]);});
  if(params.formats?.length){filters.push(exists('e.extension IN ('+params.formats.map(()=>'?').join(',')+')'));args.push(...params.formats);}
  const cte=`WITH scoped AS (SELECT f.* FROM files f LEFT JOIN group_classifications c USING(group_key) WHERE ${filters.join(' AND ')}),ranked AS (SELECT scoped.*,ROW_NUMBER() OVER(PARTITION BY group_key ORDER BY ${representativeOrder}) rn FROM scoped),result AS (SELECT * FROM ${grouped?'ranked WHERE rn=1':'scoped'}) `;
  return {cte,args,grouped};
}
function search(params={}){
  const q=String(params.q||'').trim().slice(0,300),groups=q.split(/\s+/).filter(Boolean).slice(0,12).map(token=>[token]);const {cte,args,grouped}=buildQuery(params,groups);
  const total=db.prepare(cte+'SELECT COUNT(*) n FROM result').get(...args).n;
  const limit=Math.max(10,Math.min(200,Math.floor(Number(params.limit)||config.getSettings().pageSize))),page=Math.max(1,Math.min(Math.max(1,Math.ceil(total/limit)),Math.floor(Number(params.page)||1)));
  const sort={modified:'modified DESC,name COLLATE NOCASE',name:'name COLLATE NOCASE',size:'size DESC,modified DESC'}[params.sort]||'modified DESC,name COLLATE NOCASE';
  const rows=db.prepare(cte+'SELECT * FROM result ORDER BY '+sort+' LIMIT ? OFFSET ?').all(...args,limit,(page-1)*limit);
  const matchingFiles=db.prepare(cte+'SELECT COUNT(*) n FROM scoped').get(...args).n;
  return {items:rows.map(row=>grouped?publicFile(row):({...publicFile(row),...legacyClassification(row)})),total,page,limit,grouped,matchingFiles};
}
function candidateRows(plan,scope={},limit=60,includeText=false){
  let groups=(plan.groups||[]).map(group=>group.filter(term=>typeof term==='string'&&term.trim())).filter(group=>group.length);
  if(!groups.length&&plan.keywords?.length)groups=[plan.keywords.filter(term=>typeof term==='string'&&term.trim())];
  if(!groups.length)throw new Error('AI 未生成有效检索条件，请补充名称、项目、用途或零件特征。');
  const formats=(plan.formats||[]).filter(f=>/^\.?[a-zA-Z0-9]{1,12}$/.test(f)).map(f=>'.'+f.toLowerCase().replace(/^\./,''));
  const {cte,args,grouped}=buildQuery({...scope,formats:scope.format?[]:formats},groups,includeText),scoreArgs=[];
  const optional=[...new Set((plan.keywords||[]).filter(term=>typeof term==='string'&&term.trim()))].slice(0,12);
  const scoreText="(s.path||' '||s.naming_search||' '||s.project||' '||s.type||' '||s.tags"+(includeText?"||' '||s.content":"")+(grouped?"||' '||COALESCE(sc.project,'')||' '||COALESCE(sc.type,'')||' '||COALESCE(sc.tags,'')":"")+")";
  const score=[...new Set([...groups.flat(),...optional])].map(term=>{scoreArgs.push(pattern(term),pattern(term));return "CASE WHEN s.name LIKE ? ESCAPE '\\' THEN 4 ELSE 0 END+CASE WHEN "+scoreText+" LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END";}).join('+')||'0';
  const rows=db.prepare(cte+`SELECT result.*,(SELECT MAX(${score}) FROM scoped s ${grouped?'LEFT JOIN group_classifications sc ON sc.group_key=s.group_key':''} WHERE ${grouped?'s.group_key=result.group_key':'s.id=result.id'}) ai_score FROM result ORDER BY ai_score DESC,modified DESC LIMIT ?`).all(...args,...scoreArgs,Math.max(20,Math.min(100,Number(limit)||60)));
  return rows.map(row=>{
    const members=grouped?groupRows(row):[row],selected=[],picked=new Set(),classification=grouped?getClassification(row):legacyClassification(row);
    // A legacy union is useful for group filtering, but it does not prove that
    // every physical version owns a tag. Cover subjects with the actual owner.
    const haystacks=new Map(members.map(member=>[member.id,[member.name,member.path,member.naming_search,member.project,member.type,member.tags,...(includeText?[member.content]:[])].join(' ').toLowerCase()]));
    const legacyHaystacks=new Map(members.map(member=>[member.id,[member.project,member.type,member.tags].join(' ').toLowerCase()]));
    const terms=[...new Set([...groups.flat(),...optional])];
    const physicalTerms=member=>terms.filter(term=>haystacks.get(member.id).includes(String(term).toLowerCase()));
    const matches=(member,group)=>group.some(term=>haystacks.get(member.id).includes(String(term).toLowerCase()));
    // Only explicitly confirmed values can stand as common-classification
    // evidence. Unconfirmed legacy values must retain their physical owner.
    const confirmed=classification.confirmedVariants||[];
    const common={project:confirmed.some(value=>value.project===classification.project)?classification.project:'',type:confirmed.some(value=>value.type===classification.type)?classification.type:'',tags:(classification.tags||[]).filter(tag=>confirmed.some(value=>value.tags.includes(tag))),source:classification.source,revision:classification.revision,conflict:!!classification.conflict};
    const groupHaystack=grouped&&confirmed.length?[common.project,common.type,JSON.stringify(common.tags)].join(' ').toLowerCase():'';
    const groupTerms=terms.filter(term=>groupHaystack.includes(String(term).toLowerCase()));
    const origin=member=>{const versionTerms=physicalTerms(member);return {kind:versionTerms.length?'version':'scope',versionTerms,groupTerms:[]};};
    const pick=(member,cap=8)=>{if(member&&!picked.has(member.id)&&selected.length<cap){picked.add(member.id);selected.push({...member,evidenceOrigin:origin(member)});}};
    const coverage=member=>groups.reduce((score,group)=>score+(matches(member,group)?1:0),0);
    const legacyCoverage=member=>groups.reduce((score,group)=>score+(group.some(term=>legacyHaystacks.get(member.id).includes(String(term).toLowerCase()))?1:0),0);
    const backupEvidence=scope.backup==='only'?members.filter(member=>member.is_backup).sort((a,b)=>coverage(b)-coverage(a)||legacyCoverage(b)-legacyCoverage(a))[0]:null;
    if(backupEvidence&&coverage(backupEvidence)>0)pick(backupEvidence);
    let uncovered=groups.filter(group=>!selected.some(member=>matches(member,group)));
    while(uncovered.length&&selected.length<8){
      const ranked=members.filter(member=>!picked.has(member.id)).map(member=>({member,score:uncovered.reduce((score,group)=>score+(matches(member,group)?1:0),0)})).sort((a,b)=>b.score-a.score||legacyCoverage(b.member)-legacyCoverage(a.member));
      if(!ranked[0]?.score)break;pick(ranked[0].member);uncovered=uncovered.filter(group=>!matches(ranked[0].member,group));
    }
    const attachGroupEvidence=matched=>{
      if(!matched.length)return;
      if(!selected.length)pick(row);
      const anchor=selected.find(member=>member.id===row.id)||selected[0];
      anchor.evidenceOrigin={...anchor.evidenceOrigin,kind:anchor.evidenceOrigin.versionTerms.length?'mixed':'group',groupTerms:[...new Set([...anchor.evidenceOrigin.groupTerms,...matched])],groupClassification:common};
    };
    const commonSubjects=uncovered.filter(group=>group.some(term=>groupTerms.includes(term)));
    attachGroupEvidence([...new Set(commonSubjects.flatMap(group=>group.filter(term=>groupTerms.includes(term))))]);
    // Optional ranking terms must retain their real owners before unrelated
    // versions fill the evidence cap. A separate backup proof reserves slot 9.
    const optionalCovered=term=>selected.some(member=>member.evidenceOrigin.versionTerms.includes(term)||member.evidenceOrigin.groupTerms.includes(term));
    let remainingOptional=optional.filter(term=>!optionalCovered(term));
    while(remainingOptional.length&&selected.length<9){
      const ranked=members.filter(member=>!picked.has(member.id)).map(member=>({member,score:remainingOptional.filter(term=>matches(member,[term])).length})).filter(value=>value.score>0).sort((a,b)=>b.score-a.score||legacyCoverage(b.member)-legacyCoverage(a.member));
      const candidate=ranked.find(value=>selected.length<8||!backupEvidence||selected.some(member=>member.is_backup)||value.member.is_backup)?.member;
      if(!candidate)break;pick(candidate,9);remainingOptional=remainingOptional.filter(term=>!optionalCovered(term));
    }
    attachGroupEvidence(remainingOptional.filter(term=>groupTerms.includes(term)));
    for(const member of members)if(groups.some(group=>matches(member,group)))pick(member);
    // Eight independent subjects can require eight versions. An unrelated
    // backup that alone proves backup=only is the sole permitted ninth item.
    if(backupEvidence&&!selected.some(member=>member.is_backup)&&selected.length<9)selected.push({...backupEvidence,evidenceOrigin:origin(backupEvidence)});
    const truncatedKeywords=optional.filter(term=>!optionalCovered(term)&&(groupTerms.includes(term)||members.some(member=>matches(member,[term]))));
    return {row,evidenceRows:selected.length?selected:[{...row,evidenceOrigin:origin(row)}],truncatedKeywords};
  });
}
let statsCache=null,statsAt=0;
function addNamingFilters(filters,args,params={}){
  if(params.orderBatch){const value=normalizeOrderBatch(String(params.orderBatch));if(value.length>40)throw new Error('订单批次过长。');filters.push('order_batch=?');args.push(value);}
  if(params.projectKind){if(!['order','exhibition','unknown'].includes(params.projectKind))throw new Error('项目来源筛选无效。');filters.push('project_kind=?');args.push(params.projectKind);}
  if(params.backup){if(!['only','exclude'].includes(params.backup))throw new Error('备份筛选无效。');filters.push('is_backup=?');args.push(params.backup==='only'?1:0);}
}
function stats(){
  if(statsCache&&Date.now()-statsAt<1500)return statsCache;refreshClassifications();
  const grouped=config.getSettings().versionGrouping,count=grouped?'COUNT(DISTINCT f.group_key)':'COUNT(*)';
  const group=col=>db.prepare(`SELECT ${col} AS name,${count} AS count FROM files f LEFT JOIN group_classifications c USING(group_key) WHERE f.alive=1 AND ${col}<>'' GROUP BY ${col} ORDER BY count DESC,name LIMIT 200`).all();
  const physicalTotal=db.prepare('SELECT COUNT(*) n FROM files WHERE alive=1').get().n,groupTotal=db.prepare('SELECT COUNT(DISTINCT group_key) n FROM files WHERE alive=1').get().n;
  const pending=db.prepare(`SELECT ${count} n FROM files f LEFT JOIN group_classifications c USING(group_key) WHERE f.alive=1 AND ${grouped?'c':'f'}.classified=0`).get().n;
  statsCache={total:grouped?groupTotal:physicalTotal,physicalTotal,groupTotal,grouped,pending,projects:group((grouped?'c':'f')+'.project'),types:group((grouped?'c':'f')+'.type'),formats:group('f.extension').map(row=>({name:row.name.slice(1).toUpperCase(),count:row.count})),orderBatches:group('f.order_batch').slice(0,100),projectKinds:group('f.project_kind'),backupCount:db.prepare(`SELECT ${count} n FROM files f WHERE f.alive=1 AND f.is_backup=1`).get().n,backupFileCount:db.prepare('SELECT COUNT(*) n FROM files WHERE alive=1 AND is_backup=1').get().n,versionGroups:db.prepare('SELECT COUNT(*) n FROM (SELECT group_key FROM files WHERE alive=1 GROUP BY group_key HAVING COUNT(*)>1)').get().n,groupingRules:config.getSettings().groupingRules.map(rule=>({...rule,matchedFiles:db.prepare('SELECT COUNT(*) n FROM files WHERE alive=1 AND group_rule=?').get(rule.name).n}))};statsAt=Date.now();return statsCache;
}
function invalidateStats(){statsAt=0;}
function classify(id,data){
  const old=getRaw(id);if(!old||!old.alive)throw new Error('图纸不存在或已移出扫描范围。');
  const project=String(data.project||'').trim(),type=String(data.type||'').trim();
  if(project.length>120||type.length>120)throw new Error('项目或类型名称不能超过 120 个字符。');
  if(!project&&!type)throw new Error('请至少填写项目或类型。');
  const tags=[...new Set((Array.isArray(data.tags)?data.tags:[]).map(x=>String(x).trim()).filter(Boolean))];if(tags.length>50||tags.some(x=>x.length>100))throw new Error('标签最多 50 个，每个最多 100 字。');
  const scope=data.scope||'group';if(!['group','version'].includes(scope))throw new Error('分类范围无效。');
  if(scope==='group'&&getClassification(old).conflict&&data.resolveConflict!==true){const error=new Error('该组存在历史版本分类冲突，请明确复核后确认共同分类。');error.status=409;throw error;}
  transaction(()=>{if(scope==='version'){db.prepare('UPDATE files SET project=?,type=?,tags=?,classified=1,updated=?,classification_revision=? WHERE id=?').run(project,type,JSON.stringify(tags),Date.now(),Math.max(Date.now(),(old.classification_revision||0)+1),id);db.prepare('DELETE FROM classification_members WHERE file_id=?').run(id);}
    else{const confirmation=crypto.randomBytes(12).toString('hex'),revision=Math.max(Date.now(),(db.prepare('SELECT MAX(revision) r FROM group_confirmations').get().r||0)+1);db.prepare('INSERT INTO group_confirmations(id,project,type,tags,source,revision)VALUES(?,?,?,?,?,?)').run(confirmation,project,type,JSON.stringify(tags),String(data.source||'manual'),revision);for(const member of groupRows(old))db.prepare('INSERT INTO classification_members(file_id,confirmation_id)VALUES(?,?) ON CONFLICT(file_id) DO UPDATE SET confirmation_id=excluded.confirmation_id').run(member.id,confirmation);}
    event('classify',id,JSON.stringify({project,type,tags,scope}));getClassification(old);
  });invalidateStats();return publicFile(getRaw(id),true);
}
function setPreview(id,version,result,expectedPath){
  const row=getRaw(id);if(!row||!row.alive||contentVersion(row)!==version||(expectedPath&&config.pathKey(row.path)!==config.pathKey(expectedPath)))return false;
  db.prepare('UPDATE files SET content=?,content_status=?,preview_status=?,preview_version=?,pages=? WHERE id=?').run(String(result.text||'').slice(0,12000),result.status||'error',result.preview?'ready':(result.status==='error'?'error':'unavailable'),version,result.pages??null,id);return true;
}
async function backup(destination){await require('node:sqlite').backup(db,destination);return destination;}
function listAlive(){return db.prepare('SELECT id,path FROM files WHERE alive=1').all();}
function close(){db.close();}
migrateGroups();refreshClassifications();
module.exports={getClassification,contentVersion,candidateRows,suggestion,db,DB_PATH,getRaw,publicFile,namingFor,migrateNaming,migrateGroups,representative,representativeOrder,addNamingFilters,upsert,event,markMissing,markPrefixMissing,finishRoot,pruneScope,search,stats,invalidateStats,classify,setPreview,backup,listAlive,close};

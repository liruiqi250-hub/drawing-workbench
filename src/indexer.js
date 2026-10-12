'use strict';
const fs=require('node:fs');
const path=require('node:path');
const config=require('./config');
const store=require('./store');
const {spawn}=require('node:child_process');
const readline=require('node:readline');
const state={running:false,scanned:0,found:0,errors:0,currentRoot:'',startedAt:null,finishedAt:null,lastEventAt:null,watching:[],watchErrors:[],errorSamples:[],lastScanReason:''};
let epoch=0,watchers=[],interval=null,eventTimer=null,reconnectTimer=null,stopped=false,scanPromise=null,requested=false,reconnectDelay=1000;
let watchProcess=null;
const pending=new Map(),treePending=new Set();let treeRunning=0;
const pause=()=>new Promise(resolve=>setImmediate(resolve));
function recordError(p,error,watch=false){
  state.errors++;
  const info={path:p,message:error.code||error.message||String(error)};
  if(state.errorSamples.length<30)state.errorSamples.push(info);
  if(watch&&!state.watchErrors.some(e=>e.path===p&&e.message===info.message))state.watchErrors.push(info);
}
function meta(p,stat){return {path:p,name:path.basename(p),extension:path.extname(p).toLowerCase(),size:Number(stat.size),modified:Number(stat.mtimeMs),fileKey:stat.ino?`${path.parse(p).root.toLowerCase()}:${stat.dev}:${stat.ino}`:''};}
async function visitTree(root,generation,token,progress=true){
  const settings=config.getSettings(),stack=[root];let failures=0;
  while(stack.length&&!stopped&&token===epoch){
    const dir=stack.pop();if(!config.isAllowed(dir,settings,false))continue;
    let entries;
    try{entries=await fs.promises.readdir(dir,{withFileTypes:true});}catch(e){if(!['ENOENT','ENOTDIR'].includes(e.code)){recordError(dir,e);failures++;}continue;}
    for(const entry of entries){
      if(stopped||token!==epoch)break;
      const p=path.join(dir,entry.name);
      if(config.isExcluded(p,settings)||entry.isSymbolicLink())continue;
      if(entry.isDirectory()){stack.push(p);continue;}
      if(!entry.isFile()||!settings.extensions.includes(path.extname(entry.name).toLowerCase()))continue;
      if(progress)state.scanned++;
      try{const stat=await fs.promises.stat(p,{bigint:true});if(stat.isFile()&&!stopped&&token===epoch&&config.isAllowed(p)){store.upsert(meta(p,stat),generation);if(progress)state.found++;}}
      catch(e){if(e.code!=='ENOENT'){recordError(p,e);failures++;}}
      if(progress&&state.scanned%100===0){store.invalidateStats();await pause();}
    }
    await pause();
  }
  store.invalidateStats();return {complete:!stopped&&token===epoch,failures};
}
async function reconcileMissing(root,token){
  // Missing records are checked individually after scans with unreadable subtrees.
  // A permission or sharing error must never be treated as deletion.
  for(const row of store.listAlive()){
    if(stopped||token!==epoch)return;
    if(!config.contained(row.path,root))continue;
    try{await fs.promises.stat(row.path);}catch(e){if(e.code==='ENOENT'||e.code==='ENOTDIR'){
      try{await fs.promises.readdir(root);}catch{return;}
      if(!stopped&&token===epoch)store.markMissing(row.path);
    }}
  }
  store.invalidateStats();
}
function scan(reason='manual'){
  if(stopped)return Promise.resolve();
  if(scanPromise){requested=true;state.lastQueuedReason=reason;return scanPromise;}
  scanPromise=(async()=>{
    do{
      requested=false;const token=epoch;
      Object.assign(state,{running:true,scanned:0,found:0,errors:0,errorSamples:[],startedAt:Date.now(),finishedAt:null,lastScanReason:reason});
      for(const root of config.getSettings().roots){
        if(stopped||token!==epoch)break;
        state.currentRoot=root;const rootStartedAt=Date.now(),generation=`${rootStartedAt}-${Math.random().toString(36).slice(2)}`;
        try{if(!(await fs.promises.stat(root)).isDirectory())throw new Error('扫描位置不是文件夹');}catch(error){recordError(root,error);continue;}
        const result=await visitTree(root,generation,token);
        if(result.complete){
          try{await fs.promises.readdir(root);}catch(error){recordError(root,error);continue;}
          if(stopped||token!==epoch)break;
          if(result.failures===0)store.finishRoot(root,generation,rootStartedAt);else await reconcileMissing(root,token);
        }
      }
      state.running=false;state.currentRoot='';state.finishedAt=Date.now();store.invalidateStats();
    }while(requested&&!stopped);
  })().catch(e=>{recordError(state.currentRoot,e);state.running=false;state.finishedAt=Date.now();console.error('扫描异常',e);}).finally(()=>{scanPromise=null;});
  return scanPromise;
}
function queueTree(p){
  if([...treePending].some(parent=>config.contained(p,parent)))return;
  for(const child of treePending)if(config.contained(child,p))treePending.delete(child);
  treePending.add(p);pumpTrees();
}
function pumpTrees(){
  while(!stopped&&treeRunning<2&&treePending.size){
    const p=treePending.values().next().value;treePending.delete(p);treeRunning++;
    visitTree(p,'',epoch,false).catch(console.error).finally(()=>{treeRunning--;pumpTrees();});
  }
}
async function processPath(p,retry=0,kind){
  const token=epoch,settings=config.getSettings();if(stopped||!config.isAllowed(p,settings,false))return;
  try{
    const stat=await fs.promises.lstat(p,{bigint:true});
    if(stopped||token!==epoch||!config.isAllowed(p,config.getSettings(),false))return;
    if(stat.isSymbolicLink())return;
    if(stat.isDirectory()){if(kind==='change')return;if(kind)queueTree(p);else await visitTree(p,'',epoch,false);}
    else if(stat.isFile()&&config.isAllowed(p,settings))store.upsert(meta(p,stat));
  }catch(e){
    if(stopped||token!==epoch)return;
    if(e.code==='ENOENT'||e.code==='ENOTDIR'){
      const root=config.getSettings().roots.find(r=>config.contained(p,r));
      try{if(root)await fs.promises.readdir(root);else return;}catch{return;}
      if(token===epoch)store.markPrefixMissing(p);
    }
    else if(retry<3){setTimeout(()=>processPath(p,retry+1,kind).catch(console.error),400*(retry+1)).unref();}
    else recordError(p,e);
  }
  store.invalidateStats();
}
async function drainEvents(){
  eventTimer=null;const batch=[...pending];pending.clear();
  for(let i=0;i<batch.length;i+=32){if(stopped)break;await Promise.all(batch.slice(i,i+32).map(([p,kind])=>processPath(p,0,kind)));}
}
function queueEvent(p,kind){
  state.lastEventAt=Date.now();
  if(!config.isAllowed(p,config.getSettings(),false))return;
  if(kind==='change'&&!config.getSettings().extensions.includes(path.extname(p).toLowerCase()))return;
  pending.set(p,kind);
  if(pending.size>10000){pending.clear();scan('watch-overflow');return;}
  if(!eventTimer){eventTimer=setTimeout(()=>drainEvents().catch(console.error),80);eventTimer.unref();}
}
function attachNodeWatchers(){
  for(const watcher of watchers)watcher.close();watchers=[];state.watching=[];state.watchErrors=[];
  const settings=config.getSettings();if(!settings.watch)return;
  for(const root of settings.roots){
    try{
      const watcher=fs.watch(root,{recursive:true,persistent:true},(kind,filename)=>{
        if(filename===null){scan('watch-reconcile');return;}
        const p=path.resolve(root,String(filename));
        queueEvent(p,kind);
      });
      watcher.on('error',error=>{recordError(root,error,true);state.watching=state.watching.filter(p=>p!==root);watcher.close();scheduleReconnect();scan('watch-error');});
      watchers.push(watcher);state.watching.push(root);
    }catch(error){recordError(root,error,true);scheduleReconnect();}
  }
  if(!state.watchErrors.length)reconnectDelay=1000;
}
function useNative(){return process.platform==='win32'&&fs.existsSync(config.PYTHON)&&fs.existsSync(path.join(config.APP_DIR,'tools','watch_directories.py'));}
function engine(){return useNative()?'Windows 原生目录监听 + SQLite':'Windows 实时目录监听 + SQLite';}
function attachWatchers(){
  if(watchProcess){const old=watchProcess;watchProcess=null;old.kill();}
  for(const watcher of watchers)watcher.close();watchers=[];state.watching=[];state.watchErrors=[];
  if(!config.getSettings().watch)return;
  if(!useNative()){attachNodeWatchers();return;}
  const child=spawn(config.PYTHON,[path.join(config.APP_DIR,'tools','watch_directories.py'),'--config',config.CONFIG_PATH],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONUTF8:'1'}});
  watchProcess=child;
  const completed=new Set();let readyResolve;
  const readiness=new Promise(resolve=>{readyResolve=resolve;});
  const readyTimer=setTimeout(()=>{if(watchProcess===child){for(const root of config.getSettings().roots)if(!completed.has(root))recordError(root,new Error('监听建立超时'),true);scheduleReconnect();}readyResolve();},10000);readyTimer.unref();
  const settle=()=>{if(completed.size>=config.getSettings().roots.length){clearTimeout(readyTimer);readyResolve();}};
  const lines=readline.createInterface({input:child.stdout});
  lines.on('line',line=>{
    if(watchProcess!==child||stopped)return;
    let message;try{message=JSON.parse(line);}catch{return;}
    const root=message.root;
    if(!config.getSettings().roots.includes(root))return;
    if(message.type==='ready'){
      completed.add(root);settle();
      const recovered=state.watchErrors.some(e=>e.path===root);
      if(!state.watching.includes(root))state.watching.push(root);
      state.watchErrors=state.watchErrors.filter(e=>e.path!==root);reconnectDelay=1000;
      if(recovered)scan('native-root-reconnected');
    }else if(message.type==='batch'){
      for(const change of message.changes||[]){if(typeof change.path==='string'&&config.contained(change.path,root))queueEvent(change.path,change.action===3?'change':'rename');}
    }else if(message.type==='overflow'){
      state.overflowCount=(state.overflowCount||0)+1;scan('native-watch-overflow');
    }else if(message.type==='error'){
      completed.add(root);settle();
      // The Python reader retries each root separately; a disconnected share
      // must not restart healthy drive watchers or continuously rescan them.
      state.watching=state.watching.filter(p=>p!==root);recordError(root,new Error(message.error||'监听失败'),true);
    }
  });
  child.stderr.on('data',data=>console.error('监听进程',String(data).slice(0,2000)));
  child.on('error',error=>{clearTimeout(readyTimer);readyResolve();if(watchProcess===child){recordError('原生监听进程',error,true);scheduleReconnect();}});
  child.on('exit',code=>{clearTimeout(readyTimer);readyResolve();lines.close();if(watchProcess!==child||stopped)return;watchProcess=null;state.watching=[];recordError('原生监听进程',new Error('监听进程已退出：'+code),true);scheduleReconnect();});
  return readiness;
}
function scheduleReconnect(){
  if(stopped||reconnectTimer||!config.getSettings().watch)return;
  reconnectTimer=setTimeout(async()=>{reconnectTimer=null;await attachWatchers();if(!stopped)scan('watch-reconnected');},reconnectDelay);
  reconnectTimer.unref();reconnectDelay=Math.min(60000,reconnectDelay*2);
}
function configure(){
  epoch++;const token=epoch,ready=attachWatchers();store.pruneScope(config.getSettings());store.invalidateStats();
  if(interval)clearInterval(interval);
  interval=setInterval(()=>{if(state.watchErrors.length&&!useNative())attachWatchers();scan('scheduled');},config.getSettings().rescanMinutes*60000);interval.unref();
  state.running=true;Promise.resolve(ready).then(()=>{if(!stopped&&token===epoch)scan('configuration');});
}
function start(){stopped=false;configure();}
function stop(){stopped=true;epoch++;if(interval)clearInterval(interval);if(eventTimer)clearTimeout(eventTimer);if(reconnectTimer)clearTimeout(reconnectTimer);for(const w of watchers)w.close();watchers=[];if(watchProcess){const child=watchProcess;watchProcess=null;child.kill();}pending.clear();treePending.clear();}
function status(){return {...structuredClone(state),queuedEvents:pending.size,directoryScans:treeRunning+treePending.size};}
module.exports={start,stop,configure,scan,status,processPath,engine};

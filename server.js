'use strict';
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const config=require('./src/config');
const store=require('./src/store');
const indexer=require('./src/indexer');
const preview=require('./src/preview');
const desktop=require('./src/desktop');
const aiStore=require('./src/ai-store');
const localRules=require('./src/local-rules');
const ai=require('./src/ai').createAiService({getSettings:config.getSettings,dataDir:config.DATA_DIR,python:config.PYTHON});
const HOST='127.0.0.1';
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.pdf':'application/pdf'};
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
function secure(req,res){
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  const hosts=[`127.0.0.1:${config.PORT}`,`localhost:${config.PORT}`];
  if(!hosts.includes(req.headers.host)){json(res,403,{error:'仅允许通过本机地址访问。'});return false;}
  const origin=req.headers.origin;
  if(origin&&!hosts.some(h=>origin===`http://${h}`)){json(res,403,{error:'已阻止跨站请求。'});return false;}
  if(req.headers['sec-fetch-site']==='cross-site'){json(res,403,{error:'已阻止跨站请求。'});return false;}
  if(!['GET','HEAD'].includes(req.method)&&req.headers['x-requested-with']!=='DrawingWorkbench'){json(res,403,{error:'请求校验失败，请在图纸工作台内操作。'});return false;}
  return true;
}
async function body(req){
  let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>65536){const e=new Error('请求内容超过 64KB。');e.status=413;throw e;}chunks.push(chunk);}
  try{const parsed=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error();return parsed;}catch{const e=new Error('请求内容不是有效的 JSON 对象。');e.status=400;throw e;}
}
function requireActiveResponse(res){
  if(res.destroyed||res.writableEnded||res.socket?.destroyed){const error=new Error('本次请求已结束，已停止后续 AI 调用。');error.status=499;throw error;}
}
async function allowedRow(id){
  if(!/^[a-f0-9]{24}$/.test(id))return null;
  const row=store.getRaw(id);if(!row||!row.alive||!config.isAllowed(row.path))return null;
  // Resolve junctions and symlinks before opening local content.
  try{const real=await fs.promises.realpath(row.path);if(!config.isAllowed(real))return null;return row;}catch(e){if(e.code==='ENOENT'||e.code==='ENOTDIR'){store.markMissing(row.path);store.invalidateStats();}return null;}
}
function streamFile(req,res,p,type){
  const stat=fs.statSync(p);let start=0,end=stat.size-1,status=200;
  const range=req.headers.range;
  if(range){const m=/^bytes=(\d*)-(\d*)$/.exec(range);if(!m){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});res.end();return;}
    if(!m[1]){start=Math.max(0,stat.size-Number(m[2]));}else{start=Number(m[1]);if(m[2])end=Math.min(end,Number(m[2]));}
    if(start>end||start>=stat.size){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});res.end();return;}status=206;
  }
  const headers={'Content-Type':type,'Content-Length':Math.max(0,end-start+1),'Accept-Ranges':'bytes','Cache-Control':'no-cache'};
  if(status===206)headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;
  res.writeHead(status,headers);if(req.method==='HEAD'||stat.size===0){res.end();return;}
  const stream=fs.createReadStream(p,{start,end});stream.on('error',()=>res.destroy());stream.pipe(res);
}
async function handler(req,res){
  if(!secure(req,res))return;
  const url=new URL(req.url,`http://127.0.0.1:${config.PORT}`),route=url.pathname;
  try{
    if(route==='/api/health'&&req.method==='GET')return json(res,200,{ok:true,version:config.VERSION,application:'DrawingWorkbench',appDirectory:config.APP_DIR});
    if(route==='/api/system/shutdown'&&req.method==='POST'){
      await body(req);
      json(res,200,{ok:true});setImmediate(shutdown);return;
    }
    if(route==='/api/status'&&req.method==='GET')return json(res,200,{version:config.VERSION,engine:indexer.engine(),indexing:indexer.status(),stats:store.stats(),settings:config.getSettings(),ai:ai.status(),capabilities:preview.capabilities});
    if(route==='/api/files'&&req.method==='GET')return json(res,200,store.search(Object.fromEntries(url.searchParams)));
    if(route==='/api/settings'&&req.method==='GET')return json(res,200,config.getSettings());
    if(route==='/api/rules/preview'&&req.method==='POST')return json(res,200,localRules.preview(await body(req)));
    if(route==='/api/rules/apply'&&req.method==='POST')return json(res,200,localRules.apply(await body(req)));
    if(route==='/api/settings'&&req.method==='PUT'){
      const input=await body(req),old=config.getSettings(),next=config.validateSettings(input,old);
      if(next.autoStart||next.autoStart!==old.autoStart||'autoStart' in input)await desktop.setAutoStart(next.autoStart);
      // Independent AI settings may be saved while the startup shortcut is awaiting I/O.
      next.ai=config.getSettings().ai;
      const settings=config.saveSettings(next);store.migrateGroups();store.invalidateStats();indexer.configure();return json(res,200,{ok:true,settings,reindexing:true});
    }
    if(route==='/api/ai/settings'&&req.method==='GET')return json(res,200,{settings:config.getSettings().ai,...ai.status()});
    if(route==='/api/ai/settings'&&req.method==='PUT'){
      const input=await body(req);const next=config.validateAiSettings(input,config.getSettings().ai);
      if(ai.status().busy){const error=new Error('AI 任务进行中，请完成后再修改配置。');error.status=409;throw error;}
      const credentials={};for(const key of ['apiKey','clearKey'])if(key in input)credentials[key]=input[key];
      await ai.saveCredentials(credentials);
      if(input.clearKey===true)next.enabled=false;
      if(next.enabled&&!ai.status().configured)throw new Error('请先填写并保存 DeepSeek API Key，再开启 AI。');
      config.saveSettings({ai:next});return json(res,200,{settings:config.getSettings().ai,...ai.status()});
    }
    if(route==='/api/ai/test'&&req.method==='POST'){await body(req);return json(res,200,await ai.testConnection());}
    if(route==='/api/ai/search'&&req.method==='POST'){
      const input=await body(req),scope=aiStore.normalizeScope(input.scope),settings=config.getSettings().ai,snapshots=new Map();
      const result=await ai.search(input.query,async plan=>{
        requireActiveResponse(res);
        const candidates=aiStore.candidates(plan,scope,settings.candidateLimit,settings.sendPdfText),safe=[];
        for(const candidate of candidates){
          const row=await allowedRow(candidate.id);if(!row)continue;
          let valid=true;for(const evidence of candidate.evidence||[]){const member=await allowedRow(evidence.fileId);if(!member||aiStore.stamp(member)!==evidence.sourceStamp){valid=false;break;}try{aiStore.assertDisk(member);}catch{valid=false;break;}}
          if(!valid)continue;snapshots.set(row.id,{stamp:aiStore.stamp(row),evidence:candidate.evidence||[],truncatedKeywords:candidate.truncatedKeywords||[]});safe.push(candidate);
        }
        requireActiveResponse(res);return safe;
      });
      const items=[];
      for(const match of result.matches){const row=await allowedRow(match.id),snapshot=snapshots.get(match.id);if(row&&snapshot?.stamp===aiStore.stamp(row))items.push({...store.publicFile(row),aiReason:match.reason,matchEvidence:snapshot.evidence.map(({sourceStamp,...evidence})=>evidence),evidenceTruncatedKeywords:snapshot.truncatedKeywords});}
      return json(res,200,{items,total:items.length,page:1,limit:Math.max(1,items.length),totalCandidates:result.totalCandidates,plan:result.plan,
        notice:`DeepSeek 扩展检索条件并筛选了 ${result.totalCandidates} 份本机候选；结果受名称、标签及已提取文字覆盖限制。`,usage:result.usage});
    }
    if(route==='/api/ai/classify'&&req.method==='POST'){
      const input=await body(req),settings=config.getSettings().ai;
      if(!Array.isArray(input.ids)||!input.ids.length||input.ids.length>settings.batchSize||new Set(input.ids).size!==input.ids.length)throw new Error(`每次请选择 1–${settings.batchSize} 份不同图纸。`);
      const originals=new Map(),files=[];
      for(const id of input.ids){
        let row=await allowedRow(id);if(!row)throw new Error('所选图纸已不可用或不在扫描范围内。');
        // A batch uses existing extracted text, avoiding N sequential 30s preview jobs.
        // Single-PDF extraction may wait for the local preview queue; check the connection before billing.
        if(settings.sendPdfText&&row.extension==='.pdf'&&input.ids.length===1){await preview.ensure(row.id);row=await allowedRow(id);if(!row)throw new Error('图纸在分析前已变化，请重新选择。');}
        originals.set(id,aiStore.captureSnapshot(row));files.push(aiStore.metadataForAi(row,settings.sendPdfText));
      }
      requireActiveResponse(res);
      const result=await ai.classify(files),suggestions=aiStore.saveSuggestions(result.suggestions,originals);
      return json(res,200,{suggestions,usage:result.usage,notice:'AI 建议已保存在本机，需逐条确认后才会写入分类。未分析 CAD 几何或上传原文件。'+(settings.sendPdfText&&input.ids.length>1?'批量仅使用已有 PDF 文字；尚未提取的图纸可先打开详情，或单独分析。':'')});
    }
    if(route==='/api/ai/suggestions'&&req.method==='GET')return json(res,200,{suggestions:aiStore.listSuggestions(url.searchParams.get('fileId'))});
    const aiMatch=/^\/api\/ai\/suggestions\/([a-f0-9]{24})\/(apply|dismiss)$/.exec(route);
    if(aiMatch&&req.method==='POST'){
      const suggestion=aiStore.getSuggestion(aiMatch[1]);
      if(!suggestion)return json(res,404,{error:'AI 建议不存在。'});
      const input=await body(req);
      if(aiMatch[2]==='dismiss'){aiStore.dismissSuggestion(aiMatch[1]);return json(res,200,{ok:true});}
      if(!await allowedRow(suggestion.file_id))return json(res,409,{error:'原图已不可访问或移出扫描范围，这条 AI 建议已过期。请重新分析。'});
      return json(res,200,{ok:true,file:aiStore.applySuggestion(aiMatch[1],input)});
    }
    if(route==='/api/index/scan'&&req.method==='POST'){indexer.scan('manual');return json(res,200,{ok:true});}
    if(route==='/api/backup'&&req.method==='POST'){
      const dir=path.join(config.DATA_DIR,'backups',new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(dir,{recursive:true});await store.backup(path.join(dir,'drawings.sqlite'));fs.copyFileSync(config.CONFIG_PATH,path.join(dir,'settings.json'));return json(res,200,{ok:true,path:dir});
    }
    const match=/^\/api\/files\/([^/]+)(?:\/(classify|open|locate|preview|raw))?$/.exec(route);
    if(match){
      const row=await allowedRow(match[1]);if(!row)return json(res,404,{error:'图纸不存在、暂不可访问，或已移出扫描范围。'});
      const action=match[2];
      if(!action&&req.method==='GET'){preview.queueDetails(row.id);return json(res,200,{...store.publicFile(store.getRaw(row.id),true),previewNote:row.extension==='.dwg'?'DWG 使用文件内嵌缩略图；清晰度取决于原文件。':''});}
      if(action==='classify'&&req.method==='POST')return json(res,200,{ok:true,file:store.classify(row.id,await body(req))});
      if(action==='open'&&req.method==='POST'){await desktop.openFile(row.path);return json(res,200,{ok:true});}
      if(action==='locate'&&req.method==='POST'){await desktop.locateFile(row.path);return json(res,200,{ok:true});}
      if(action==='preview'&&req.method==='GET'){const png=await preview.ensure(row.id);if(!png)return json(res,404,{error:'此图纸暂时没有可用的真实预览。'});return streamFile(req,res,png,'image/png');}
      if(action==='raw'&&['GET','HEAD'].includes(req.method)&&row.extension==='.pdf'){
        res.setHeader('X-Frame-Options','SAMEORIGIN');res.setHeader('Content-Security-Policy',"frame-ancestors 'self'; base-uri 'none'");
        return streamFile(req,res,row.path,'application/pdf');
      }
      return json(res,405,{error:'不支持此操作。'});
    }
    if(route.startsWith('/api/'))return json(res,404,{error:'接口不存在。'});
    if(!['GET','HEAD'].includes(req.method))return json(res,405,{error:'不支持此操作。'});
    const staticFiles={'/':'index.html','/index.html':'index.html','/style.css':'style.css','/app.js':'app.js'};
    const name=staticFiles[route];if(!name)return json(res,404,{error:'页面不存在。'});
    return streamFile(req,res,path.join(config.APP_DIR,'public',name),MIME[path.extname(name)]);
  }catch(e){console.error('请求失败',route,e.message);if(!res.headersSent)json(res,e.status||e.statusCode||400,{error:e.message||'操作失败，请重试。'});else res.destroy();}
}
const server=http.createServer((req,res)=>handler(req,res).catch(e=>{console.error(e);if(!res.headersSent)json(res,500,{error:'服务暂时无法完成请求。'});}));
server.requestTimeout=60000;server.headersTimeout=10000;
server.listen(config.PORT,HOST,()=>{fs.writeFileSync(path.join(config.DATA_DIR,'server.pid'),String(process.pid));console.log(`图纸工作台 V${config.VERSION} http://${HOST}:${config.PORT}`);indexer.start();if(config.getSettings().autoStart)desktop.setAutoStart(true).catch(error=>console.error('自动启动入口同步失败',error.message));});
server.on('error',e=>{console.error('服务启动失败',e.message);process.exitCode=1;indexer.stop();store.close();});
let closing=false;
function shutdown(){if(closing)return;closing=true;indexer.stop();server.close(()=>{try{store.close();}catch{}process.exit(0);});setTimeout(()=>process.exit(0),3000).unref();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
module.exports={server,allowedRow,secure};

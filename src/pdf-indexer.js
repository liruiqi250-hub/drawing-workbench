'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFile}=require('node:child_process');
const config=require('./config'),store=require('./store');
const POWERSHELL=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
function createPdfIndexer(options={}){
  const execute=options.execFile||execFile,settings=options.getSettings||config.getSettings;
  const state={running:false,processed:0,completed:0,errorCount:0,current:'',error:'',cancelled:false,capabilities:{pdfAvailable:false,ocrAvailable:false,available:false,languages:[],engine:'Windows.Media.Ocr',error:''}};
  let epoch=0,started=false,stopped=false,scheduled=false,child=null,probing=null,capabilitiesReady=false,unsubscribe=null;
  const disabled=()=>process.env.DRAWING_WORKBENCH_DISABLE_PDF_INDEX==='1';
  function terminateHandle(handle){try{
    if(process.platform==='win32'&&Number.isInteger(handle.pid))execFile(path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(handle.pid),'/T','/F'],{windowsHide:true,timeout:10000},()=>{});
    else handle.kill();
  }catch{}}
  function run(command,args,timeout,maxBuffer,tracked=true){return new Promise(resolve=>{
    let handle,treeTimer;
    try{handle=execute(command,args,{windowsHide:true,timeout,maxBuffer,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}},(error,stdout)=>{
      clearTimeout(treeTimer);
      if(child===handle)child=null;let result;try{result=JSON.parse(String(stdout||'').trim());}catch{result={status:'error',error:error?.message||'本地 PDF 进程未返回有效 JSON。'};}
      if(error&&result.status!=='error')result={status:'error',error:error.message};resolve(result);
    });if(tracked){child=handle;
      // Kill the owned tree before execFile's parent-only timeout can orphan OCR.
      treeTimer=setTimeout(()=>terminateHandle(handle),Math.max(1,timeout-1000));treeTimer.unref();
    }}catch(error){clearTimeout(treeTimer);resolve({status:'error',error:error.message});}
  });}
  async function probe(){
    if(probing)return probing;
    capabilitiesReady=false;
    probing=(async()=>{
      state.capabilities.pdfAvailable=fs.existsSync(config.PYTHON)&&fs.existsSync(path.join(config.APP_DIR,'tools','index_pdf.py'));
      if(!state.capabilities.pdfAvailable){state.capabilities.error='本地 Python 或 PDF 索引工具不可用。';return state.capabilities;}
      if(!fs.existsSync(POWERSHELL)||!fs.existsSync(path.join(config.APP_DIR,'tools','windows_ocr.ps1'))){state.capabilities.error='Windows 本地 OCR 不可用；文字型 PDF 仍可索引。';return state.capabilities;}
      const result=await run(POWERSHELL,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(config.APP_DIR,'tools','windows_ocr.ps1'),'-Probe'],30000,1024*1024,false);
      state.capabilities={pdfAvailable:true,ocrAvailable:result.available===true,available:result.available===true,languages:Array.isArray(result.languages)?result.languages:[],engine:'Windows.Media.Ocr',error:String(result.error||'')};return state.capabilities;
    })().finally(()=>{probing=null;capabilitiesReady=true;schedule();});return probing;
  }
  function status(){const pending=store.pdfPendingCount();return {...state,probing:!!probing,queued:Math.max(0,pending-(state.running?1:0)),total:state.processed+pending,capabilities:{...state.capabilities,languages:[...state.capabilities.languages]},enabled:!disabled()&&settings().pdf.indexText};}
  function schedule(){
    if(stopped||disabled()||state.cancelled||scheduled||state.running||!started||!capabilitiesReady)return;
    scheduled=true;setImmediate(()=>{scheduled=false;pump().catch(error=>{state.error=error.message;state.running=false;});});
  }
  function verifiedInput(row,snapshot){
    if(!config.isAllowed(row.path))throw new Error('PDF 已移出允许的扫描范围。');
    const realPath=fs.realpathSync(row.path);
    if(!config.isAllowed(realPath))throw new Error('PDF 真实路径位于允许范围之外，未读取或执行 OCR。');
    const stat=fs.statSync(realPath,{bigint:true}),key=stat.ino?`${path.parse(row.path).root.toLowerCase()}:${stat.dev}:${stat.ino}`:'',fresh=store.getRaw(row.id);
    if(!stat.isFile()||!fresh?.alive||fresh.path!==snapshot.path||store.contentVersion(fresh)!==snapshot.version||Number(stat.size)!==row.size||Number(stat.mtimeMs)!==Math.trunc(row.modified)||(row.file_key&&key!==row.file_key))throw new Error('PDF 磁盘内容或物理身份已变化，等待扫描或手动重建。');
    return realPath;
  }
  async function pump(){
    if(stopped||disabled()||state.cancelled||state.running||!capabilitiesReady)return;
    if(!state.capabilities.pdfAvailable){state.error=state.capabilities.error||'PDF 索引能力不可用。';return;}
    const row=store.pendingPdfs(1,!settings().pdf.indexText)[0];if(!row){state.current='';return;}
    if(store.applyPdfNamePolicy(row)){schedule();return;}
    const token=epoch,pdf=settings().pdf,snapshot={id:row.id,path:row.path,version:store.contentVersion(row)};
    state.running=true;state.current=row.name;state.error='';
    let result,inputPath,rejectedInput=false;
    try{inputPath=verifiedInput(row,snapshot);}catch(error){rejectedInput=true;result={status:'error',error:['ENOENT','ENOTDIR'].includes(error.code)?'PDF 暂不可访问或已失联，等待扫描或手动重建。':error.message};}
    if(!rejectedInput){
      const cacheDir=path.join(config.DATA_DIR,'cache');fs.mkdirSync(cacheDir,{recursive:true});
      result=await run(config.PYTHON,[path.join(config.APP_DIR,'tools','index_pdf.py'),'--input',inputPath,'--options',JSON.stringify({maxPages:pdf.maxPages,ocrMaxPages:pdf.ocrMaxPages,ocrEnabled:pdf.ocrEnabled&&state.capabilities.ocrAvailable,cacheDir})],180000,4*1024*1024);
      if(pdf.ocrEnabled&&!state.capabilities.ocrAvailable&&(result.status==='no_text'||result.pages?.some(page=>page.needsOcr))){
        result.error=[result.error,state.capabilities.error||'Windows OCR 不可用，需 OCR 的页面尚未识别。'].filter(Boolean).join('；');
        if(result.status==='ready')result.status='partial';
      }
    }
    if(token===epoch&&!stopped&&!state.cancelled){
      const accepted=rejectedInput?store.setPdfFailure(snapshot,result.error):store.setPdfResult(snapshot,result,pdf);
      if(accepted){state.processed++;state.completed++;if(result.status==='error')state.errorCount++;}
      else if(store.setPdfFailure(snapshot,'文件磁盘状态与索引不一致，等待扫描或手动重建。'))state.errorCount++;
    }
    state.running=false;state.current='';schedule();
  }
  async function start(){if(started)return status();started=true;stopped=false;store.applyPendingPdfNames();unsubscribe=store.onPdfSaved(()=>{if(!state.cancelled)schedule();});if(disabled()){state.error='PDF 后台索引已由隔离环境开关关闭。';return status();}await probe();schedule();return status();}
  // Let an in-flight Python/OCR pair exit together. Epoch rejection prevents
  // its output being stored; keeping running=true prevents a second OCR job.
  function cancel(){epoch++;state.cancelled=true;return status();}
  function stop(){
    stopped=true;epoch++;
    if(child)terminateHandle(child);
    unsubscribe?.();
  }
  async function reindex(){cancel();store.requeuePdfs();state.cancelled=false;state.processed=0;state.completed=0;state.errorCount=0;state.error='';await probe();schedule();return status();}
  async function configure(old,next){
    epoch++;
    const extract=['indexText','ocrEnabled','maxPages','ocrMaxPages'].some(key=>old.pdf[key]!==next.pdf[key]);
    if(extract)store.requeuePdfs();else if(old.pdf.skipNamedDrawings!==next.pdf.skipNamedDrawings||JSON.stringify(old.pdf.includeKeywords)!==JSON.stringify(next.pdf.includeKeywords)||JSON.stringify(old.pdf.excludeKeywords)!==JSON.stringify(next.pdf.excludeKeywords))store.rejudgePdfs();
    store.invalidateStats();state.cancelled=false;schedule();return status();
  }
  async function request(id){
    if(disabled()){const error=new Error('PDF 后台索引已由隔离环境开关关闭，未提交补提取。');error.status=503;throw error;}
    if(!started)await start();else await probe();
    if(!state.capabilities.pdfAvailable){const error=new Error(state.capabilities.error||'PDF 索引能力不可用，未提交补提取。');error.status=503;throw error;}
    // A persistent request survives settings epochs, cancellation and source changes.
    // Reject the previous in-flight output before it can clear this request.
    epoch++;store.queuePdfIndex(id);state.cancelled=false;state.error='';schedule();return status();
  }
  return {start,stop,status,probe,reindex,cancel,configure,schedule,request};
}
module.exports={...createPdfIndexer(),createPdfIndexer,POWERSHELL};

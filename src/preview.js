'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {execFile}=require('node:child_process');
const config=require('./config');
const store=require('./store');
const CACHE_DIR=path.join(config.DATA_DIR,'cache');fs.mkdirSync(CACHE_DIR,{recursive:true});
const tasks=new Map(),queue=[],attempts=new Map();let running=0;
function version(row){return store.contentVersion(row);}
function cachePath(row){return path.join(CACHE_DIR,`${row.id}-${version(row)}.png`);}
const capabilities={pdfPreview:fs.existsSync(config.PYTHON),dwgPreview:fs.existsSync('C:\\Program Files\\Common Files\\Autodesk Shared\\Thumbnail\\AcThumbnail16.dll')};
function execute(row){return new Promise(resolve=>{
  const stamp=version(row),out=cachePath(row);
  const fresh=store.getRaw(row.id);
  if(!fresh?.alive||fresh.path!==row.path||version(fresh)!==stamp||!config.isAllowed(row.path)){resolve({path:null});return;}
  try{if(!config.isAllowed(fs.realpathSync(row.path))){resolve({path:null});return;}}catch{resolve({path:null});return;}
  attempts.set(`${row.id}-${stamp}-${config.pathKey(row.path)}`,Date.now());
  execFile(config.PYTHON,[path.join(config.APP_DIR,'tools','preview_file.py'),'--input',row.path,'--output',out,'--text-limit','12000'],{windowsHide:true,timeout:30000,maxBuffer:1024*1024,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}},(error,stdout)=>{
    let result;try{result=JSON.parse(stdout.trim());}catch{result={ok:false,status:'error',preview:false,text:'',error:error?.message||'预览进程返回异常'};}
    const accepted=store.setPreview(row.id,stamp,result,row.path);resolve({result,path:accepted&&result.preview&&fs.existsSync(out)?out:null});
  });
});}
function pump(){while(running<2&&queue.length){const job=queue.shift();running++;execute(job.row).then(job.resolve,job.reject).finally(()=>{running--;tasks.delete(job.key);pump();});}}
async function ensure(id){
  const row=store.getRaw(id);if(!row||!row.alive||!config.isAllowed(row.path))return null;
  if(!['.pdf','.dwg'].includes(row.extension)){if(row.content_status==='pending')store.setPreview(id,version(row),{status:'unsupported',preview:false,text:''});return null;}
  const key=`${id}-${version(row)}-${config.pathKey(row.path)}`;
  if(row.preview_version===version(row)&&row.content_status!=='pending'){
    if(row.preview_status==='ready'&&fs.existsSync(cachePath(row)))return cachePath(row);
    if(row.content_status==='unsupported')return null;
    if(row.content_status==='error'&&Date.now()-(attempts.get(key)||0)<5000)return null;
    if(row.content_status==='no_text'&&row.preview_status!=='ready')return null;
  }
  if(!tasks.has(key)){const promise=new Promise((resolve,reject)=>queue.push({key,row,resolve,reject}));tasks.set(key,promise);pump();}
  return (await tasks.get(key))?.path||null;
}
function queueDetails(id){ensure(id).catch(e=>console.error('预览生成失败',e.message));}
module.exports={ensure,queueDetails,capabilities};

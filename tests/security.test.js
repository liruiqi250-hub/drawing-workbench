'use strict';
require('node:fs').mkdirSync(require('node:path').resolve(__dirname,'../.test-tmp'),{recursive:true});
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const net=require('node:net');
const {spawn}=require('node:child_process');
// 测试只直连本机，避免机器的 HTTP_PROXY / 全局代理限制伪 Host 负面测试。
const localAgent=new http.Agent({keepAlive:false,proxyEnv:{}});

const app=path.resolve(__dirname,'..');
const expectedVersion=require('../package.json').version;
const work=path.resolve(__dirname,'../.test-tmp');
fs.mkdirSync(work,{recursive:true});
const temporary=fs.mkdtempSync(path.join(work,'security-test-'));
const root=path.join(temporary,'已授权 中文夹');
const dataDir=path.join(temporary,'isolated-data');
const outside=path.join(temporary,'未授权夹');
fs.mkdirSync(root,{recursive:true});fs.mkdirSync(dataDir,{recursive:true});
fs.mkdirSync(outside,{recursive:true});
const originalFile=path.join(root,'权限测试.pdf');
const originalBytes=Buffer.from('%PDF-fixture-no-cad-or-real-document');
fs.writeFileSync(originalFile,originalBytes);
const junction=path.join(root,'允许范围内的子目录');
fs.mkdirSync(junction);fs.writeFileSync(path.join(junction,'边界.pdf'),'inside fixture');
const secret='OUTSIDE_ROOT_SECRET_fixture_0b94c6';
fs.writeFileSync(path.join(outside,'边界.pdf'),secret);
fs.writeFileSync(path.join(dataDir,'settings.json'),JSON.stringify({
  roots:[root],watch:false,rescanMinutes:1440,pageSize:50,
}));

let port,child,logs='',fileId,boundaryId;
const auth=()=>({'X-Requested-With':'DrawingWorkbench',Origin:`http://127.0.0.1:${port}`});
function request(route,{method='GET',headers={},body:payload}={}){
  return new Promise((resolve,reject)=>{
    const bytes=payload===undefined?null:Buffer.from(typeof payload==='string'?payload:JSON.stringify(payload));
    const req=http.request({host:'127.0.0.1',port,path:route,method,agent:localAgent,
      headers:{...(bytes?{'Content-Type':'application/json','Content-Length':bytes.length}:{}),...headers}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));
      res.on('error',reject);res.on('end',()=>{
        const text=Buffer.concat(chunks).toString('utf8');let json;
        try{json=JSON.parse(text);}catch{}
        resolve({status:res.statusCode,headers:res.headers,text,json});
      });
    });
    req.setTimeout(5000,()=>req.destroy(new Error('HTTP fixture timeout')));
    req.on('error',reject);if(bytes)req.write(bytes);req.end();
  });
}
async function freePort(){
  const listener=net.createServer();
  await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});
  const chosen=listener.address().port;
  await new Promise(resolve=>listener.close(resolve));return chosen;
}
const pause=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));

test.before(async()=>{
  port=await freePort();
  child=spawn(process.execPath,[path.join(app,'server.js')],{
    cwd:app,windowsHide:true,stdio:['ignore','pipe','pipe'],
    env:{...process.env,DRAWING_WORKBENCH_DATA:dataDir,
      DRAWING_WORKBENCH_ROOTS:JSON.stringify([root]),DRAWING_WORKBENCH_PORT:String(port)},
  });
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{logs=(logs+chunk.toString()).slice(-12000);});
  const deadline=Date.now()+12000;
  while(Date.now()<deadline){
    if(child.exitCode!==null)throw new Error(`隔离服务提前退出：${logs}`);
    try{
      const found=await request('/api/files');
      if(found.status===200&&found.json?.items?.length===2){
        fileId=found.json.items.find(row=>row.name==='权限测试.pdf')?.id;
        boundaryId=found.json.items.find(row=>row.name==='边界.pdf')?.id;
        if(fileId&&boundaryId)return;
      }
    }catch{}
    await pause(50);
  }
  throw new Error(`隔离服务或索引未就绪：${logs}`);
});
test.after(async()=>{
  localAgent.destroy();
  if(child&&child.exitCode===null){
    const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');
    let timer;
    try{await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(resolve,4000);})]);}
    finally{clearTimeout(timer);}
    if(child.exitCode===null){child.kill('SIGKILL');await exited;}
  }
  fs.rmSync(temporary,{recursive:true,force:true});
});

test('本机健康检查正常，外部 Host 和错误端口被拒绝',async()=>{
  assert.equal((await request('/api/health')).status,200);
  for(const host of ['attacker.example',`127.0.0.1.attacker.example:${port}`,`127.0.0.1:${port+1}`]){
    assert.equal((await request('/api/health',{headers:{Host:host}})).status,403,host);
  }
  const local=await request('/api/health',{headers:{Host:`localhost:${port}`}});
  assert.equal(local.status,200);assert.equal(local.json.version,expectedVersion);
});

test('外站 Origin、null Origin、cross-site 及缺少请求标记的写入均被阻止',async()=>{
  const route=`/api/files/${fileId}/classify`;
  const cases=[
    {...auth(),Origin:'https://attacker.example'},
    {...auth(),Origin:'null'},
    {...auth(),'Sec-Fetch-Site':'cross-site'},
    {Origin:`http://127.0.0.1:${port}`},
    {},
  ];
  for(const headers of cases){
    const response=await request(route,{method:'POST',headers,body:{project:'不应保存'}});
    assert.equal(response.status,403,JSON.stringify(headers));
  }
  const files=await request('/api/files');
  assert.equal(files.json.items.find(row=>row.id===fileId).project,'');
  const valid=await request(route,{method:'POST',headers:auth(),body:{project:'本机测试项目',type:'fixture'}});
  assert.equal(valid.status,200);assert.equal(valid.json.file.project,'本机测试项目');
  assert.deepEqual(fs.readFileSync(originalFile),originalBytes);
});

test('未索引 id 与路径注入不能读取、定位或打开任意文件',async()=>{
  const missing='0123456789abcdef01234567';
  for(const action of ['', '/raw','/preview']){
    const response=await request(`/api/files/${missing}${action}?path=${encodeURIComponent(path.join(outside,'边界.pdf'))}`);
    assert.equal(response.status,404);assert.ok(!response.text.includes(secret));
  }
  for(const action of ['open','locate','classify']){
    const response=await request(`/api/files/${missing}/${action}`,{
      method:'POST',headers:auth(),body:{path:path.join(outside,'边界.pdf'),project:'未知图纸'},
    });
    assert.equal(response.status,404);
  }
  for(const id of ['..%2F..%2Fsrc%2Fconfig.js',"x%27%20OR%201%3D1--",'not-an-indexed-id']){
    assert.equal((await request(`/api/files/${id}/raw`)).status,404);
  }
});

test('静态路径穿越、数据库和辅助脚本不作为网页公开',async()=>{
  for(const route of ['/../src/config.js','/%2e%2e/src/config.js','/..%2fsrc%2fconfig.js',
    '/src/config.js','/data/settings.json','/data/drawings.sqlite','/tools/preview_file.py']){
    const response=await request(route);assert.equal(response.status,404,route);
    assert.ok(!response.text.includes(secret));
  }
});

test('已索引路径后来变成跨范围目录联接时不能读取外部内容',async()=>{
  fs.unlinkSync(path.join(junction,'边界.pdf'));fs.rmdirSync(junction);
  fs.symlinkSync(outside,junction,'junction');
  const response=await request(`/api/files/${boundaryId}/raw`);
  assert.equal(response.status,404);assert.ok(!response.text.includes(secret));
});

test('无效 JSON、数组、null 与超过 64KB 的设置请求不改变配置',async()=>{
  const baseline=(await request('/api/settings')).json;
  for(const payload of ['{broken json','[]','null']){
    const response=await request('/api/settings',{method:'PUT',headers:auth(),body:payload});
    assert.equal(response.status,400);
  }
  const oversized=await request('/api/settings',{method:'PUT',headers:auth(),
    body:{pageSize:61,padding:'x'.repeat(70*1024)}});
  assert.equal(oversized.status,413);
  const after=(await request('/api/settings')).json;
  assert.equal(after.pageSize,baseline.pageSize);
  assert.deepEqual(after.roots,baseline.roots);assert.equal(after.ai.enabled,false);
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const app=path.resolve(__dirname,'..'),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'drawing-startup-'));
test.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
function environment(name){const root=path.join(temporary,name);fs.mkdirSync(root);return {...process.env,DRAWING_WORKBENCH_DATA:path.join(root,'data'),DRAWING_WORKBENCH_ROOTS:JSON.stringify([root]),DRAWING_WORKBENCH_STARTUP:path.join(root,'Startup'),DRAWING_WORKBENCH_PORT:'17897',DRAWING_WORKBENCH_HEADLESS:'1'};}
function writeConfig(env,value){fs.mkdirSync(env.DRAWING_WORKBENCH_DATA,{recursive:true});fs.writeFileSync(path.join(env.DRAWING_WORKBENCH_DATA,'settings.json'),typeof value==='string'?value:JSON.stringify(value));}
function node(script,env){return spawnSync(process.execPath,script,{cwd:app,env,encoding:'utf8',windowsHide:true,timeout:15000});}

test('配置损坏时日志先于配置解析创建，包含真实可恢复错误',()=>{
  const env=environment('broken-log');writeConfig(env,'{"broken":');
  const result=node(['tools/run-server.js'],env);
  assert.equal(result.status,1);
  const log=fs.readFileSync(path.join(env.DRAWING_WORKBENCH_DATA,'logs','server.error.log'),'utf8');
  assert.match(log,/启动尝试/);assert.match(log,/设置文件无法读取/);assert.match(log,/原文件未改动/);
  assert.equal(fs.readFileSync(path.join(env.DRAWING_WORKBENCH_DATA,'settings.json'),'utf8'),'{"broken":');
});

test('隐藏启动失败的错误包含已建立日志中的配置损坏原因',{skip:process.platform!=='win32'||!fs.existsSync(path.join(app,'runtime','node','node.exe'))},()=>{
  const env=environment('broken-launch');writeConfig(env,'{"broken":');
  const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(app,'启动图纸工作台.ps1'),'-BackgroundOnly'],{cwd:app,env,encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(result.status,1);
  assert.match(result.stdout+result.stderr,/设置文件无法读取/);
  assert.ok(fs.existsSync(path.join(env.DRAWING_WORKBENCH_DATA,'logs','server.error.log')));
});

test('新目录安装同步已启用的真实Startup快捷方式；再次同步仍修正旧目标',{skip:process.platform!=='win32'},()=>{
  const env=environment('startup-link');writeConfig(env,{roots:JSON.parse(env.DRAWING_WORKBENCH_ROOTS),watch:false,autoStart:true});
  const result=node(['scripts/sync-startup.js'],env);assert.equal(result.status,0,result.stderr);
  const shortcut=path.join(env.DRAWING_WORKBENCH_STARTUP,'图纸工作台.lnk');assert.ok(fs.existsSync(shortcut));
  const readScript=`$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${shortcut.replace(/'/g,"''")}');[Console]::OutputEncoding=[Text.Encoding]::UTF8;$s.Arguments | ConvertTo-Json -Compress`;
  function read(){const r=spawnSync('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(readScript,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout.replace(/^\uFEFF/,''));}
  assert.ok(read().includes(path.join(app,'启动图纸工作台.ps1')));
  const replace=readScript.split(';[Console]')[0]+";$s.Arguments='old-directory';$s.Save()";
  spawnSync('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(replace,'utf16le').toString('base64')],{windowsHide:true});
  assert.equal(node(['scripts/sync-startup.js'],env).status,0);assert.ok(read().includes(path.join(app,'启动图纸工作台.ps1')));
});

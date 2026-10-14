'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const {createBackend} = require('../desktop/backend.cjs');
const policy = require('../desktop/policy.cjs');
const root = path.resolve(__dirname,'..');
const data = path.join(root,'.test-tmp','desktop-fixture');
const origin = 'http://127.0.0.1:18963';
const id = 'a'.repeat(24);
const health = overrides => ({ok:true,application:'DrawingWorkbench',version:'0.6.0',appDirectory:root,dataDirectory:data,...overrides});
function fixture(overrides = {}) {
  let running = health(), calls = [], spawnOptions;
  const child = new EventEmitter(); child.exitCode = null;
  const request = async (route, method = 'GET') => {
    calls.push([route,method]);
    if (overrides.request) return overrides.request(route,method);
    if (route === '/api/health') { if (running) return running; const error = new Error('refused'); error.code = 'ECONNREFUSED'; throw error; }
    if (route === '/api/status') return {ai:{busy:false}};
    if (route === '/api/backup') return {ok:true};
    if (route === '/api/system/shutdown') { running = null; child.exitCode = 0; child.emit('exit',0); return {ok:true}; }
    if (route === `/api/files/${id}?pdfMode=all`) return {id,exists:true,path:path.join(data,'verified.pdf')};
    throw new Error('Unexpected route '+route);
  };
  const backend = createBackend({root,data,port:18963,version:'0.6.0',onUnexpectedExit:overrides.onUnexpectedExit}, {
    request, sleep:async () => {}, exists:overrides.exists || (() => true),
    spawn:(executable,args,options) => { calls.push(['spawn',executable,args]); spawnOptions = options; running = health(); overrides.spawn?.(child); return child; }
  });
  return {backend,calls,child,setRunning:value => {running=value;},get spawnOptions(){return spawnOptions;}};
}
test('桌面后台：匹配服务重用，退出先备份再正常关闭',async () => {
  const f = fixture(); assert.equal(await f.backend.start(),origin);
  assert.equal(f.calls.some(call=>call[0]==='spawn'),false);
  await f.backend.stop();
  assert.deepEqual(f.calls.filter(call=>call[1]==='POST').map(call=>call[0]),['/api/backup','/api/system/shutdown']);
});
test('桌面后台：空闲同数据旧版本先备份退出，再隐藏启动随包 Node',async () => {
  const f=fixture();f.setRunning(health({version:'0.5.5'}));await f.backend.start();
  const events=f.calls.map(call=>call[0]);assert.ok(events.indexOf('/api/backup')<events.indexOf('/api/system/shutdown'));assert.ok(events.indexOf('/api/system/shutdown')<events.indexOf('spawn'));
  assert.equal(f.spawnOptions.windowsHide,true);assert.equal(f.spawnOptions.cwd,root);assert.equal(f.spawnOptions.env.DRAWING_WORKBENCH_DATA,data);
  assert.equal(f.calls.find(call=>call[0]==='spawn')[1],path.join(root,'runtime','node','node.exe'));
  await f.backend.stop();
});
for(const [name,bad] of [['其他应用',{application:'Other'}],['其他数据',{dataDirectory:path.join(data,'other')}],['缺少数据身份',{dataDirectory:undefined}],['相同版本其他安装',{appDirectory:path.join(root,'other')}],['旧版本其他安装',{version:'0.5.5',appDirectory:path.join(root,'other')}]]) {
  test(`桌面后台：${name}不能备份或关闭`,async()=>{const f=fixture();f.setRunning(health(bad));await assert.rejects(f.backend.start(),/保留/);assert.equal(f.calls.some(call=>call[1]==='POST'),false);});
}
test('桌面后台：旧版本 AI 忙或任务状态缺失不能关闭',async()=>{
  for(const status of [{ai:{busy:true}},{}]) {
    const calls=[];const f=fixture({request:async(route,method)=>{calls.push([route,method]);return route==='/api/health'?health({version:'0.5.5'}):status;}});
    await assert.rejects(f.backend.start(),/AI|状态/);assert.equal(calls.some(call=>call[1]==='POST'),false);
  }
});
test('桌面后台：备份失败与备份后身份变化都不发 shutdown',async()=>{
  for(const changed of [false,true]) {
    let probes=0;const posts=[];
    const f=fixture({request:async(route,method)=>{if(method==='POST')posts.push(route);if(route==='/api/health')return health({version:'0.5.5',...(changed&&++probes>=3?{application:'Other'}:{})});if(route==='/api/status')return {ai:{busy:false}};if(route==='/api/backup')return {ok:changed};}});
    await assert.rejects(f.backend.start(),/备份|身份/);assert.deepEqual(posts,['/api/backup']);
  }
});
test('桌面后台：备份期间新 AI 任务开始或状态缺失时不关闭',async()=>{
  for(const after of [{ai:{busy:true}},{}]) {
    const posts=[];let statuses=0;
    const f=fixture({request:async(route,method)=>{if(method==='POST')posts.push(route);if(route==='/api/health')return health({version:'0.5.5'});if(route==='/api/status')return ++statuses===1?{ai:{busy:false}}:after;if(route==='/api/backup')return {ok:true};}});
    await assert.rejects(f.backend.start(),/AI|任务状态/);assert.deepEqual(posts,['/api/backup']);
  }
});
test('桌面后台：无响应或无效服务不被当作空闲端口',async()=>{
  const f=fixture({request:async()=>{throw new Error('timeout');}});await assert.rejects(f.backend.start(),/无法确认身份/);assert.equal(f.calls.some(call=>call[0]==='spawn'),false);
});
test('桌面后台：缺失组件、进程错误与启动超时有中文诊断',async()=>{
  const missing=fixture({exists:()=>false});missing.setRunning(null);await assert.rejects(missing.backend.start(),/运行组件缺失/);
  const failed=fixture({spawn:child=>queueMicrotask(()=>child.emit('error',new Error('bad path')))});failed.setRunning(null);await assert.rejects(failed.backend.start(),/启动失败/);
  const timeout=fixture({request:async()=>{const e=new Error();e.code='ECONNREFUSED';throw e;}});await assert.rejects(timeout.backend.start(),/启动超时/);await assert.rejects(timeout.backend.stop(),/尚未响应/);
});
test('桌面后台：退出前身份变化不能关闭；AI 忙保持可重试',async()=>{
  const f=fixture();await f.backend.start();f.setRunning(health({dataDirectory:path.join(data,'other')}));await assert.rejects(f.backend.stop(),/身份无法核实/);assert.equal(f.calls.some(call=>call[1]==='POST'),false);
  const g=fixture({request:async(route)=>route==='/api/health'?health():route==='/api/status'?{ai:{busy:true}}:{ok:true}});await g.backend.start();await assert.rejects(g.backend.stop(),/正在进行/);
});
test('桌面后台：意外退出通知界面；启动超时重试不重复派生进程',async()=>{
  let notification='';const f=fixture({onUnexpectedExit:message=>{notification=message;}});f.setRunning(null);await f.backend.start();f.child.emit('exit',1);assert.match(notification,/后台已停止/);
  const g=fixture({request:async()=>{const error=new Error();error.code='ECONNREFUSED';throw error;}});await assert.rejects(g.backend.start(),/启动超时/);await assert.rejects(g.backend.start(),/上一后台/);assert.equal(g.calls.filter(call=>call[0]==='spawn').length,1);
});
test('桌面原生定位只接受编号并使用后端验证结果，不接受渲染器路径',async()=>{
  const f=fixture();await f.backend.start();let located=null;
  const result=await f.backend.locate(id,p=>{located=p;});assert.equal(located,path.join(data,'verified.pdf'));assert.equal(result.message,'已请求资源管理器定位');
  for(const invalid of ['../../x',path.join(data,'any.pdf'),{path:'anything'},'A'.repeat(24)])await assert.rejects(f.backend.locate(invalid,()=>assert.fail()),/编号/);
});
test('桌面原生定位拒绝缺失、错误编号、相对路径和后端错误',async()=>{
  for(const file of [{id,exists:false,path:data},{id:'b'.repeat(24),exists:true,path:data},{id,exists:true,path:'relative.pdf'},{}]) {
    const f=fixture({request:async route=>route==='/api/health'?health():file});await f.backend.start();await assert.rejects(f.backend.locate(id,()=>assert.fail()),/不可访问/);
  }
});
test('导航策略限制精确 origin、主页与 PDF 白名单',()=>{
  assert.equal(policy.mainUrl(origin+'/',origin),true);assert.equal(policy.mainUrl(origin+'/index.html',origin),true);
  for(const url of [origin+'.evil/','http://localhost:18963/',origin+'/api/status',origin+'/?x=1','file:///anything','https://example.com/'])assert.equal(policy.mainUrl(url,origin),false);
  assert.equal(policy.pdfUrl(origin+`/api/files/${id}/raw#page=12`,origin),true);
  for(const suffix of ['/raw?x=1','/locate','/raw#javascript:1','/raw#page=0'])assert.equal(policy.pdfUrl(origin+`/api/files/${id}`+suffix,origin),false);
  assert.equal(policy.pdfUrl(`https://example.com/api/files/${id}/raw`,origin),false);
});
test('IPC 必须来自已登记窗口主 frame；PDF 安全首选项没有 preload',()=>{
  const frame={url:origin+'/'};const contents={mainFrame:frame};const win={webContents:contents,isDestroyed:()=>false};const event={sender:contents,senderFrame:frame};
  assert.equal(policy.trustedSender(event,win,url=>policy.mainUrl(url,origin)),true);
  for(const bad of [{...event,sender:{}},{...event,senderFrame:{url:origin+'/'}},{...event,senderFrame:{url:'file:///startup.html'}}])assert.equal(policy.trustedSender(bad,win,()=>true),false);
  assert.deepEqual(policy.webPreferences(),{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false});
});

async function mainFixture({lock=true,trayFails=false,stopError=false,pdfLoadFailure=false}={}) {
  const app=new EventEmitter();app.isPackaged=false;app.requestSingleInstanceLock=()=>lock;app.getPath=()=>data;app.whenReady=()=>Promise.resolve();app.quit=()=>{app.quits=(app.quits||0)+1;};
  const windows=[],dialogs=[],logs=[];const handlers=new Map();const backend={origin,start:async()=>origin,stop:async()=>{backend.stops=(backend.stops||0)+1;if(stopError)throw new Error('AI 任务正在进行');},locate:async()=>({ok:true})};
  class Window extends EventEmitter {
    constructor(options){super();this.options=options;this.webContents=new EventEmitter();this.webContents.mainFrame={url:''};this.webContents.setWindowOpenHandler=fn=>{this.openHandler=fn;};this.webContents.isDestroyed=()=>false;windows.push(this);}
    isDestroyed(){return false;}isMinimized(){return true;}restore(){this.restored=true;}show(){this.shown=true;}focus(){this.focused=true;}hide(){this.hidden=true;}
    async loadURL(url){if(pdfLoadFailure&&url.includes('/raw')){const error=new Error('PRIVATE_PATH_must_not_be_logged');error.code='ERR_CONNECTION_REFUSED';throw error;}this.webContents.mainFrame.url=url;}async loadFile(file){this.webContents.mainFrame.url=require('node:url').pathToFileURL(file).href;}close(){this.closed=true;}
  }
  class Tray extends EventEmitter {constructor(){super();if(trayFails)throw new Error();}setToolTip(){}setContextMenu(menu){this.menu=menu;}destroy(){this.destroyed=true;}}
  const sessionObject=new EventEmitter();sessionObject.setPermissionRequestHandler=fn=>{sessionObject.request=fn;};sessionObject.setPermissionCheckHandler=fn=>{sessionObject.check=fn;};
  const electron={app,BrowserWindow:Window,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},Tray,Menu:{buildFromTemplate:value=>value},nativeImage:{createFromPath:()=>({isEmpty:()=>false}),createFromDataURL:()=>({isEmpty:()=>false})},shell:{showItemInFolder:()=>{}},session:{defaultSession:sessionObject},dialog:{showMessageBox:async(_window,options)=>{dialogs.push(options);}}};
  const filename=path.join(root,'desktop','main.cjs');const source=fs.readFileSync(filename,'utf8');
  vm.runInNewContext(source,{require:name=>name==='electron'?electron:name==='./backend.cjs'?{createBackend:()=>backend}:name==='./policy.cjs'?policy:name==='./desktop-version.json'?{version:'0.6.0'}:name==='node:fs'?{existsSync:()=>false,mkdirSync:()=>{},appendFileSync:(_file,text)=>{logs.push(text);}}:require(name),__dirname:path.dirname(filename),process:{env:{DRAWING_WORKBENCH_DATA:data,LOCALAPPDATA:data},resourcesPath:data},URL,console});
  await new Promise(resolve=>setImmediate(resolve));
  return {app,windows,handlers,backend,sessionObject,dialogs,logs};
}
test('桌面主入口：第二实例不启动服务；恢复现有窗口并关闭到托盘',async()=>{
  const second=await mainFixture({lock:false});assert.equal(second.windows.length,0);assert.equal(second.app.quits,1);
  const f=await mainFixture();const win=f.windows[0];f.app.emit('second-instance');assert.equal(win.restored,true);assert.equal(win.focused,true);
  let prevented=false;win.emit('close',{preventDefault:()=>{prevented=true;}});assert.equal(prevented,true);assert.equal(win.hidden,true);assert.equal(f.backend.stops,undefined);
  const event={sender:win.webContents,senderFrame:win.webContents.mainFrame};await f.handlers.get('drawing:locate')(event,id);
  assert.equal((await f.handlers.get('drawing:locate')({...event,sender:{}},id)).ok,false);
});
test('桌面主入口：托盘失败关闭真实退出；退出失败显示可重试错误',async()=>{
  const f=await mainFixture({trayFails:true});f.windows[0].emit('close',{preventDefault(){}});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.backend.stops,1);assert.equal(f.app.quits,1);
  const busy=await mainFixture({trayFails:true,stopError:true});busy.windows[0].emit('close',{preventDefault(){}});await new Promise(resolve=>setImmediate(resolve));assert.equal(busy.app.quits,undefined);assert.match(busy.windows[0].webContents.mainFrame.url,/startup.html$/);assert.equal(busy.windows[0].shown,true);
});
test('桌面主入口：PDF 子窗口不带 preload，拒绝权限和不可信窗口',async()=>{
  const f=await mainFixture();const win=f.windows[0];assert.equal(win.options.frame,undefined);assert.equal(win.options.width,1440);assert.equal(win.options.minWidth,1200);
  assert.equal(win.openHandler({url:'https://example.com/'}).action,'deny');assert.equal(f.windows.length,1);
  assert.equal(win.openHandler({url:origin+`/api/files/${id}/raw#page=1`}).action,'deny');assert.equal(f.windows.length,2);
  assert.equal('preload' in f.windows[1].options.webPreferences,false);assert.equal(f.windows[1].options.webPreferences.sandbox,true);
  let allowed=true;f.sessionObject.request(null,'camera',value=>{allowed=value;});assert.equal(allowed,false);assert.equal(f.sessionObject.check(),false);
  let prevented=false;win.webContents.emit('will-navigate',{preventDefault:()=>{prevented=true;}},'file:///unsafe.html');assert.equal(prevented,true);
});
test('桌面启动桥接只允许精确本地启动页主 frame',async()=>{
  const f=await mainFixture();const win=f.windows[0];const event={sender:win.webContents,senderFrame:win.webContents.mainFrame};
  assert.equal(f.handlers.get('drawing:startup-state')(event),null);assert.equal(f.handlers.get('drawing:startup-retry')(event),false);assert.equal(f.handlers.get('drawing:startup-quit')(event),false);
  await win.loadFile(path.join(root,'desktop','startup.html'));assert.equal(typeof f.handlers.get('drawing:startup-state')(event).busy,'boolean');
  assert.equal(f.handlers.get('drawing:startup-state')({...event,senderFrame:{url:event.senderFrame.url}}),null);
});
test('PDF 真实加载失败有中文提示，只记录安全错误代码；成功不弹错误',async()=>{
  for(const failure of [false,true]) {
    const f=await mainFixture({pdfLoadFailure:failure});f.windows[0].openHandler({url:origin+`/api/files/${id}/raw`});await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.dialogs.length,failure?1:0);
    if(failure){assert.match(f.dialogs[0].message,/PDF 暂时无法显示/);assert.equal(f.windows[1].closed,true);assert.match(f.logs.join(''),/ERR_CONNECTION_REFUSED/);assert.equal(JSON.stringify(f.dialogs).includes('PRIVATE_PATH'),false);assert.equal(f.logs.join('').includes('PRIVATE_PATH'),false);}
  }
});

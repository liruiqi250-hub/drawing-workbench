'use strict';
const {app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, session, dialog} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {createBackend} = require('./backend.cjs');
const policy = require('./policy.cjs');
const {version} = require('./desktop-version.json');

// This lock is acquired before opening windows or starting the local backend.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let window = null, tray = null, backend = null, quitting = false, quitPending = false;
  let startup = {busy:true, error:false, message:'正在启动本地图纸服务…'};
  const startupFile = path.join(__dirname, 'startup.html');
  const startupUrl = pathToFileURL(startupFile).href;
  const root = app.isPackaged ? path.join(process.resourcesPath, 'backend') : path.resolve(__dirname, '..');
  const data = path.resolve(process.env.DRAWING_WORKBENCH_DATA || path.join(process.env.LOCALAPPDATA || app.getPath('home'), 'DrawingWorkbench', 'data'));
  function log(message) {
    try { const directory = path.join(data, 'logs'); fs.mkdirSync(directory, {recursive:true}); fs.appendFileSync(path.join(directory,'desktop.log'), `${new Date().toISOString()} ${message}\n`); } catch {}
  }
  function restore() {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
  }
  function validStartup(event) { return policy.trustedSender(event, window, url => url === startupUrl); }
  function validWorkbench(event) { return policy.trustedSender(event, window, url => policy.mainUrl(url, backend.origin)); }
  async function showError(message) {
    startup = {busy:false, error:true, message}; log(message);
    if (window && !window.isDestroyed()) { await window.loadFile(startupFile); restore(); }
  }
  async function start() {
    if (startup.busy && backendStarting) return;
    startup = {busy:true, error:false, message:'正在检查本地后台与数据目录…'};
    backendStarting = true;
    try { const origin = await backend.start(); await window.loadURL(origin + '/'); }
    catch (error) { await showError(error.message || '启动失败，请重试或重新安装软件。'); }
    finally { backendStarting = false; startup.busy = false; }
  }
  let backendStarting = false;
  async function quit() {
    if (quitting || quitPending) return;
    quitPending = true;
    try {
      await backend?.stop();
      quitting = true;
      if (tray) { tray.destroy(); tray = null; }
      app.quit();
    } catch (error) { await showError(error.message || '后台尚未正常退出，请稍后重试。'); }
    finally { quitPending = false; }
  }
  function restrict(contents, allowed) {
    contents.on('will-navigate', (event, url) => { if (!allowed(url)) event.preventDefault(); });
    contents.on('will-redirect', (event, url) => { if (!allowed(url)) event.preventDefault(); });
    contents.on('will-attach-webview', event => event.preventDefault());
  }
  function openPdf(url) {
    const pdf = new BrowserWindow({width:1100, height:850, minWidth:700, minHeight:500, parent:window, title:'图纸工作台 · PDF', autoHideMenuBar:true, webPreferences:policy.webPreferences()});
    restrict(pdf.webContents, value => policy.pdfUrl(value, backend.origin));
    pdf.webContents.setWindowOpenHandler(() => ({action:'deny'}));
    pdf.loadURL(url).catch(async error => {
      if (pdf.isDestroyed()) return;
      const code = /^ERR_[A-Z_]+$/.test(error?.code || '') ? error.code : 'UNKNOWN';
      log(`PDF 载入失败 code=${code}`);
      try {
        await dialog.showMessageBox(pdf, {type:'error', title:'图纸工作台 · PDF', message:'PDF 暂时无法显示', detail:'请关闭提示后重新打开。若仍失败，请确认原图仍可访问，并重试图纸工作台。', buttons:['关闭提示'], defaultId:0, noLink:true});
      } finally { if (!pdf.isDestroyed()) pdf.close(); }
    }).catch(() => { if (!pdf.isDestroyed()) pdf.close(); });
  }
  app.on('second-instance', restore);
  app.on('activate', restore);
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void quit(); } });
  app.on('window-all-closed', () => { if (!quitting && !tray) void quit(); });
  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on('will-download', event => event.preventDefault());
    const iconFile = path.join(__dirname,'build-assets','app.ico');
    window = new BrowserWindow({width:1440, height:960, minWidth:1200, minHeight:800, title:`图纸工作台 V${version}`, backgroundColor:'#101b28', autoHideMenuBar:true, ...(fs.existsSync(iconFile) ? {icon:iconFile} : {}), webPreferences:policy.webPreferences(path.join(__dirname,'preload.cjs'))});
    backend = createBackend({root, data, port:process.env.DRAWING_WORKBENCH_PORT || 17863, version, onUnexpectedExit:message => { void showError(message); }});
    restrict(window.webContents, url => url === startupUrl || policy.mainUrl(url, backend.origin));
    window.webContents.setWindowOpenHandler(({url}) => { if (policy.pdfUrl(url, backend.origin)) openPdf(url); return {action:'deny'}; });
    window.webContents.on('render-process-gone', () => { void showError('界面意外停止，后台数据仍保留。请点击重试重新打开。'); });
    window.on('close', event => { if (quitting) return; event.preventDefault(); if (tray) window.hide(); else void quit(); });
    window.on('closed', () => { window = null; });
    try {
      const png = path.join(__dirname,'build-assets','app.png');
      const icon = fs.existsSync(iconFile) ? nativeImage.createFromPath(iconFile) : fs.existsSync(png) ? nativeImage.createFromPath(png) : nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==');
      if (icon.isEmpty()) throw new Error('icon');
      tray = new Tray(icon);
      tray.setToolTip(`图纸工作台 V${version} · 关闭窗口后继续索引`);
      tray.setContextMenu(Menu.buildFromTemplate([{label:'显示图纸工作台', click:restore}, {type:'separator'}, {label:'退出程序', click:() => { void quit(); }}]));
      tray.on('double-click', restore); tray.on('click', restore);
    } catch { if (tray) tray.destroy(); tray = null; log('托盘不可用，关闭窗口将正常退出程序。'); }
    ipcMain.handle('drawing:locate', async (event, id) => {
      if (!validWorkbench(event)) return {ok:false, message:'已阻止来自非主界面的定位请求。'};
      try { return await backend.locate(id, target => shell.showItemInFolder(target)); }
      catch (error) { return {ok:false, message:error.message || '定位失败，请重试。'}; }
    });
    ipcMain.handle('drawing:startup-state', event => validStartup(event) ? {...startup} : null);
    ipcMain.handle('drawing:startup-retry', event => { if (!validStartup(event)) return false; void start(); return true; });
    ipcMain.handle('drawing:startup-quit', event => { if (!validStartup(event)) return false; void quit(); return true; });
    await window.loadFile(startupFile);
    await start();
  }).catch(error => { log('桌面初始化失败。'); if (window && !window.isDestroyed()) void showError('桌面初始化失败，请重新安装完整安装包。'); else { quitting = true; app.quit(); } });
}

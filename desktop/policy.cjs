'use strict';
const MAIN_PATHS = new Set(['/', '/index.html']);
function mainUrl(value, origin) {
  try { const url = new URL(value); return url.origin === origin && !url.username && !url.password && MAIN_PATHS.has(url.pathname) && !url.search; } catch { return false; }
}
function pdfUrl(value, origin) {
  try { const url = new URL(value); return url.origin === origin && !url.username && !url.password && /^\/api\/files\/[a-f0-9]{24}\/raw$/.test(url.pathname) && !url.search && (!url.hash || /^#page=[1-9]\d*$/.test(url.hash)); } catch { return false; }
}
function trustedSender(event, window, predicate) {
  return !!window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && predicate(event.senderFrame.url);
}
function webPreferences(preload) {
  return {nodeIntegration:false, contextIsolation:true, sandbox:true, webSecurity:true, allowRunningInsecureContent:false, webviewTag:false, ...(preload ? {preload} : {})};
}
module.exports = {mainUrl, pdfUrl, trustedSender, webPreferences};

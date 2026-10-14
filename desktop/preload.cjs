'use strict';
const {contextBridge, ipcRenderer} = require('electron');
// Each request is independently checked against the registered main frame.
if (location.protocol === 'http:') {
  contextBridge.exposeInMainWorld('drawingDesktop', Object.freeze({
    locateFile(id) {
      if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)) return Promise.reject(new Error('图纸编号无效。'));
      return ipcRenderer.invoke('drawing:locate', id).then(result => { if (!result.ok) throw new Error(result.message); return result; });
    }
  }));
} else if (location.protocol === 'file:' && location.pathname.endsWith('/startup.html')) {
  contextBridge.exposeInMainWorld('drawingStartup', Object.freeze({
    state: () => ipcRenderer.invoke('drawing:startup-state'),
    retry: () => ipcRenderer.invoke('drawing:startup-retry'),
    quit: () => ipcRenderer.invoke('drawing:startup-quit')
  }));
}

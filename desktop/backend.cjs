'use strict';
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const {spawn} = require('node:child_process');
// NODE_USE_ENV_PROXY may be enabled on the host; local service IPC never uses a proxy.
const localAgent = new http.Agent({keepAlive:false, proxyEnv:{}});

function requestJson(origin, route, method = 'GET') {
  return new Promise((resolve, reject) => {
    const base = new URL(origin), target = new URL(route, base);
    if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password || target.origin !== base.origin || !route.startsWith('/')) throw new Error('仅允许连接本机图纸服务。');
    const req = http.request(target, {method, agent:localAgent, headers: {'X-Requested-With': 'DrawingWorkbench', ...(method === 'POST' ? {'Content-Type':'application/json'} : {})}}, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; if (data.length > 2 * 1024 * 1024) req.destroy(new Error('响应内容过大。')); });
      res.on('end', () => {
        try {
          const value = JSON.parse(data);
          if (res.statusCode !== 200) {
            const message = route === '/api/system/shutdown' && res.statusCode === 409 ? 'AI 任务正在进行，请等任务完成后再退出或升级。' : res.statusCode === 503 ? '后台正在退出，请稍后重试。' : '后台服务未返回有效响应。';
            reject(new Error(message)); return;
          }
          resolve(value);
        } catch { reject(new Error('后台服务未返回有效响应。')); }
      });
      res.on('error', reject);
    });
    const timeout = method === 'POST' && ['/api/backup', '/api/system/shutdown'].includes(route) ? 30000 : 1800;
    req.setTimeout(timeout, () => req.destroy(new Error('后台服务响应超时。')));
    req.on('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

function createBackend(options, dependencies = {}) {
  const root = path.resolve(options.root);
  const data = path.resolve(options.data);
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('后台端口设置无效。');
  const origin = `http://127.0.0.1:${port}`;
  const request = dependencies.request || ((route, method) => requestJson(origin, route, method));
  const launch = dependencies.spawn || spawn;
  const sleep = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const exists = dependencies.exists || fs.existsSync;
  const normalize = value => typeof value === 'string' ? path.resolve(value).toLowerCase() : '';
  const sameData = value => value?.ok === true && value.application === 'DrawingWorkbench' && normalize(value.dataDirectory) === normalize(data);
  const matches = value => sameData(value) && value.version === options.version && normalize(value.appDirectory) === normalize(root);
  let child = null, childEnded = true, active = false, starting = null;
  async function probe() {
    try { return await request('/api/health'); }
    catch (error) { if (error.code === 'ECONNREFUSED') return null; throw new Error('本机端口已有服务或无法确认身份，请检查后台服务后重试。'); }
  }
  async function waitGone() {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (!await probe()) return;
      await sleep(200);
    }
    throw new Error('旧后台尚未正常退出，已停止启动。请稍后重试。');
  }
  async function stopVerified(expected) {
    const status = await request('/api/status');
    if (!status?.ai || typeof status.ai.busy !== 'boolean') throw new Error('无法确认 AI 任务状态，已保留后台服务。');
    if (status.ai.busy) throw new Error('AI 任务正在进行，请等任务完成后再退出或升级。');
    const latest = await probe();
    if (!expected(latest)) throw new Error('后台身份已变化，已保留该服务。');
    const backup = await request('/api/backup', 'POST');
    if (backup?.ok !== true) throw new Error('后台备份未成功，已保留该服务。');
    const afterBackup = await request('/api/status');
    if (!afterBackup?.ai || typeof afterBackup.ai.busy !== 'boolean') throw new Error('无法确认 AI 任务状态，已保留后台服务。');
    if (afterBackup.ai.busy) throw new Error('备份期间开始了 AI 任务，请等任务完成后再退出或升级。');
    // Recheck after backup: never send shutdown after another service replaces it.
    if (!expected(await probe())) throw new Error('后台身份已变化，已保留该服务。');
    const stopped = await request('/api/system/shutdown', 'POST');
    if (stopped?.ok !== true) throw new Error('后台未确认正常退出，请稍后重试。');
    await waitGone();
  }
  async function startInternal() {
    const health = await probe();
    if (matches(health)) { active = true; return origin; }
    if (health) {
      if (!sameData(health)) throw new Error('端口被其他服务占用，或数据目录无法核实。已保留该服务，请先正常退出后重试。');
      if (normalize(health.appDirectory) !== normalize(root)) throw new Error('此端口运行着另一安装目录的图纸工作台，已保留该服务。请先正常退出。');
      const previous = /^\d+\.\d+\.\d+$/.test(health.version || '') ? health.version.split('.').map(Number) : null;
      const current = options.version.split('.').map(Number);
      const difference = previous && previous.map((value,index) => value - current[index]).find(value => value !== 0);
      if (!previous || !(difference < 0)) throw new Error('此端口运行着不同版本的图纸工作台，请先正常退出后重试。');
      await stopVerified(value => sameData(value) && value.version === health.version && value.appDirectory === health.appDirectory);
    }
    const executable = path.join(root, 'runtime', 'node', 'node.exe');
    const entry = path.join(root, 'tools', 'run-server.js');
    if (!exists(executable) || !exists(entry)) throw new Error('软件运行组件缺失，请重新安装完整安装包。');
    if (child && !childEnded) throw new Error('上一后台仍在启动或等待响应，请稍后重试。');
    child = launch(executable, [entry], {cwd:root, windowsHide:true, stdio:'ignore', env:{...process.env, ...options.env, DRAWING_WORKBENCH_DATA:data, DRAWING_WORKBENCH_PORT:String(port)}});
    const launched = child;
    childEnded = false;
    let failure = null;
    child.once('error', () => { if (child === launched) childEnded = true; failure = new Error('后台启动失败，请检查运行组件与数据目录权限。'); });
    child.once('exit', () => { if (child === launched) childEnded = true; failure = new Error('后台已停止，请查看数据目录 logs 中的启动日志后重试。'); if (child === launched && active) { active = false; options.onUnexpectedExit?.(failure.message); } });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (failure) throw failure;
      const current = await probe();
      if (failure) throw failure;
      if (current) {
        if (!matches(current)) throw new Error('启动时检测到其他后台服务，已停止连接。');
        active = true; return origin;
      }
      await sleep(200);
    }
    throw new Error('后台启动超时，请查看数据目录 logs 中的日志后重试。');
  }
  return {
    origin, data, root, matches,
    start() { if (!starting) starting = startInternal().finally(() => { starting = null; }); return starting; },
    async stop() {
      if (starting) { try { await starting; } catch {} }
      if (!active && !child) return;
      const health = await probe();
      if (!health) {
        if (child && !childEnded) throw new Error('后台尚未响应，无法确认正常退出。请保留窗口并稍后重试。');
        active = false; return;
      }
      if (!matches(health)) throw new Error('后台身份无法核实，已保留该服务。');
      active = false;
      try { await stopVerified(matches); } catch (error) { active = true; throw error; }
    },
    async locate(id, showItemInFolder) {
      if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)) throw new Error('图纸编号无效。');
      if (!active || !matches(await probe())) throw new Error('后台服务身份无法核实，请重试。');
      const file = await request(`/api/files/${id}?pdfMode=all`);
      if (file?.id !== id || file.exists !== true || typeof file.path !== 'string' || !path.isAbsolute(file.path) || file.path.includes('\0')) throw new Error('图纸已不可访问或不在扫描范围内。');
      showItemInFolder(file.path);
      return {ok:true, message:'已请求资源管理器定位'};
    }
  };
}
module.exports = {createBackend, requestJson};

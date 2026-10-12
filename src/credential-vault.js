'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');

const STORAGE = 'windows-dpapi-current-user';
const HELPER = path.resolve(__dirname, '../tools/credential_vault.py');

function vaultError(message, statusCode = 500) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function createCredentialVault({dataDir, python}) {
  if (!dataDir || !python) throw new Error('本机密钥存储缺少运行配置。');
  const filePath = path.join(dataDir, 'ai-credentials.dpapi.json');

  function configured() {
    // 状态查询只查文件是否存在，绝不为前端状态解密密钥。
    return fs.existsSync(filePath);
  }

  function run(operation, value) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(python, [HELPER], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8'}
        });
      } catch {
        reject(vaultError('本机密钥加密工具无法启动。'));
        return;
      }
      let output = '', settled = false;
      const fail = message => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        reject(vaultError(message));
      };
      const timer = setTimeout(() => fail('本机密钥加密工具响应超时。'), 15000);
      timer.unref?.();
      child.on('error', () => fail('本机密钥加密工具无法启动。'));
      child.stdin.on('error', () => fail('本机密钥加密工具无法读取输入。'));
      child.stdout.on('data', chunk => {
        output += chunk.toString('utf8');
        if (Buffer.byteLength(output, 'utf8') > 128 * 1024) fail('本机密钥加密工具返回异常。');
      });
      // 不传播 Python stderr；其中可能含意外的环境或输入信息。
      child.stderr.resume();
      child.on('close', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        let result;
        try { result = JSON.parse(output); } catch {}
        if (code !== 0 || !result || typeof result.value !== 'string') {
          reject(vaultError(operation === 'decrypt'
            ? '本机密钥无法解密，请重新保存 API Key。'
            : '本机密钥加密失败，请检查 Windows 用户环境。'));
          return;
        }
        resolve(result.value);
      });
      // 仅经 stdin 传递密钥；命令行参数中不出现密钥。
      child.stdin.end(JSON.stringify({operation, value}), 'utf8');
    });
  }

  async function read() {
    if (!configured()) throw vaultError('请先在 AI 设置中保存 DeepSeek API Key。', 400);
    let stored;
    try {
      if (fs.statSync(filePath).size > 128 * 1024) throw new Error();
      stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (stored.version !== 1 || stored.protection !== STORAGE ||
          typeof stored.ciphertext !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(stored.ciphertext)) throw new Error();
    } catch {
      throw vaultError('本机密钥文件无法读取，请重新保存 API Key。');
    }
    const apiKey = await run('decrypt', stored.ciphertext);
    if (!apiKey || apiKey.length > 512 || /\s/.test(apiKey)) {
      throw vaultError('本机密钥内容无效，请重新保存 API Key。');
    }
    return apiKey;
  }

  async function save(apiKey) {
    if (typeof apiKey !== 'string') throw vaultError('API Key 必须为文本。', 400);
    const cleaned = apiKey.trim();
    if (!cleaned || cleaned.length > 512 || /\s|[\u0000-\u001f\u007f]/.test(cleaned)) {
      throw vaultError('API Key 格式不正确，请粘贴完整密钥。', 400);
    }
    const ciphertext = await run('encrypt', cleaned);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext)) throw vaultError('本机密钥加密工具返回异常。');
    fs.mkdirSync(dataDir, {recursive: true});
    const temporary = filePath + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify({version: 1, protection: STORAGE, ciphertext}),
        {encoding: 'utf8', mode: 0o600, flag: 'wx'});
      fs.renameSync(temporary, filePath);
    } catch {
      throw vaultError('本机密钥无法保存，请检查数据目录权限。');
    } finally {
      try { fs.unlinkSync(temporary); } catch {}
    }
  }

  function clear() {
    try { fs.unlinkSync(filePath); } catch (error) {
      if (error.code !== 'ENOENT') throw vaultError('本机密钥无法清除，请检查数据目录权限。');
    }
  }

  return {configured, read, save, clear, filePath, storage: STORAGE};
}

module.exports = {createCredentialVault};

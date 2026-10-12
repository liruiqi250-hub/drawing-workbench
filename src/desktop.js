'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const config=require('./config');
const execFileAsync=promisify(execFile);
const literal=s=>"'"+s.replace(/'/g,"''")+"'";
async function powershell(script){return execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:15000,maxBuffer:512*1024});}
async function openFile(p){await powershell(`Start-Process -FilePath ${literal(p)}`);}
async function locateFile(p){await execFileAsync('explorer.exe',[`/select,${p}`],{windowsHide:true,timeout:15000});}
async function setAutoStart(enabled){
  const startup=path.join(process.env.APPDATA,'Microsoft','Windows','Start Menu','Programs','Startup');
  const shortcut=path.join(startup,'图纸工作台.lnk');
  if(!enabled){if(fs.existsSync(shortcut))fs.unlinkSync(shortcut);return;}
  fs.mkdirSync(startup,{recursive:true});
  const script=path.join(config.APP_DIR,'启动图纸工作台.ps1');
  const args=`-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}" -BackgroundOnly`;
  await powershell(`$shortcut=(New-Object -ComObject WScript.Shell).CreateShortcut(${literal(shortcut)});$shortcut.TargetPath=Join-Path $PSHOME 'powershell.exe';$shortcut.Arguments=${literal(args)};$shortcut.WorkingDirectory=${literal(config.APP_DIR)};$shortcut.WindowStyle=7;$shortcut.Description='图纸工作台 V${config.VERSION} 登录后后台监听';$shortcut.Save()`);
}
module.exports={openFile,locateFile,setAutoStart};

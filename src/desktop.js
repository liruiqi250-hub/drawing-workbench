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
async function locateFile(p){
  let result;
  try{
    const {stdout}=await execFileAsync(config.PYTHON,[path.join(config.APP_DIR,'tools','locate_file.py'),p],{windowsHide:true,timeout:15000,maxBuffer:64*1024,env:{...process.env,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'}});
    result=JSON.parse(stdout.trim());
  }catch(error){
    try{result=JSON.parse(String(error.stdout||'').trim());}catch{}
    throw new Error(result?.error||(error.killed?'Windows 定位响应超时，请稍后重试。':'定位工具未能启动，请检查本机 Python 运行环境。'));
  }
  if(result?.ok!==true||result.hresult!==0)throw new Error(result?.error||'Windows 没有确认图纸定位成功，请稍后重试。');
}
async function setAutoStart(enabled){
  const startup=process.env.DRAWING_WORKBENCH_STARTUP||path.join(process.env.APPDATA,'Microsoft','Windows','Start Menu','Programs','Startup');
  const shortcut=path.join(startup,'图纸工作台.lnk');
  if(!enabled){
    if(fs.existsSync(shortcut))await powershell(`$shell=New-Object -ComObject WScript.Shell;$entry=$shell.CreateShortcut(${literal(shortcut)});if($entry.Description -like '图纸工作台*' -or $entry.Arguments -like '*启动图纸工作台.ps1*' -or $entry.TargetPath -like '*后台启动.vbs'){Remove-Item -LiteralPath ${literal(shortcut)}}`);
    return;
  }
  fs.mkdirSync(startup,{recursive:true});
  const script=path.join(config.APP_DIR,'启动图纸工作台.ps1');
  const args=`-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}" -BackgroundOnly`;
  await powershell(`$shortcut=(New-Object -ComObject WScript.Shell).CreateShortcut(${literal(shortcut)});$shortcut.TargetPath=Join-Path $PSHOME 'powershell.exe';$shortcut.Arguments=${literal(args)};$shortcut.WorkingDirectory=${literal(config.APP_DIR)};$shortcut.WindowStyle=7;$shortcut.Description='图纸工作台 V${config.VERSION} 登录后后台监听';$shortcut.Save()`);
}
module.exports={openFile,locateFile,setAutoStart};

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const app=path.resolve(__dirname,'..'),base=path.join(app,'.test-tmp');fs.mkdirSync(base,{recursive:true});
const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
// Windows PowerShell must discover its own modules rather than inherit PowerShell 7 paths.
const powershellEnv={...process.env};for(const key of Object.keys(powershellEnv))if(key.toLowerCase()==='psmodulepath')delete powershellEnv[key];
function fixture(){const dir=fs.mkdtempSync(path.join(base,'offline-integrity-')),scripts=path.join(dir,'scripts'),file=path.join(dir,'runtime/python/Lib/site-packages/trusted.py');fs.mkdirSync(scripts,{recursive:true});fs.mkdirSync(path.dirname(file),{recursive:true});fs.copyFileSync(path.join(app,'scripts/verify-bundled-runtime.ps1'),path.join(scripts,'verify-bundled-runtime.ps1'));fs.writeFileSync(file,'# verified fixture\n');const item={path:'runtime/python/Lib/site-packages/trusted.py',sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')};const manifest={version:require('../package.json').version,files:[item]};const save=()=>fs.writeFileSync(path.join(dir,'bundled-runtime.json'),JSON.stringify(manifest));save();return {dir,file,manifest,save,verify:()=>spawnSync(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(scripts,'verify-bundled-runtime.ps1')],{windowsHide:true,timeout:15000,encoding:'utf8',env:powershellEnv}),close(){assert.ok(dir.startsWith(base+path.sep));fs.rmSync(dir,{recursive:true,force:true});}};}

test('离线完整清单接受原组件，拒绝未列出的启动脚本和组件篡改',{skip:process.platform!=='win32'},()=>{
 const f=fixture();try{assert.equal((f.last=f.verify()).status,0,f.last.stderr);const extra=path.join(path.dirname(f.file),'unverified.pth');fs.writeFileSync(extra,'import os; os.environ["UNVERIFIED_FIXTURE"]="bad"');assert.notEqual(f.verify().status,0);fs.unlinkSync(extra);assert.equal((f.last=f.verify()).status,0,f.last.stderr);fs.appendFileSync(f.file,'tampered');assert.notEqual(f.verify().status,0);}finally{f.close();}
});
test('离线完整清单拒绝缺失、重复及越界成员',{skip:process.platform!=='win32'},()=>{
 const f=fixture();try{f.manifest.files.push({...f.manifest.files[0]});f.save();assert.notEqual(f.verify().status,0);f.manifest.files.pop();f.manifest.files[0].path='../outside.py';f.save();assert.notEqual(f.verify().status,0);f.manifest.files[0].path='runtime/python/Lib/site-packages/trusted.py';f.save();fs.unlinkSync(f.file);assert.notEqual(f.verify().status,0);}finally{f.close();}
});
test('离线运行时拒绝重解析目录，不跟随外部组件',{skip:process.platform!=='win32'},()=>{
 const f=fixture();try{const outside=path.join(f.dir,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'extra.py'),'# external fixture');fs.symlinkSync(outside,path.join(f.dir,'runtime/linked'),'junction');assert.notEqual(f.verify().status,0);fs.unlinkSync(path.join(f.dir,'runtime/linked'));assert.equal((f.last=f.verify()).status,0,f.last.stderr);}finally{f.close();}
});

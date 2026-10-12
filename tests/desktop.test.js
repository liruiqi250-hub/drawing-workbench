'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const temporary=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'drawing-locate-'));
process.env.DRAWING_WORKBENCH_DATA=path.join(temporary,'data');
process.env.DRAWING_WORKBENCH_ROOTS=JSON.stringify([temporary]);
const config=require('../src/config'),desktop=require('../src/desktop');
const helper=path.join(config.APP_DIR,'tools','locate_file.py');
const supported=process.platform==='win32'&&fs.existsSync(config.PYTHON);
test.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));

test('定位不存在的图纸返回中文原因，不把启动进程当成定位成功',{skip:!supported},async()=>{
  await assert.rejects(desktop.locateFile(path.join(temporary,'不存在的图纸.dwg')),/不存在或当前不可访问/);
});
test('定位目录或相对路径被拒绝，不误定位到其他文件',{skip:!supported},async()=>{
  await assert.rejects(desktop.locateFile(temporary),/不存在或当前不可访问/);
  await assert.rejects(desktop.locateFile('relative.dwg'),/完整/);
});
test('Windows原生定位支持中文、空格、逗号和单引号，源文件字节不变',{skip:!supported},async()=>{
  const file=path.join(temporary,"中文 空格,逗号'括号(1) &图纸.dwg");
  const bytes=Buffer.from('read-only locate fixture');fs.writeFileSync(file,bytes);
  await desktop.locateFile(file);
  assert.deepEqual(fs.readFileSync(file),bytes);
});
test('定位环境丢失时返回可操作的错误，不暴露原始命令堆栈',{skip:!supported},()=>{
  const script=`require('./src/desktop').locateFile('fixture').then(()=>process.exit(2),e=>{console.log(e.message);process.exit(0)});`;
  const result=spawnSync(process.execPath,['-e',script],{cwd:config.APP_DIR,env:{...process.env,DRAWING_WORKBENCH_PYTHON:path.join(temporary,'missing-python.exe')},encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0);assert.match(result.stdout,/检查本机 Python 运行环境/);assert.doesNotMatch(result.stdout,/Command failed|execFile|missing-python/);
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const app=path.resolve(__dirname,'..');

test('首次配置使用各自的 LocalAppData，内置运行时路径不依赖发布者电脑',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'drawing-distribution-'));
  const env={...process.env,LOCALAPPDATA:temporary};
  for(const key of ['DRAWING_WORKBENCH_DATA','DRAWING_WORKBENCH_PYTHON','DRAWING_WORKBENCH_ROOTS'])delete env[key];
  try {
    const script=`const c=require('./src/config');console.log(JSON.stringify({data:c.DATA_DIR,python:c.PYTHON,version:c.VERSION,settings:c.getSettings(),excluded:c.isExcluded(require('node:path').join(c.DATA_DIR,'fixture.pdf')),runtimeExcluded:c.isExcluded(require('node:path').join(c.APP_DIR,'runtime','fixture.pdf'))}));`;
    const result=spawnSync(process.execPath,['-e',script],{cwd:app,env,encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,result.stderr);
    const config=JSON.parse(result.stdout);
    assert.equal(config.data,path.join(temporary,'DrawingWorkbench','data'));
    assert.equal(config.python,path.join(app,'runtime','python','python.exe'));
    assert.equal(config.version,require('../package.json').version);
    assert.equal(config.settings.ai.enabled,false);
    assert.deepEqual(config.settings.groupingRules,[]);
    assert.ok(config.settings.roots.length>0);
    assert.ok(config.excluded&&config.runtimeExcluded);
    assert.equal(fs.existsSync(path.join(config.data,'ai-credentials.dpapi.json')),false);
  } finally { fs.rmSync(temporary,{recursive:true,force:true}); }
});

test('安装清单固定来源、版本和 SHA256，源码附带 AI 安装入口',()=>{
  const manifest=require('../scripts/runtime-manifest.json');
  for(const item of [manifest.node,manifest.python,...manifest.wheels]){
    assert.match(item.sha256,/^[a-f0-9]{64}$/);
    const url=new URL(item.url);
    assert.equal(url.protocol,'https:');
    assert.ok(['nodejs.org','www.python.org','files.pythonhosted.org'].includes(url.hostname));
  }
  for(const file of ['README.md','AI安装说明.md','AGENTS.md','启动图纸工作台.ps1','停止图纸工作台.ps1','scripts/install-windows.ps1'])assert.ok(fs.existsSync(path.join(app,file)),file);
});

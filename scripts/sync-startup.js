'use strict';
const fs=require('node:fs'),path=require('node:path');
const data=path.resolve(process.env.DRAWING_WORKBENCH_DATA||path.join(process.env.LOCALAPPDATA||require('node:os').homedir(),'DrawingWorkbench','data'));
const file=path.join(data,'settings.json');
if(fs.existsSync(file)){
  try{
    const settings=JSON.parse(fs.readFileSync(file,'utf8'));
    if(settings.autoStart===true)require('../src/desktop').setAutoStart(true).catch(error=>{console.error('自动启动入口同步失败：'+error.message);process.exitCode=1;});
  }catch(error){console.error('无法核验自动启动配置：'+error.message);process.exitCode=1;}
}

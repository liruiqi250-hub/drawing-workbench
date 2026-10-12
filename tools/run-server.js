'use strict';
// 后台日志由程序自己写入，启动器不继承 AI 终端的重定向管道。
const fs=require('node:fs'),path=require('node:path');
// 不能先加载 config：settings.json 损坏时也必须留下可读取的启动原因。
const dataDir=path.resolve(process.env.DRAWING_WORKBENCH_DATA||path.join(process.env.LOCALAPPDATA||require('node:os').homedir(),'DrawingWorkbench','data'));
const logs=path.join(dataDir,'logs');fs.mkdirSync(logs,{recursive:true});
for(const [stream,name] of [[process.stdout,'server.out.log'],[process.stderr,'server.error.log']]){
  const fd=fs.openSync(path.join(logs,name),'a');
  stream.write=(chunk,encoding,callback)=>{
    if(typeof encoding==='function'){callback=encoding;encoding=undefined;}
    try{fs.writeSync(fd,Buffer.isBuffer(chunk)?chunk:Buffer.from(String(chunk),encoding||'utf8'));if(callback)callback();return true;}
    catch(error){if(callback)callback(error);return false;}
  };
}
console.error(`启动尝试 ${new Date().toISOString()} V${require('../package.json').version}`);
try{require('../server');}catch(error){console.error('启动失败：'+error.message);process.exitCode=1;}

'use strict';
// 后台日志由程序自己写入，启动器不继承 AI 终端的重定向管道。
const fs=require('node:fs'),path=require('node:path');
const config=require('../src/config');
const logs=path.join(config.DATA_DIR,'logs');fs.mkdirSync(logs,{recursive:true});
for(const [stream,name] of [[process.stdout,'server.out.log'],[process.stderr,'server.error.log']]){
  const fd=fs.openSync(path.join(logs,name),'a');
  stream.write=(chunk,encoding,callback)=>{
    if(typeof encoding==='function'){callback=encoding;encoding=undefined;}
    try{fs.writeSync(fd,Buffer.isBuffer(chunk)?chunk:Buffer.from(String(chunk),encoding||'utf8'));if(callback)callback();return true;}
    catch(error){if(callback)callback(error);return false;}
  };
}
require('../server');

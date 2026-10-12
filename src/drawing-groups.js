'use strict';
const path=require('node:path');
// 分组键只在本机存储：完整来源目录 + 精确基础文件名 + 格式。
// 不使用图号、产品关键词、文件大小或修改时间作为跨目录合并证据。
function groupIdentity(file,naming,rules=[],pathApi=path){
  let directory=pathApi.dirname(file.path),basis=naming.backupTimestamp?'同目录基础名与备份时间戳':'独立文件',ruleName='';
  const key=value=>pathApi.resolve(value).replace(/[\\/]+$/,'').toLowerCase();
  const matches=rules.filter(rule=>rule.enabled!==false).filter(rule=>{
    const relative=pathApi.relative(rule.backupRoot,directory);
    return relative===''||(!relative.startsWith('..'+pathApi.sep)&&relative!=='..'&&!pathApi.isAbsolute(relative));
  }).sort((a,b)=>b.backupRoot.length-a.backupRoot.length);
  if(matches.length){
    const rule=matches[0];directory=pathApi.resolve(rule.sourceRoot,pathApi.relative(rule.backupRoot,directory));
    basis='备份目录映射与精确基础名';ruleName=rule.name;
  }
  const name=(naming.baseName||pathApi.basename(file.name,file.extension))+file.extension;
  return {key:key(pathApi.join(directory,name)),basis,ruleName,mapped:matches.length>0};
}
module.exports={groupIdentity};

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const APP_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.DRAWING_WORKBENCH_DATA || path.join(process.env.LOCALAPPDATA || require('node:os').homedir(), 'DrawingWorkbench', 'data'));
const VERSION = require('../package.json').version;
const PORT = Number(process.env.DRAWING_WORKBENCH_PORT || 17863);
const PYTHON = process.env.DRAWING_WORKBENCH_PYTHON || path.join(APP_DIR, 'runtime', 'python', 'python.exe');
fs.mkdirSync(DATA_DIR, {recursive:true});
const CONFIG_PATH = path.join(DATA_DIR, 'settings.json');
const defaults = () => ({
  roots: process.env.DRAWING_WORKBENCH_ROOTS ? JSON.parse(process.env.DRAWING_WORKBENCH_ROOTS) : (process.platform==='win32' ? Array.from({length:24},(_,i)=>String.fromCharCode(67+i)+':'+path.sep).filter(p=>fs.existsSync(p)) : [require('node:os').homedir()]),
  extensions: ['.dwg','.dxf','.pdf','.dwt','.dgn','.step','.stp','.iges','.igs','.sldprt','.sldasm','.slddrw'],
  excludeDirs: ['Windows','Program Files','Program Files (x86)','ProgramData','$Recycle.Bin','System Volume Information','AppData','node_modules','.git','.venv','venv','$WinREAgent','Recovery','MSOCache','Config.Msi'],
  watch: true, rescanMinutes:30, pageSize:50, autoStart:false,
  versionGrouping:true, groupingRules:[],
  classificationRules:[
    {keyword:'平面图',project:'',type:'平面图'},
    {keyword:'平面布置',project:'',type:'平面图'},
    {keyword:'总装图',project:'',type:'总装图'},
    {keyword:'钢架',project:'',type:'钢架结构'},
    {keyword:'电机',project:'',type:'电机安装'},
    {keyword:'安装说明',project:'',type:'安装说明'},
    {keyword:'接线',project:'',type:'电气图纸'}
  ],
  ai:{provider:'deepseek',baseUrl:'https://api.deepseek.com',model:'deepseek-flash',enabled:false,sendPdfText:false,batchSize:5,candidateLimit:60}
});
function validateAiSettings(input,base=defaults().ai){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('AI 设置必须是对象。');
  const next={...defaults().ai,...base,provider:'deepseek',baseUrl:'https://api.deepseek.com'};
  for(const key of ['enabled','sendPdfText'])if(key in input){if(typeof input[key]!=='boolean')throw new Error('AI 开关必须为布尔值。');next[key]=input[key];}
  if('model' in input){const model=String(input.model).trim();if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(model))throw new Error('请填写有效的 DeepSeek 模型 ID。');next.model=model;}
  for(const [key,min,max] of [['batchSize',1,10],['candidateLimit',20,100]])if(key in input){const value=Number(input[key]);if(!Number.isInteger(value)||value<min||value>max)throw new Error(`${key} 超出范围 ${min}–${max}。`);next[key]=value;}
  // Secrets are stored separately with Windows DPAPI and never enter settings.json.
  return {provider:next.provider,baseUrl:next.baseUrl,model:next.model,enabled:next.enabled,sendPdfText:next.sendPdfText,batchSize:next.batchSize,candidateLimit:next.candidateLimit};
}
function validateSettings(input, base=defaults()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('设置必须是对象。');
  const next = structuredClone(base);
  if ('roots' in input) {
    if (!Array.isArray(input.roots) || !input.roots.length || input.roots.length>64) throw new Error('请至少添加一个扫描位置，最多 64 个。');
    next.roots = [...new Set(input.roots.map(p=>{
      if(typeof p!=='string')throw new Error('扫描位置必须是完整的本机磁盘、文件夹或共享路径。');
      const cleaned=p.trim().replace(/^"|"$/g,'');
      if(!cleaned||cleaned.includes('\0')||!path.isAbsolute(cleaned)) throw new Error('扫描位置必须是完整的本机磁盘、文件夹或共享路径。');
      return path.resolve(cleaned);
    }))];
  }
  if ('extensions' in input) {
    if(!Array.isArray(input.extensions)||!input.extensions.length||input.extensions.length>64) throw new Error('请至少选择一个图纸文件类型。');
    next.extensions=[...new Set(input.extensions.map(v=>{
      const ext=String(v).trim().toLowerCase().replace(/^\*?\.?/,'.');
      if(!/^\.[a-z0-9]{1,12}$/.test(ext)) throw new Error('文件类型格式不正确，例如 .dwg、.pdf。');
      return ext;
    }))];
  }
  if ('excludeDirs' in input) {
    if(!Array.isArray(input.excludeDirs)||input.excludeDirs.length>300) throw new Error('排除目录最多 300 项。');
    next.excludeDirs=[...new Set(input.excludeDirs.map(v=>String(v).trim()).filter(Boolean))];
  }
  for (const k of ['watch','autoStart','versionGrouping']) if(k in input){if(typeof input[k]!=='boolean') throw new Error(`${k} 必须是开关。`);next[k]=input[k];}
  if('groupingRules' in input){
    if(!Array.isArray(input.groupingRules)||input.groupingRules.length>64)throw new Error('备份来源规则最多 64 条。');
    next.groupingRules=input.groupingRules.map(rule=>{
      if(!rule||typeof rule!=='object')throw new Error('备份来源规则无效。');
      const name=String(rule.name||'备份来源').trim();
      if(!name||name.length>120)throw new Error('规则名称需为 1–120 字。');
      for(const field of ['backupRoot','sourceRoot'])if(typeof rule[field]!=='string'||!rule[field].trim()||rule[field].includes('\0')||!path.isAbsolute(rule[field]))throw new Error('备份目录和原图目录必须是完整路径。');
      const backupRoot=path.resolve(rule.backupRoot.trim()),sourceRoot=path.resolve(rule.sourceRoot.trim());
      if(contained(sourceRoot,backupRoot))throw new Error('原图目录不能与备份目录相同，也不能位于备份目录内。');
      if('enabled' in rule&&typeof rule.enabled!=='boolean')throw new Error('规则启用状态无效。');
      return {name,backupRoot,sourceRoot,enabled:rule.enabled!==false};
    });
    const roots=next.groupingRules.filter(rule=>rule.enabled).map(rule=>pathKey(rule.backupRoot));
    if(new Set(roots).size!==roots.length)throw new Error('同一个备份目录只能启用一条来源规则。');
  }
  for (const [k,min,max] of [['rescanMinutes',1,1440],['pageSize',10,200]]) if(k in input){const v=Number(input[k]);if(!Number.isInteger(v)||v<min||v>max)throw new Error(`${k} 超出允许范围 ${min}–${max}。`);next[k]=v;}
  if ('classificationRules' in input) {
    if(!Array.isArray(input.classificationRules)||input.classificationRules.length>200) throw new Error('分类规则最多 200 条。');
    next.classificationRules=input.classificationRules.map(r=>{
      if(!r||typeof r.keyword!=='string'||!r.keyword.trim())throw new Error('每条分类规则需要一个关键词。');
      const rule={keyword:r.keyword.trim(),project:String(r.project||'').trim(),type:String(r.type||'').trim()};
      if(Object.values(rule).some(v=>v.length>120))throw new Error('规则字段不能超过 120 个字符。');
      return rule;
    });
  }
  if('ai' in input){
    // V0.2.0 disabled placeholders migrate to the current provider defaults.
    const incoming=input.ai?.provider==='disabled'?{}:input.ai;
    next.ai=validateAiSettings(incoming,base.ai);
  }else next.ai=validateAiSettings({},base.ai);
  return next;
}
let settings;
try {settings=validateSettings(JSON.parse(fs.readFileSync(CONFIG_PATH,'utf8')));} catch(error) {
  if(fs.existsSync(CONFIG_PATH))throw new Error('设置文件无法读取。请从备份恢复 data/settings.json，原文件未改动：'+error.message);
  settings=defaults();
}
function getSettings(){return structuredClone(settings);}
function saveSettings(input){
  const next=validateSettings(input,settings);
  const tmp=CONFIG_PATH+'.tmp';fs.writeFileSync(tmp,JSON.stringify(next,null,2),'utf8');fs.renameSync(tmp,CONFIG_PATH);settings=next;return getSettings();
}
if(!fs.existsSync(CONFIG_PATH))saveSettings({});
function pathKey(p){return path.resolve(p).replace(/[\\/]+$/,'').toLowerCase();}
function contained(p,root){const relative=path.relative(root,p);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));}
function isExcluded(p,s=getSettings()){
  if(contained(p,DATA_DIR)||contained(p,path.join(APP_DIR,'runtime'))||contained(p,path.join(APP_DIR,'cache'))||contained(p,path.join(APP_DIR,'data'))||contained(p,path.join(APP_DIR,'vendor'))||contained(p,path.join(APP_DIR,'logs')))return true;
  const parts=path.resolve(p).toLowerCase().split(/[\\/]/);
  return s.excludeDirs.some(x=>path.isAbsolute(x)?contained(p,path.resolve(x)):parts.includes(x.toLowerCase()));
}
function isAllowed(p,s=getSettings(),checkExtension=true){return s.roots.some(r=>contained(p,r))&&!isExcluded(p,s)&&(!checkExtension||s.extensions.includes(path.extname(p).toLowerCase()));}
module.exports={APP_DIR,DATA_DIR,CONFIG_PATH,VERSION,PORT,PYTHON,getSettings,saveSettings,validateSettings,validateAiSettings,pathKey,contained,isExcluded,isAllowed};

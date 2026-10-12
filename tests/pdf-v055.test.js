'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const base=path.resolve(__dirname,'../.test-tmp');fs.mkdirSync(base,{recursive:true});const temp=fs.mkdtempSync(path.join(base,'pdf-v055-'));
process.env.DRAWING_WORKBENCH_DATA=path.join(temp,'data');process.env.DRAWING_WORKBENCH_ROOTS=JSON.stringify([temp]);delete process.env.DRAWING_WORKBENCH_DISABLE_PDF_INDEX;
const config=require('../src/config'),store=require('../src/store'),rules=require('../src/pdf-rules'),aiStore=require('../src/ai-store');
const {createPdfIndexer,POWERSHELL}=require('../src/pdf-indexer');
let workers=[];
function add(name,folder='source',body='synthetic read-only PDF fixture'){
  const file=path.join(temp,folder,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body);
  const stat=fs.statSync(file,{bigint:true}),meta={path:file,name,extension:path.extname(file),size:Number(stat.size),modified:Number(stat.mtimeMs),fileKey:`${path.parse(file).root.toLowerCase()}:${stat.dev}:${stat.ino}`};
  return {id:store.upsert(meta).id,file,meta};
}
function snapshot(id){const row=store.getRaw(id);return {id,path:row.path,version:store.contentVersion(row)};}
function result(text,pages=[{page:1,text,source:'text'}],extra={}){return {status:text?'ready':'no_text',text,pages,totalPages:pages.length,indexedPages:pages.length,truncated:false,ocrPages:0,...extra};}
function index(id,text,pages,extra){return store.setPdfResult(snapshot(id),result(text,pages,extra));}
async function until(predicate){for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('PDF queue timed out');}
function worker(fake){const instance=createPdfIndexer({execFile:fake});workers.push(instance);return instance;}
function fakeRunner(onPdf,ocr=true){return (command,args,opts,callback)=>{
  const handle={kill(){}};setImmediate(()=>{if(command===POWERSHELL)callback(null,JSON.stringify({available:ocr,languages:ocr?['zh-Hans-CN']:[],error:ocr?'':'本机无 OCR 语言'}));else onPdf(args,opts,callback);});return handle;
};}
test.beforeEach(()=>{for(const worker of workers)worker.stop();workers=[];store.db.exec('DELETE FROM files;DELETE FROM events;DELETE FROM classification_members;DELETE FROM group_confirmations;DELETE FROM group_classifications');config.saveSettings({pdf:{...rules.defaults(),skipNamedDrawings:false},groupingRules:[],versionGrouping:true});store.migrateGroups(true);store.invalidateStats();});
test.after(async()=>{for(const worker of workers)worker.stop();await new Promise(resolve=>setTimeout(resolve,20));store.close();assert.ok(temp.startsWith(base+path.sep));fs.rmSync(temp,{recursive:true,force:true});});

test('PDF 设置有界，关键词按字面处理，默认待判断可见',()=>{
  assert.equal(config.getSettings().pdf.displayMode,'drawings-pending');
  const item=add('合同扫描件.pdf');assert.equal(store.publicFile(store.getRaw(item.id)).pdfInfo.kind,'pending');assert.equal(store.search().total,1);
  for(const pdf of [{maxPages:101},{ocrMaxPages:31},{maxPages:0},{ocrEnabled:'yes'},{displayMode:'none'},{includeKeywords:['x'.repeat(81)]},{excludeKeywords:Array(101).fill('x')}])assert.throws(()=>config.validateSettings({pdf}));
  assert.deepEqual(config.validateSettings({pdf:{includeKeywords:['a.*','a.*']}}).pdf.includeKeywords,['a.*']);
});
test('三态判断需要组合证据，孤立数字、路径文档词、大页面或矢量路径不能决定类别',()=>{
  const settings=rules.defaults();
  for(const text of ['123 456 2026 10000','产品长度 500mm，重量 20kg','随附资料'])assert.equal(rules.classify({name:'资料.pdf',path:'C:\\合同\\资料.pdf'},result(text,[{page:1,text,vectorPathCount:10000,width:2000,height:2000}]),settings).kind,'pending');
  assert.equal(rules.classify({name:'合同.pdf',path:'C:\\合同.pdf'},result('甲方 乙方 合同金额 500 元，付款期限 20 日'),settings).kind,'document');
  assert.equal(rules.classify({name:'invoice.pdf',path:'C:\\invoice.pdf'},result('Invoice Number 1000 Total amount 500 Date 2026'),settings).kind,'document');
  assert.equal(rules.classify({name:'合同钢架图纸.pdf',path:'C:\\合同钢架图纸.pdf'},result('仅有少量普通正文'),settings).kind,'pending');
  assert.equal(rules.classify({name:'合同.pdf',path:'C:\\合同.pdf'},result(''),settings).kind,'pending');
  assert.equal(rules.classify({name:'钢架图纸.pdf',path:'C:\\钢架图纸.pdf'},result('图号 A-123 材料：钢 比例：1:10 Φ20mm'),settings).kind,'drawing');
  assert.equal(rules.classify({name:'合同钢架图纸.pdf',path:'C:\\合同钢架图纸.pdf'},result('合同 甲方 图号 A-123 比例：1:10 Φ20mm'),settings).kind,'pending');
});
test('普通文档默认隐藏但保持 alive、原文件与人工分类；人工恢复跨重建和规则重判保留',()=>{
  const file=add('采购合同.pdf');store.classify(file.id,{project:'已确认项目',type:'合同',tags:['不能丢']});const bytes=fs.readFileSync(file.file);
  index(file.id,'甲方 乙方 合同 金额 500 元');assert.equal(store.search().total,0);assert.equal(store.getRaw(file.id).alive,1);assert.deepEqual(fs.readFileSync(file.file),bytes);
  assert.equal(store.search({pdfMode:'documents'}).items[0].id,file.id);const stats=store.stats();assert.equal(stats.indexedPhysicalTotal,1);assert.equal(stats.physicalTotal,0);assert.equal(stats.pdfCounts.document,1);assert.equal(stats.pdfCounts.hidden,1);
  store.setPdfKind(file.id,'drawing');assert.equal(store.search().total,1);store.requeuePdfs();assert.equal(store.getRaw(file.id).pdf_override,'drawing');assert.equal(store.publicFile(store.getRaw(file.id)).pdfInfo.kind,'drawing');
  index(file.id,'甲方 乙方 合同 金额 500 元');store.rejudgePdfs();assert.equal(store.publicFile(store.getRaw(file.id)).pdfInfo.automaticKind,'document');assert.equal(store.publicFile(store.getRaw(file.id)).pdfInfo.kind,'drawing');assert.equal(store.getClassification(store.getRaw(file.id)).project,'已确认项目');
  store.setPdfKind(file.id,'auto');assert.equal(store.search().total,0);
});
test('规则修改使用已保存正文重判，不需要再次提取；匹配字面关键词且冲突待判断',()=>{
  const file=add('测试词.pdf'),body='正文 测试词 已知资料 甲方乙方金额待确认';index(file.id,body);assert.equal(store.getRaw(file.id).pdf_kind,'pending');
  config.saveSettings({pdf:{excludeKeywords:['测试词']}});store.rejudgePdfs();assert.equal(store.getRaw(file.id).pdf_kind,'document');
  config.saveSettings({pdf:{includeKeywords:['测试词']}});store.rejudgePdfs();assert.equal(store.getRaw(file.id).pdf_kind,'pending');
  assert.equal(store.getRaw(file.id).content,body);
});
test('文档文件名加无佐证正文不自动隐藏，明确业务正文仍可判断普通文档',()=>{
  for(const name of ['采购合同.pdf','安装说明书.pdf','invoice.pdf']){
    const file=add(name);index(file.id,'随附资料 123 456 2026');assert.equal(store.getRaw(file.id).pdf_kind,'pending',name);
    assert.equal(store.search({q:name}).total,1,name);
  }
  assert.equal(rules.classify({name:'invoice.pdf',path:'C:\\invoice.pdf'},result('Invoice Number 123 Total amount 500 Payment 2026')).kind,'document');
  assert.equal(rules.classify({name:'采购合同.pdf',path:'C:\\采购合同.pdf'},result('甲方乙方 合同金额500元 付款日期2026')).kind,'document');
});
test('关键OCR未完成的少量文档页眉保留待判断，规则重判保留partial及未识别证据',()=>{
  const file=add('资料.pdf'),text='安装说明书 使用方法';
  index(file.id,text,[{page:1,text,source:'text',needsOcr:true,ocrError:'OCR不可用'}],{status:'partial',error:'OCR不可用'});
  assert.equal(store.getRaw(file.id).pdf_kind,'pending');assert.match(store.publicFile(store.getRaw(file.id)).pdfInfo.reasons.join(' '),/OCR/);
  config.saveSettings({pdf:{excludeKeywords:['说明书','使用方法']}});store.rejudgePdfs();
  const info=store.publicFile(store.getRaw(file.id),true).pdfInfo;assert.equal(info.kind,'pending');assert.equal(info.status,'partial');assert.equal(info.error,'OCR不可用');assert.equal(info.pages[0].needsOcr,true);
  const drawing=result('图号 A123 比例：1:10 Φ20mm',[{page:1,text:'图号 A123 比例：1:10 Φ20mm',source:'text',needsOcr:true,ocrError:'OCR不可用'}],{status:'partial',error:'OCR不可用'});
  assert.equal(rules.classify({name:'资料.pdf',path:'C:\\资料.pdf'},drawing).kind,'drawing');
});
test('全文和尺寸规范搜索支持直径字形、空白及单位，页证据标明 OCR，预览不会覆盖全文',()=>{
  const file=add('钢架图纸.pdf'),text='图号 A-123 比例：1:10 长度 0.5m；安装孔 Φ 20 mm；圆角 R 50；角度 30 °；矩形 20×30mm；'+ '无关正文'.repeat(4000)+'末尾独有法兰';
  index(file.id,text,[{page:1,text:'首页没有关键字',source:'text'},{page:2,text,source:'ocr'}],{totalPages:7,truncated:true,ocrPages:1});
  for(const q of ['末尾独有法兰','⌀20','Ø20毫米','φ 20 mm','500mm','0.5 m','R50','R 50','30度','30 °']){
    const found=store.search({q});assert.equal(found.total,1,q);assert.equal(found.items[0].pdfMatches[0].page,2,q);assert.equal(found.items[0].pdfMatches[0].source,'ocr');
  }
  assert.equal(store.search({q:'直径500mm'}).total,0);
  assert.deepEqual(new Set(store.publicFile(store.getRaw(file.id)).pdfInfo.dimensions.map(value=>value.kind)),new Set(['length','diameter','radius','angle','rectangle']));
  const publicRow=store.publicFile(store.getRaw(file.id));assert.equal('pages' in publicRow.pdfInfo,false);assert.equal(publicRow.pdfInfo.totalPages,7);assert.equal(publicRow.pdfInfo.truncated,true);assert.ok(publicRow.pdfInfo.updatedAt>0);
  const version=store.contentVersion(store.getRaw(file.id));store.setPreview(file.id,version,{status:'ready',text:'只有缩略图提取的短文字',preview:true,pages:1},file.file);assert.equal(store.getRaw(file.id).content,text);assert.equal(store.getRaw(file.id).pages,7);
  for(const term of ['Ø20毫米','500mm','R50']){
    const evidence=aiStore.candidates({groups:[[term]],keywords:[]},{},60,true)[0].evidence[0];assert.equal(evidence.pdfMatches[0].page,2);const textMatch=evidence.matches.find(match=>match.field==='text');assert.ok(textMatch.terms.includes(term));assert.equal(textMatch.page,2);assert.equal(textMatch.source,'ocr');assert.ok(text.includes(textMatch.snippet));
  }
});
test('备份全文实际命中保留来源，隐藏版本不能帮助搜索、候选或组分类匹配，原图隐藏可代表备份',()=>{
  const original=add('钢架图纸.pdf'),backup=add('钢架图纸 2026-03-02 14_41_24.pdf');
  index(original.id,'图号 A-123 比例：1:10 Φ20mm');index(backup.id,'图号 A-123 比例：1:10 Φ20mm 备份独有轴承');
  const found=store.search({q:'独有轴承'});assert.equal(found.items[0].id,original.id);assert.equal(found.items[0].pdfMatches[0].fileId,backup.id);assert.equal(found.items[0].pdfMatches[0].isBackup,true);
  store.classify(backup.id,{project:'隐藏文档项目',type:'普通文档',tags:['隐藏标签'],scope:'version'});store.setPdfKind(backup.id,'document');
  assert.equal(store.search({q:'独有轴承'}).total,0);assert.equal(store.search({q:'隐藏标签'}).total,0);assert.equal(store.search({project:'隐藏文档项目'}).total,0);assert.equal(aiStore.candidates({groups:[['独有轴承']],keywords:[]},{},60,true).length,0);
  assert.equal(store.search({q:'独有轴承',pdfMode:'all'}).items[0].pdfMatches[0].fileId,backup.id);
  store.setPdfKind(backup.id,'drawing');store.setPdfKind(original.id,'document');assert.equal(store.search().items[0].id,backup.id);assert.equal(store.search().items[0].group.representativeId,backup.id);
});
test('临时all范围贯穿搜索、AI候选与详情分类，保留文档版本已确认项目和variants',()=>{
  const original=add('钢架图纸.pdf'),backup=add('钢架图纸 2026-03-02 14_41_24.pdf');store.setPdfKind(original.id,'drawing');store.setPdfKind(backup.id,'document');
  store.classify(backup.id,{project:'隐藏版本已确认项目',type:'说明',tags:['仅旧版标签'],scope:'version'});
  const all=store.search({pdfMode:'all',project:'隐藏版本已确认项目'});assert.equal(all.total,1);assert.equal(all.items[0].id,original.id);assert.equal(all.items[0].project,'隐藏版本已确认项目');assert.equal(all.items[0].classification.variants.find(row=>row.fileId===backup.id).project,'隐藏版本已确认项目');
  const candidates=aiStore.candidates({groups:[['隐藏版本已确认项目']],keywords:[]},{pdfMode:'all'},60,true);assert.equal(candidates[0].id,original.id);assert.equal(candidates[0].project,'隐藏版本已确认项目');assert.ok(candidates[0].evidence.some(row=>row.fileId===backup.id&&row.project==='隐藏版本已确认项目'));
  const details=store.publicFile(store.getRaw(original.id),true,'all');assert.equal(details.project,'隐藏版本已确认项目');assert.equal(details.classification.variants.length,2);assert.equal(details.versions.find(row=>row.id===backup.id).visible,true);
  const documents=store.publicFile(store.getRaw(backup.id),true,'documents');assert.equal(documents.group.representativeId,backup.id);assert.equal(documents.classification.variants.length,1);
  assert.equal(store.search({project:'隐藏版本已确认项目'}).total,0);assert.equal(store.publicFile(store.getRaw(original.id),true).classification.variants.length,1);assert.equal(config.getSettings().pdf.displayMode,'drawings-pending');
});
test('临时显示范围只改变分类视图，不写继承成员且隐藏冲突不能使新版本继承单方确认',()=>{
  const original=add('钢架图纸.pdf'),backup=add('钢架图纸 2026-03-02 14_41_24.pdf');store.setPdfKind(original.id,'drawing');store.setPdfKind(backup.id,'document');
  store.classify(original.id,{project:'原图确认A',type:'钢架',tags:['A']});store.classify(backup.id,{project:'备份独立B',type:'说明',tags:['B'],scope:'version'});
  const before=store.db.prepare('SELECT * FROM classification_members ORDER BY file_id').all();
  for(const mode of ['drawings-pending','all','documents','drawings-pending']){store.search({pdfMode:mode});store.getClassification(store.getRaw(original.id),mode);store.publicFile(store.getRaw(original.id),true,mode);}
  assert.deepEqual(store.db.prepare('SELECT * FROM classification_members ORDER BY file_id').all(),before);
  const newer=add('钢架图纸 2026-03-02 15_41_24.pdf');assert.equal(store.db.prepare('SELECT * FROM classification_members WHERE file_id=?').get(newer.id),undefined);assert.equal(store.getRaw(newer.id).classified,0);
  const blank=add('另一个图纸.pdf');store.classify(blank.id,{project:'唯一共同确认',type:'钢架',tags:[]});const blankBackup=add('另一个图纸 2026-03-02 15_41_24.pdf');store.db.prepare('DELETE FROM classification_members WHERE file_id=?').run(blankBackup.id);
  const untouched=store.db.prepare('SELECT * FROM classification_members ORDER BY file_id').all();store.getClassification(store.getRaw(blank.id),'all');store.getClassification(store.getRaw(blank.id),'documents');assert.deepEqual(store.db.prepare('SELECT * FROM classification_members ORDER BY file_id').all(),untouched);
});
test('异步 PDF 结果拒绝旧修订、路径变化、真实磁盘变动与超范围输入',()=>{
  const file=add('钢架图纸.pdf'),old=snapshot(file.id);store.upsert({...file.meta,forceInvalidate:true});assert.equal(store.setPdfResult(old,result('图号 A123 Φ20mm')),false);assert.equal(store.getRaw(file.id).pdf_status,'pending');
  const current=snapshot(file.id);fs.writeFileSync(file.file,'changed disk bytes');assert.equal(store.setPdfResult(current,result('新内容')),false);
  assert.equal(store.setPdfResult({...current,path:file.file+'wrong'},result('新内容')),false);
});
test('后台从已知 PDF 排队并接收新保存，单 worker、限额、关闭 OCR 与失败不无限重试',async()=>{
  config.saveSettings({pdf:{maxPages:2,ocrMaxPages:1,ocrEnabled:false}});const file=add('图纸.pdf');let calls=0,active=0,maxActive=0;
  const indexer=worker(fakeRunner((args,opts,callback)=>{calls++;active++;maxActive=Math.max(maxActive,active);const pdf=JSON.parse(args[args.indexOf('--options')+1]);assert.equal(pdf.maxPages,2);assert.equal(pdf.ocrMaxPages,1);assert.equal(pdf.ocrEnabled,false);assert.equal(opts.windowsHide,true);assert.equal(opts.maxBuffer,4*1024*1024);assert.equal(opts.timeout,180000);
    setTimeout(()=>{active--;callback(null,JSON.stringify(result('图号 A123 比例：1:10 Φ20mm')));},20);
  }));await indexer.start();await until(()=>store.getRaw(file.id).pdf_status==='ready');const second=add('新保存图纸.pdf');await until(()=>store.getRaw(second.id).pdf_status==='ready');assert.equal(calls,2);assert.equal(maxActive,1);assert.equal(indexer.status().processed,2);
  indexer.stop();const third=add('损坏.pdf');let failedCalls=0;const failure=worker(fakeRunner((args,opts,callback)=>{failedCalls++;callback(null,JSON.stringify({status:'error',error:'损坏的合成PDF'}));}));await failure.start();await until(()=>store.getRaw(third.id).pdf_status==='error');await new Promise(resolve=>setTimeout(resolve,50));assert.equal(failedCalls,1);assert.equal(failure.status().errorCount,1);
});
test('取消与设置 epoch 拒绝在途旧结果，OCR 无能力说明原因且保留待判断',async()=>{
  const file=add('扫描.pdf');let complete;
  const indexer=worker(fakeRunner((args,opts,callback)=>{complete=callback;}));await indexer.start();await until(()=>!!complete);indexer.cancel();complete(null,JSON.stringify(result('不应写入的旧正文')));await until(()=>!indexer.status().running);assert.equal(store.getRaw(file.id).content,'');assert.equal(indexer.status().cancelled,true);indexer.stop();
  const unavailable=worker(fakeRunner((args,opts,callback)=>{assert.equal(JSON.parse(args.at(-1)).ocrEnabled,false);callback(null,JSON.stringify(result('',[{page:1,text:'',source:'none'}])));},false));await unavailable.start();await until(()=>store.getRaw(file.id).pdf_status==='no_text');assert.equal(unavailable.status().capabilities.ocrAvailable,false);assert.match(store.publicFile(store.getRaw(file.id)).pdfInfo.error,/OCR/);assert.equal(store.getRaw(file.id).pdf_kind,'pending');
});
test('提取设置变更拒绝旧epoch并重排，规则与显示范围变更保留已提取正文',async()=>{
  const file=add('图纸.pdf');let pending=[],count=0;
  const indexer=worker(fakeRunner((args,opts,callback)=>{count++;pending.push(callback);}));await indexer.start();await until(()=>pending.length===1);
  const old=config.getSettings(),next=config.saveSettings({pdf:{maxPages:1}});await indexer.configure(old,next);pending.shift()(null,JSON.stringify(result('旧设置结果不得保存')));
  await until(()=>pending.length===1);assert.equal(store.getRaw(file.id).content,'');pending.shift()(null,JSON.stringify(result('图号 A123 比例：1:10 Φ20mm')));await until(()=>store.getRaw(file.id).pdf_status==='ready');
  const previous=config.getSettings(),newer=config.saveSettings({pdf:{displayMode:'all',excludeKeywords:['图纸']}});await indexer.configure(previous,newer);await new Promise(resolve=>setTimeout(resolve,30));assert.equal(count,2);assert.match(store.getRaw(file.id).content,/图号/);assert.equal(store.getRaw(file.id).pdf_kind,'pending');
});
test('首次能力探测完成前即使保存PDF也不启动提取，探测后扫描件使用OCR',async()=>{
  let probeCallback,pdfCalls=0;
  const indexer=worker((command,args,opts,callback)=>{if(command===POWERSHELL)probeCallback=callback;else{pdfCalls++;assert.equal(JSON.parse(args.at(-1)).ocrEnabled,true);setImmediate(()=>callback(null,JSON.stringify(result('图号 A123 比例：1:10 Φ20mm',[{page:1,text:'图号 A123 比例：1:10 Φ20mm',source:'ocr'}],{ocrPages:1}))));}return {kill(){}};});
  const starting=indexer.start();await until(()=>!!probeCallback);const file=add('扫描图纸.pdf');await new Promise(resolve=>setTimeout(resolve,40));assert.equal(pdfCalls,0);assert.equal(indexer.status().probing,true);
  probeCallback(null,JSON.stringify({available:true,languages:['zh-Hans-CN']}));await starting;await until(()=>store.getRaw(file.id).pdf_status==='ready');assert.equal(pdfCalls,1);assert.equal(store.publicFile(store.getRaw(file.id)).pdfInfo.ocrPages,1);
});
test('少量正文但有待OCR页面时明确局限，读取页数和文字索引页数分别保留',async()=>{
  const file=add('扫描说明书.pdf');const indexer=worker(fakeRunner((args,opts,callback)=>callback(null,JSON.stringify(result('仅有页眉',[{page:1,text:'仅有页眉',source:'text',needsOcr:true}],{indexedPages:0,totalPages:5}))),false));
  await indexer.start();await until(()=>store.getRaw(file.id).pdf_status==='partial');const info=store.publicFile(store.getRaw(file.id),true).pdfInfo;assert.match(info.error,/OCR/);assert.equal(info.indexedPages,0);assert.equal(info.readPages,1);assert.equal(info.totalPages,5);assert.equal(info.pages[0].needsOcr,true);
});
test('本地Python能力缺失时保留待判断队列并说明原因，不循环创建失败任务',async()=>{
  const file=add('无运行时.pdf'),exists=fs.existsSync;let calls=0;
  fs.existsSync=target=>target===config.PYTHON?false:exists(target);
  try{const indexer=worker(()=>{calls++;throw new Error('不应启动进程');});await indexer.start();await new Promise(resolve=>setTimeout(resolve,30));const status=indexer.status();assert.equal(status.capabilities.pdfAvailable,false);assert.match(status.error,/Python/);assert.equal(status.queued,1);assert.equal(store.getRaw(file.id).pdf_kind,'pending');assert.equal(calls,0);}finally{fs.existsSync=exists;}
});
test('提取前真实路径越界时不启动Python或OCR，记录错误后不循环重试',async()=>{
  const file=add('联接边界.pdf'),realpath=fs.realpathSync;let execCalls=0;
  fs.realpathSync=target=>target===file.file?path.resolve(temp,'..','outside-synthetic.pdf'):realpath(target);
  try{
    const indexer=worker(fakeRunner((args,opts,callback)=>{execCalls++;callback(null,JSON.stringify(result('不应读取的范围外正文')));}));await indexer.start();await until(()=>store.getRaw(file.id).pdf_status==='error');await new Promise(resolve=>setTimeout(resolve,40));
    assert.equal(execCalls,0);assert.equal(indexer.status().errorCount,1);const row=store.getRaw(file.id);assert.equal(row.alive,1);assert.equal(row.content,'');assert.equal(row.pdf_kind,'pending');assert.match(row.pdf_error,/范围|真实路径/);
  }finally{fs.realpathSync=realpath;}
});
test('提取前文件失联或磁盘内容身份已变化时不启动Python，保留索引并停止该项重试',async()=>{
  const missing=add('失联.pdf'),changed=add('磁盘已变.pdf');fs.unlinkSync(missing.file);fs.writeFileSync(changed.file,'new synthetic bytes changed before extraction');let execCalls=0;
  const indexer=worker(fakeRunner((args,opts,callback)=>{execCalls++;callback(null,JSON.stringify(result('不应进入的提取')));}));await indexer.start();await until(()=>store.getRaw(missing.id).pdf_status==='error'&&store.getRaw(changed.id).pdf_status==='error');await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(execCalls,0);assert.equal(indexer.status().errorCount,2);assert.equal(store.getRaw(missing.id).alive,1);assert.match(store.getRaw(changed.id).pdf_error,/磁盘|变化|身份/);assert.equal(store.pdfPendingCount(),0);
});

test('命名跳过默认开启，仅文件名include且无exclude立即可见，关闭文字索引也不读正文或OCR',async()=>{
  assert.equal(rules.defaults().skipNamedDrawings,true);assert.throws(()=>config.validateSettings({pdf:{skipNamedDrawings:'true'}}));
  config.saveSettings({pdf:{skipNamedDrawings:true,indexText:false}});
  const named=add('甲钢架图纸.pdf'),directory=add('附页.pdf','钢架图纸'),conflict=add('合同钢架图纸.pdf');
  assert.equal(store.getRaw(named.id).pdf_status,'skipped_name');assert.equal(store.getRaw(named.id).pdf_kind,'drawing');assert.equal(store.getRaw(named.id).content,'');
  assert.equal(store.getRaw(directory.id).pdf_status,'pending');assert.equal(store.getRaw(conflict.id).pdf_status,'pending');
  const previewVersion=store.contentVersion(store.getRaw(named.id));store.setPreview(named.id,previewVersion,{text:'不应回填的预览短文',status:'ready',preview:true});assert.equal(store.getRaw(named.id).content,'');
  let calls=0;const originalRead=fs.readFileSync;fs.readFileSync=function(file,...args){if(String(file)===named.file)throw new Error('命名判断不可读PDF正文');return originalRead.call(this,file,...args);};
  try{const indexer=worker(fakeRunner(()=>{calls++;}));await indexer.start();await new Promise(resolve=>setTimeout(resolve,30));assert.equal(calls,0);assert.equal(store.search({pdfMode:'drawings'}).items[0].id,named.id);}finally{fs.readFileSync=originalRead;}
});
test('命名排除冲突和仅目录命中仍走正文索引，文件名关键词按字面匹配',async()=>{
  config.saveSettings({pdf:{skipNamedDrawings:true,includeKeywords:['图纸','a[.]']}});
  const conflict=add('合同图纸.pdf'),directory=add('另一个附页.pdf','图纸目录'),literal=add('a[.].pdf'),nonliteral=add('a..pdf');let calls=[];
  const indexer=worker(fakeRunner((args,opts,callback)=>{calls.push(args[args.indexOf('--input')+1]);callback(null,JSON.stringify(result('随附资料123')));}));await indexer.start();await until(()=>store.pdfPendingCount()===0);
  assert.deepEqual(new Set(calls),new Set([conflict.file,directory.file,nonliteral.file]));assert.equal(store.getRaw(literal.id).pdf_status,'skipped_name');assert.equal(store.getRaw(conflict.id).pdf_kind,'pending');
});
test('开启命名跳过和批量重建保留已有完整正文页证据、ready状态与人工类别',async()=>{
  const file=add('已经读取钢架.pdf'),body='图号 A-123 比例1:10 Φ20mm '+ '完整正文'.repeat(5000);index(file.id,body,[{page:1,text:body.slice(0,20000),source:'text'},{page:2,text:'第二页 R 50 30°',source:'ocr'}],{ocrPages:1});store.setPdfKind(file.id,'document');store.classify(file.id,{project:'确认项目',type:'资料',tags:['保留']});
  const before=store.publicFile(store.getRaw(file.id),true).pdfInfo;let calls=0;const indexer=worker(fakeRunner(()=>{calls++;}));await indexer.start();const old=config.getSettings(),next=config.saveSettings({pdf:{skipNamedDrawings:true}});await indexer.configure(old,next);await indexer.reindex();await new Promise(resolve=>setTimeout(resolve,30));
  const row=store.getRaw(file.id),after=store.publicFile(row,true).pdfInfo;assert.equal(row.content,body);assert.deepEqual(after.pages,before.pages);assert.deepEqual(after.dimensions,before.dimensions);assert.equal(after.status,'ready');assert.equal(after.ocrPages,1);assert.equal(after.override,'document');assert.equal(calls,0);assert.equal(store.publicFile(row).project,'确认项目');
});
test('关闭命名跳过补排已知PDF，规则更改重新考虑所有skipped且不扫描磁盘',async()=>{
  config.saveSettings({pdf:{skipNamedDrawings:true}});const files=Array.from({length:9},(_,i)=>add(`一组图纸${i}.pdf`));assert.ok(files.every(file=>store.getRaw(file.id).pdf_status==='skipped_name'));
  const old=config.getSettings(),next=config.saveSettings({pdf:{includeKeywords:['新命名词']}});store.rejudgePdfs();assert.ok(files.every(file=>store.getRaw(file.id).pdf_status==='pending'));
  config.saveSettings({pdf:{includeKeywords:old.pdf.includeKeywords}});store.rejudgePdfs();assert.ok(files.every(file=>store.getRaw(file.id).pdf_status==='skipped_name'));
  let calls=0;const indexer=worker(fakeRunner((args,opts,callback)=>{calls++;callback(null,JSON.stringify(result('图号 A123 Φ20mm 比例1:10')));}));await indexer.start();const previous=config.getSettings(),disabled=config.saveSettings({pdf:{skipNamedDrawings:false}});await indexer.configure(previous,disabled);await until(()=>files.every(file=>store.getRaw(file.id).pdf_status==='ready'));assert.equal(calls,files.length);
});
test('暂停且indexText关闭时单份补提取恢复执行，只运行force项且不被预览短文吞掉',async()=>{
  config.saveSettings({pdf:{skipNamedDrawings:true,indexText:false}});const named=add('手动钢架图纸.pdf'),other=add('普通未命名.pdf');let calls=0,callback;
  const indexer=worker(fakeRunner((args,opts,done)=>{calls++;callback=done;}));await indexer.start();indexer.cancel();await indexer.request(named.id);await until(()=>calls===1);
  assert.equal(indexer.status().cancelled,false);assert.equal(store.getRaw(named.id).pdf_force_index,1);store.setPreview(named.id,store.contentVersion(store.getRaw(named.id)),{text:'详情短文',status:'ready',preview:true});store.rejudgePdfs();assert.equal(store.getRaw(named.id).pdf_status,'pending');
  callback(null,JSON.stringify(result('完整图号 A123 Φ20mm 比例1:10')));await until(()=>store.getRaw(named.id).pdf_status==='ready');assert.equal(store.getRaw(named.id).pdf_force_index,0);assert.equal(store.getRaw(other.id).pdf_status,'pending');assert.equal(calls,1);assert.match(store.getRaw(named.id).content,/完整/);
});
test('强制请求跨内容版本、重建及设置epoch保持，旧结果不能清掉请求且worker保持单份',async()=>{
  config.saveSettings({pdf:{skipNamedDrawings:true}});const named=add('变更钢架图纸.pdf');let callbacks=[],calls=0;
  const indexer=worker(fakeRunner((args,opts,callback)=>{calls++;callbacks.push(callback);}));await indexer.start();await indexer.request(named.id);await until(()=>callbacks.length===1);
  store.upsert({...named.meta,forceInvalidate:true});assert.equal(store.getRaw(named.id).pdf_force_index,1);await indexer.reindex();const before=config.getSettings(),after=config.saveSettings({pdf:{maxPages:4}});await indexer.configure(before,after);assert.equal(calls,1);assert.equal(store.getRaw(named.id).pdf_force_index,1);
  callbacks.shift()(null,JSON.stringify(result('过时结果')));await until(()=>callbacks.length===1);assert.equal(store.getRaw(named.id).content,'');assert.equal(store.getRaw(named.id).pdf_force_index,1);
  callbacks.shift()(null,JSON.stringify(result('新版本图号 B456 Φ30mm 比例1:20')));await until(()=>store.getRaw(named.id).pdf_status==='ready');assert.equal(calls,2);assert.equal(store.getRaw(named.id).pdf_force_index,0);assert.match(store.getRaw(named.id).content,/新版本/);
});
test('单份补提取失败保留请求但不无限重试，显式再请求可成功并清除标记',async()=>{
  config.saveSettings({pdf:{skipNamedDrawings:true}});const named=add('损坏钢架图纸.pdf');let calls=0;
  const indexer=worker(fakeRunner((args,opts,callback)=>{calls++;callback(null,JSON.stringify(calls===1?{status:'error',error:'合成损坏PDF'}:result('图号 C789 Φ40mm 比例1:10')));}));await indexer.start();await indexer.request(named.id);await until(()=>store.getRaw(named.id).pdf_status==='error');await new Promise(resolve=>setTimeout(resolve,30));assert.equal(calls,1);assert.equal(store.getRaw(named.id).pdf_force_index,1);
  await indexer.request(named.id);await until(()=>store.getRaw(named.id).pdf_status==='ready');assert.equal(calls,2);assert.equal(store.getRaw(named.id).pdf_force_index,0);
});
test('补提取拒绝隔离关闭或本地Python不可用，不返回虚假排队成功',async()=>{
  config.saveSettings({pdf:{skipNamedDrawings:true}});const named=add('能力钢架图纸.pdf');const indexer=worker(fakeRunner(()=>assert.fail('不应运行PDF')));process.env.DRAWING_WORKBENCH_DISABLE_PDF_INDEX='1';
  try{await assert.rejects(()=>indexer.request(named.id),error=>error.status===503);assert.equal(store.getRaw(named.id).pdf_force_index,0);}finally{delete process.env.DRAWING_WORKBENCH_DISABLE_PDF_INDEX;}
  const exists=fs.existsSync;fs.existsSync=file=>String(file)===config.PYTHON?false:exists(file);
  try{await assert.rejects(()=>indexer.request(named.id),error=>error.status===503&&/Python/.test(error.message));assert.equal(store.getRaw(named.id).pdf_status,'skipped_name');assert.equal(store.getRaw(named.id).pdf_force_index,0);}finally{fs.existsSync=exists;}
});

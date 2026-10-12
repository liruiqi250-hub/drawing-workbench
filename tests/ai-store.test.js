'use strict';
require('node:fs').mkdirSync(require('node:path').resolve(__dirname,'../.test-tmp'),{recursive:true});
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const temporary=fs.mkdtempSync(path.join(path.resolve(__dirname,'../.test-tmp'),'ai-store-test-'));
const root=path.join(temporary,'私密用户','项目夹');fs.mkdirSync(root,{recursive:true});
process.env.DRAWING_WORKBENCH_DATA=path.join(temporary,'data');process.env.DRAWING_WORKBENCH_ROOTS=JSON.stringify([root]);
const config=require('../src/config'),store=require('../src/store'),aiStore=require('../src/ai-store');
function fixture(name){const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'fixture drawing only');const stat=fs.statSync(file),id=store.upsert({path:file,name:path.basename(file),extension:path.extname(file),size:stat.size,modified:stat.mtimeMs}).id;return store.getRaw(id);}
test.beforeEach(()=>{store.db.exec('DELETE FROM ai_suggestions;DELETE FROM files;DELETE FROM events');store.invalidateStats();});
test.after(()=>{store.close();fs.rmSync(temporary,{recursive:true,force:true});});
test('AI候选同义词OR、主题AND和项目格式待整理scope均在本机生效',()=>{
  const a=fixture('霸王龙钢架.dwg'),b=fixture('暴龙钢架.pdf');fixture('三角龙.dwg');
  store.classify(a.id,{project:'展会',type:'钢架'});
  const plan={groups:[['霸王龙','暴龙']],keywords:['钢架'],formats:[]};
  assert.equal(aiStore.candidates(plan,{},60).length,2);
  assert.deepEqual(aiStore.candidates(plan,aiStore.normalizeScope({format:'PDF',pending:true})).map(x=>x.id),[b.id]);
  assert.deepEqual(aiStore.candidates(plan,{project:'展会'}).map(x=>x.id),[a.id]);
  assert.equal(aiStore.candidates({groups:[['霸王龙'],['不存在']],keywords:[],formats:[]}).length,0);
  assert.equal(aiStore.candidates({groups:[],keywords:['霸王龙','暴龙'],formats:[]}).length,2);
  assert.equal(aiStore.candidates({groups:[['缺词1','缺词2','缺词3','缺词4','缺词5','缺词6','霸王龙']],keywords:[],formats:[]}).length,1);
  assert.equal(aiStore.candidates({groups:[['霸王龙'],['钢架'],['dwg'],['霸王龙'],['钢架'],['不存在']],keywords:[],formats:[]}).length,0);
});
test('通配字符和SQL注入按字面查，未授权范围及PDF文字开关有效',()=>{
  const a=fixture('完成100%.pdf');fixture('完成1000.pdf');
  store.setPreview(a.id,`${a.modified}-${a.size}`,{status:'ready',text:'秘密内容术语',preview:false},a.path);
  assert.deepEqual(aiStore.candidates({groups:[['%']],keywords:[],formats:[]}).map(x=>x.id),[a.id]);
  assert.equal(aiStore.candidates({groups:[['秘密内容术语']],keywords:[],formats:[]},{},60,false).length,0);
  assert.equal(aiStore.candidates({groups:[['秘密内容术语']],keywords:[],formats:[]},{},60,true).length,1);
  assert.equal(aiStore.candidates({groups:[["' OR 1=1 --"]],keywords:[],formats:[]}).length,0);
  assert.throws(()=>aiStore.candidates({groups:[],keywords:[],formats:[]}),/有效检索/);
});
test('AI元数据无绝对路径、只取末三级目录、PDF文字限2000字',()=>{
  const a=fixture('甲/乙/丙/丁/图纸.pdf');a.content='文'.repeat(3000);
  const meta=aiStore.metadataForAi(a,true);assert.equal(meta.path,undefined);assert.deepEqual(meta.folders,['乙','丙','丁']);assert.equal(meta.text.length,2000);
  assert.equal(aiStore.metadataForAi(a,false).text,undefined);
});
test('建议只入库不自动分类，确认应用写入分类并保持源字节不变',()=>{
  const a=fixture('待整理.dwg'),bytes=fs.readFileSync(a.path);
  const [s]=aiStore.saveSuggestions([{id:a.id,project:'AI项目',type:'钢架',tags:['测试'],reason:'名称依据',summary:'建议'}],new Map([[a.id,a]]));
  assert.equal(store.getRaw(a.id).classified,0);assert.equal(aiStore.listSuggestions(a.id).length,1);
  const result=aiStore.applySuggestion(s.id,{project:'人工确认项目',type:s.type,tags:s.tags});assert.equal(result.project,'人工确认项目');
  assert.equal(aiStore.listSuggestions(a.id).length,0);assert.deepEqual(fs.readFileSync(a.path),bytes);
});
test('真实文件已修改但监听尚未更新时，过期建议也拒绝应用',()=>{
  const a=fixture('改动.dwg');const [s]=aiStore.saveSuggestions([{id:a.id,project:'旧建议',tags:[]}],new Map([[a.id,a]]));
  fs.appendFileSync(a.path,'changed before watcher');assert.throws(()=>aiStore.applySuggestion(s.id,{project:'旧建议'}),error=>error.status===409);
  assert.equal(store.getRaw(a.id).classified,0);
});
test('用户分类变化、范围收窄或图纸删除后拒绝旧建议，忽略无需云调用',()=>{
  const a=fixture('分类变化.dwg');const [s]=aiStore.saveSuggestions([{id:a.id,project:'AI建议',tags:[]}],new Map([[a.id,a]]));
  store.classify(a.id,{project:'用户更新'});assert.equal(aiStore.listSuggestions(a.id)[0].status,'stale');
  assert.throws(()=>aiStore.applySuggestion(s.id,{project:'旧建议'}),error=>error.status===409);
  aiStore.dismissSuggestion(s.id);assert.equal(aiStore.listSuggestions(a.id).length,0);
});

test('AI订单日期、展会与备份范围由本机参数化执行，命名元数据不含路径',()=>{
  const order=fixture('26-10.29-03 霸王龙4米.dwg');
  fixture('26-10.30-03 霸王龙4米.dwg');
  const exhibition=fixture('郑州展会平面图 2026-03-02 14_52_26.dwg');
  const plan={groups:[['霸王龙']],keywords:[],formats:[]};
  assert.deepEqual(aiStore.candidates(plan,aiStore.normalizeScope({orderBatch:'26-10.29',projectKind:'order'})).map(row=>row.id),[order.id]);
  assert.deepEqual(aiStore.candidates({groups:[['2026-10-29']],keywords:[],formats:[]}).map(row=>row.id),[order.id]);
  assert.deepEqual(aiStore.candidates({groups:[['郑州']],keywords:[],formats:[]},aiStore.normalizeScope({projectKind:'exhibition',backup:'only'})).map(row=>row.id),[exhibition.id]);
  const meta=aiStore.metadataForAi(order);assert.equal(meta.naming.orderDate,'2026-10-29');assert.equal(meta.naming.drawingNumber,'26-10.29-03');
  assert.ok(!JSON.stringify(meta.naming).includes(root));
  assert.throws(()=>aiStore.normalizeScope({backup:'all-private'}),/无效/);
  assert.throws(()=>aiStore.normalizeScope({projectKind:"order' OR 1=1"}),/无效/);
});

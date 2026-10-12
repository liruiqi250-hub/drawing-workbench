'use strict';
const path=require('node:path');
const MODES=['drawings-pending','drawings','all','documents','pending'];
const KINDS=['auto','drawing','pending','document'];
const defaults=()=>({displayMode:'drawings-pending',indexText:true,ocrEnabled:true,skipNamedDrawings:true,maxPages:30,ocrMaxPages:10,
  includeKeywords:['图纸','钢架','总装','零件图','平面图','接线图','装配图','机械图','drawing','blueprint'],
  excludeKeywords:['合同','发票','报价单','说明书','协议','invoice','contract','manual']});
function validate(input={},base=defaults()){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('PDF 设置必须是对象。');
  const next={...defaults(),...base};
  if('displayMode' in input){if(!MODES.includes(input.displayMode))throw new Error('PDF 显示范围无效。');next.displayMode=input.displayMode;}
  for(const key of ['indexText','ocrEnabled','skipNamedDrawings'])if(key in input){if(typeof input[key]!=='boolean')throw new Error('PDF 开关必须为布尔值。');next[key]=input[key];}
  for(const [key,max] of [['maxPages',100],['ocrMaxPages',30]])if(key in input){if(!Number.isInteger(input[key])||input[key]<1||input[key]>max)throw new Error(`${key} 必须为 1–${max} 的整数。`);next[key]=input[key];}
  for(const key of ['includeKeywords','excludeKeywords'])if(key in input){
    if(!Array.isArray(input[key])||input[key].length>100||input[key].some(v=>typeof v!=='string'||!v.trim()||v.length>80||v.includes('\0')))throw new Error('PDF 关键词最多 100 项，每项为 1–80 字的字面文字。');
    next[key]=[...new Set(input[key].map(v=>v.trim()))];
  }
  return next;
}
// Normalize only explicitly written measurements: plain numbers never become dimensions.
function normalize(value){return String(value||'').normalize('NFKC').replace(/(^|[^a-zA-Z])R\s*(?=\d)/g,'$1半径').toLowerCase().replace(/[φø∅⌀]/g,'直径').replace(/直径\s*/g,'直径')
  .replace(/(\d+(?:\.\d+)?)\s*(毫米|mm|厘米|cm|米|m)(?![a-z])/g,(_,n,unit)=>`${Number((Number(n)*(/^(cm|厘米)$/.test(unit)?10:/^(m|米)$/.test(unit)?1000:1)).toFixed(6))}mm`)
  .replace(/(直径|半径)\s*(\d+(?:\.\d+)?)(?:\s*mm)?/g,(_,kind,n)=>`${kind}${Number(n)}mm`)
  .replace(/(\d+(?:\.\d+)?)\s*(?:°|度)/g,(_,n)=>`${Number(n)}°`).replace(/(\d)\s*[×x]\s*(?=\d)/g,'$1×');
}
function dimensions(text,page=0){
  const source=String(text||''),out=[],seen=new Set();
  const regex=/(?:[ΦφØø∅⌀]|直径)\s*\d+(?:\.\d+)?(?:\s*(?:毫米|mm|厘米|cm|米|m)(?![a-z]))?|\d+(?:\.\d+)?\s*(?:毫米|mm|厘米|cm|米|m)(?![a-z])/gi;
  const matches=[...source.matchAll(regex)].map(match=>match[0]);
  for(const match of source.matchAll(/(?:^|[^a-zA-Z])(R\s*\d+(?:\.\d+)?(?:\s*(?:毫米|mm|厘米|cm|米|m)(?![a-z]))?)/g))matches.push(match[1]);
  for(const match of source.matchAll(/\d+(?:\.\d+)?\s*(?:°|度)|\d+(?:\.\d+)?(?:\s*[×xX]\s*\d+(?:\.\d+)?){1,2}(?:\s*(?:毫米|mm|厘米|cm|米|m)(?![a-z]))?/g))matches.push(match[0]);
  for(const raw of matches){const normalized=normalize(raw);if(seen.has(normalized))continue;seen.add(normalized);out.push({raw,normalized,kind:normalized.startsWith('直径')?'diameter':normalized.startsWith('半径')?'radius':normalized.includes('°')?'angle':normalized.includes('×')?'rectangle':'length',page});if(out.length>=200)break;}
  return out;
}
function effective(row){return row.pdf_override&&row.pdf_override!=='auto'?row.pdf_override:(row.pdf_kind||'pending');}
function visible(row,mode=defaults().displayMode){if(row.extension!=='.pdf'||mode==='all')return true;const kind=effective(row);return mode==='drawings-pending'?kind!=='document':mode==='drawings'?kind==='drawing':mode==='documents'?kind==='document':kind==='pending';}
function visibilitySql(alias='f',mode=defaults().displayMode){
  if(!MODES.includes(mode))throw new Error('PDF 显示范围无效。');
  const kind=`CASE WHEN ${alias}.pdf_override<>'auto' THEN ${alias}.pdf_override ELSE ${alias}.pdf_kind END`;
  const condition=mode==='all'?'1=1':mode==='drawings-pending'?`${kind}<>'document'`:`${kind}='${{drawings:'drawing',documents:'document',pending:'pending'}[mode]}'`;
  return `(${alias}.extension<>'.pdf' OR (${condition}))`;
}
function namedDrawing(row,settings=defaults()){
  if(!settings.skipNamedDrawings||row.extension!=='.pdf'||row.pdf_force_index)return null;
  const name=String(row.name||'').toLowerCase(),hits=settings.includeKeywords.filter(word=>name.includes(word.toLowerCase()));
  if(!hits.length||settings.excludeKeywords.some(word=>name.includes(word.toLowerCase())))return null;
  return {kind:'drawing',reasons:[`文件名命中图纸规则：${hits.join('、')}；后续自动扫描按设置跳过正文与 OCR，可手动补提取。`]};
}
function classify(row,result,settings=defaults()){
  const name=String(row.name||'').toLowerCase(),folder=path.dirname(row.path||'').toLowerCase(),text=String(result.text||'').toLowerCase();
  const hits=(value,words)=>words.filter(word=>value.includes(word.toLowerCase()));
  const includeName=hits(name,settings.includeKeywords),includeFolder=hits(folder,settings.includeKeywords),excludeName=hits(name,settings.excludeKeywords),excludeText=hits(text,settings.excludeKeywords);
  const pages=result.pages||[],dims=pages.flatMap(page=>dimensions(page.text,page.page));
  const title=/图号|制图|审核|比例\s*[:：]|材料\s*[:：]|drawing\s*(?:no|number)|drawn\s*by|scale\s*[:：]/i.test(text);
  const drawingNumber=/(?:图号|drawing\s*(?:no\.?|number))\s*[:：]?\s*[a-z\d][a-z\d.\-_]{2,}/i.test(text)||/\d{2}[-.]\d{1,2}[.-]\d{1,2}[-.]\d{1,3}/.test(name);
  const geometry=pages.some(page=>Number(page.vectorPathCount)>20),explicitBody=hits(text,settings.includeKeywords).length>0;
  const drawing=(title&&(dims.length>0||geometry||drawingNumber))||(includeName.length>0&&(explicitBody||title||dims.length>0))||(drawingNumber&&(dims.length>0||geometry))||(includeFolder.length>0&&title&&geometry);
  // A document word in a name is only a hint. Require independent body
  // evidence before hiding a PDF, even when its name looks like a contract.
  const document=excludeText.length>=2||((excludeText.length>0||excludeName.length>0)&&/甲方|乙方|金额|税额|签章|付款|invoice\s*number|total\s*amount|payment|操作步骤|使用方法/.test(text));
  const unresolvedOcr=pages.some(page=>page.needsOcr&&page.source!=='ocr');
  const reasons=[];
  if(includeName.length)reasons.push(`文件名含图纸词：${includeName.join('、')}`);
  if(title)reasons.push('正文包含图号或标题栏字段');if(drawingNumber)reasons.push('存在图号证据');if(dims.length)reasons.push(`发现 ${dims.length} 项明确尺寸`);if(geometry)reasons.push('页面包含较多矢量路径（仅作组合证据）');
  if(excludeName.length)reasons.push(`文件名含文档词：${excludeName.join('、')}`);if(excludeText.length)reasons.push(`正文含文档词：${excludeText.join('、')}`);
  let kind='pending';
  if(!text.trim())reasons.push('没有可提取文字，保留待判断');
  else if((document||excludeName.length>0)&&(drawing||includeName.length>0||title||drawingNumber))reasons.push('图纸和普通文档证据冲突，保留待判断');
  else if(drawing)kind='drawing';
  else if(unresolvedOcr)reasons.push('关键页面仍待 OCR，当前正文不足以排除图纸，保留待判断');
  else if(document)kind='document';else reasons.push('证据不足，保留待判断');
  return {kind,reasons,dimensions:dims};
}
module.exports={MODES,KINDS,defaults,validate,normalize,dimensions,effective,visible,visibilitySql,classify,namedDrawing};

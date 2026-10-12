'use strict';

// 只解释文件名里的明确规则，不借助修改时间、目录年份或外部服务猜测订单。
function cleanText(value, maximum = 4096) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maximum) : '';
}

function validDate(year, month, day) {
  if (year < 2000 || year > 2099 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function normalizeOrderBatch(value) {
  const text=cleanText(value,80);
  const match=text.match(/^(?:(20\d{2})-(\d{1,2})-(\d{1,2})|(\d{2})-(\d{1,2})\.(\d{1,2}))([a-z]?)$/i);
  if(!match)return text;
  const year=Number(match[1]||2000+Number(match[4])),month=Number(match[2]||match[5]),day=Number(match[3]||match[6]);
  return validDate(year,month,day)?`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}${match[7].toUpperCase()}`:text;
}

function specificExhibitionName(value) {
  // “展会霸王龙”“展会样式”只说明用途；只有展会前的明确名称才作为项目名。
  const match = value.match(/^([\p{L}\p{N}][\p{L}\p{N}· .-]{0,40}?展会)(?=$|[\s_\-（(]|平面图|结构图|总图|布置图|布局图|方案图|图纸|CAD|PDF)/u);
  const result = match ? match[1].trim() : '';
  return /^(?:参加|用于|供|某某|某个|本次|此次|各种|其他|其它)展会$/.test(result) ? '' : result;
}

function parseDrawingName(name, folderNames = []) {
  const leaf = cleanText(name).split(/[\\/]/).at(-1) || '';
  const allFolders = (Array.isArray(folderNames) ? folderNames : [])
    .filter(value => typeof value === 'string').flatMap(value => value.split(/[\\/]/))
    .filter(value => value && !/^[A-Za-z]:$/.test(value)).map(value => cleanText(value, 160));
  const folders = allFolders.slice(-3);
  let baseName = leaf.replace(/\.[A-Za-z][A-Za-z0-9]{0,11}$/, '').trim();
  const result = {
    drawingNumber: '', orderBatch: '', orderBatchKey: '', orderDate: '', productionSerial: '',
    productName: '', productSize: '', projectKind: 'unknown', searchText: '', notes: [],
    isBackup: false, backupTimestamp: '', backupBasis: '', backupLabel: '', baseName: '', exhibitionName: ''
  };
  // PDF 的模型/布局后缀保留，避免把不同导出页误并；重复备份可有多层时间戳。
  const exportSuffix=baseName.match(/(-(模型|Model|Layout\d*|布局\d*))$/i)?.[0]||'';
  if(exportSuffix)baseName=baseName.slice(0,-exportSuffix.length);
  for(let depth=0;depth<8;depth++){
    const timestamp = baseName.match(/[ _-]+(20\d{2})-(\d{2})-(\d{2})[ _]+(\d{2})[-_:](\d{2})[-_:](\d{2})$/);
    if(!timestamp)break;
    const [, year, month, day, hour, minute, second] = timestamp;
    if (validDate(Number(year), Number(month), Number(day)) && Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60) {
      result.isBackup = true;
      result.backupBasis = 'timestamp';
      result.backupLabel = '备份时间戳';
      if(!result.backupTimestamp)result.backupTimestamp = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
      baseName = baseName.slice(0, timestamp.index).trim();
      if(depth===0)result.notes.push('文件名带备份时间戳，未据此判断文件过期或可删除；该时间不是下单日期。');
    }else break;
  }
  baseName+=exportSuffix;
  // 完整目录只在本机识别备份来源；展会名称依然只看末三级，发送 AI 时也不传全路径。
  if (allFolders.some(folder => /备份|^(?:dwgbak(?: files)?|modify_backup)$/i.test(folder))) {
    result.isBackup = true;
    result.backupBasis = 'directory';
    result.backupLabel = '备份来源';
    if (!result.backupTimestamp) result.notes.push('所在目录明确标记为备份，未推断备份时间。');
  }
  result.baseName = baseName;

  const normalized = baseName.replace(/[－–—]/g, '-');
  // 边界允许微信数字前缀后的下划线；不从连续数字、文件扩展名后的日期中截取两位年份。
  const dateMatch = normalized.match(/(^|[\s_（(\[【])(\d{2})-(\d{1,2})\.(\d{1,2})([A-Za-z]?)(?=$|[-\s_])/);
  let tail = normalized;
  let descriptionBeforeNumber = '';
  if (dateMatch) {
    const [, boundary, yy, month, day, batchLetter] = dateMatch;
    const year = 2000 + Number(yy);
    if (validDate(year, Number(month), Number(day))) {
      const batchStart = dateMatch.index + boundary.length;
      const batchEnd = dateMatch.index + dateMatch[0].length;
      const prefix = normalized.slice(0, dateMatch.index).replace(/[\s_\-]+$/, '');
      // 部分真实文件先写产品描述、末尾才附图号；纯数字微信前缀不能作为产品描述。
      if (/[\p{L}]/u.test(prefix) && /\d+(?:\.\d+)?\s*(?:毫米|厘米|公分|米|mm|cm|m)(?![A-Za-z])/i.test(prefix)) {
        descriptionBeforeNumber = prefix;
      }
      result.orderBatch = normalized.slice(batchStart, batchEnd);
      result.orderBatchKey = normalizeOrderBatch(result.orderBatch);
      result.orderDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      result.projectKind = 'order';
      tail = normalized.slice(batchEnd);
      const serial = tail.match(/^-([0-9]{1,6}(?:-[0-9]{1,6})*)(?=$|[\s_（(]|[\p{L}]|-(?![0-9*xX?]))/u);
      if (serial) {
        result.productionSerial = serial[1];
        result.drawingNumber = result.orderBatch + serial[0];
        tail = tail.slice(serial[0].length);
        if (result.productionSerial.includes('-')) result.notes.push('序号含追加数字段，已按原图号保留，各追加段含义待人工确认。');
      } else if (/^-?(?:\*+|[xX?]+)(?=$|[\s_\-]|[\p{Script=Han}])/u.test(tail)) {
        result.notes.push('生产单序号为占位内容，未作为真实序号。');
        tail = tail.replace(/^-?(?:\*+|[xX?]+)/, '');
      } else {
        result.notes.push('未识别明确的生产单序号。');
      }
    } else {
      result.notes.push('文件名日期不是有效日历日期，未作为下单日期。');
    }
  }

  if (descriptionBeforeNumber && !tail.replace(/[\s_\-（(【\[]/g, '')) tail = descriptionBeforeNumber;

  const exhibition = normalized.includes('展会') || folders.some(folder => folder.includes('展会'));
  if (exhibition) {
    result.projectKind = 'exhibition';
    const nameTail = tail.replace(/^[\s_\-（(【\[]+/, '');
    result.exhibitionName = specificExhibitionName(nameTail) ||
      folders.map(specificExhibitionName).filter(Boolean).at(-1) || '';
  }

  tail = tail.replace(/^[\s_\-（(【\[]+/, '');
  if (result.exhibitionName && tail.startsWith(result.exhibitionName)) tail = tail.slice(result.exhibitionName.length);
  tail = tail.replace(/^展会(?:项目|类型)?[\s_\-]*/, '').replace(/^[\s_\-]+/, '');
  const sizes = [...tail.matchAll(/(?:(?:背高|肩高|身高|高度|总长|全长|体长|翼展|长度|半身|直线)\s*)?\d+(?:\.\d+)?\s*(?:毫米|厘米|公分|米|mm|cm|m)(?![A-Za-z])/gi)];
  result.productSize = [...new Set(sizes.map(match => match[0].trim()))].join('；').slice(0, 200);
  if (sizes.length > 1 || sizes.some(match => /背高|肩高|身高|高度|翼展|半身|直线/.test(match[0]))) {
    result.notes.push('存在多个尺寸或局部尺寸描述，请人工确认各尺寸含义。');
  }
  // 有明确订单前缀，或紧跟尺寸的名称片段，才按用户的“产品名称 + 尺寸”约定解释。
  if (result.orderBatch || sizes.length || (exhibition && !result.exhibitionName)) {
    let product = (sizes.length ? tail.slice(0, sizes[0].index) : tail)
      .replace(/[-_]\s*(?:Model|Layout)\d*$/i, '')
      .replace(/[\s_\-（(【\[]+$/, '').trim()
      .replace(/(?:钢架图纸|钢架图|钢架|结构图|平面图|总图|布置图|布局图|方案图|图纸|机械图)$/, '').trim();
    if (/^[\p{L}][\p{L}\p{N}\s·-]{0,119}$/u.test(product) && !/^(?:样式|项目|类型|方案|结构|平面|总|布置|布局|机械)(?:[*?xX\d_-]*)$/.test(product)) {
      result.productName = product;
    }
  }
  if (exhibition && !result.exhibitionName) result.notes.push('仅识别到展会用途，未指定具体展会名称，归入展会项目。');

  const tokens = [result.baseName, result.drawingNumber, result.orderBatch, result.orderBatchKey, result.orderDate, result.productionSerial,
    result.productName, result.productSize, result.exhibitionName, exhibition ? '展会项目' : ''];
  if (result.orderDate) {
    const [year, month, day] = result.orderDate.split('-');
    tokens.push(`${year}年${Number(month)}月${Number(day)}日`, `${year}-${Number(month)}-${Number(day)}`,
      `${year.slice(-2)}-${Number(month)}.${Number(day)}`);
  }
  if (result.productionSerial) tokens.push(result.productionSerial.split('-').map(part => String(Number(part))).join('-'));
  result.searchText = [...new Set(tokens.filter(Boolean))].join(' ').slice(0, 4096);
  return result;
}

module.exports = {parseDrawingName,normalizeOrderBatch};

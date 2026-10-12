'use strict';
require('node:fs').mkdirSync(require('node:path').resolve(__dirname,'../.test-tmp'),{recursive:true});

const test = require('node:test');
const assert = require('node:assert/strict');
const {parseDrawingName} = require('../src/drawing-names');

test('按用户约定解析订单日期、批次、序号、产品和尺寸', () => {
  const parsed = parseDrawingName('26-10.29-01 霸王龙4米.dwg');
  assert.equal(parsed.orderDate, '2026-10-29');
  assert.equal(parsed.orderBatch, '26-10.29');
  assert.equal(parsed.drawingNumber, '26-10.29-01');
  assert.equal(parsed.productionSerial, '01');
  assert.equal(parsed.productName, '霸王龙');
  assert.equal(parsed.productSize, '4米');
  assert.equal(parsed.projectKind, 'order');
  assert.match(parsed.searchText, /2026年10月29日/);
});

test('图号序号后可直接紧挨中文产品名，单数月日不改变原批次', () => {
  const parsed = parseDrawingName('25-4.24-03轨道霸王龙10米-恐龙钢架-Model.pdf');
  assert.equal(parsed.orderDate, '2025-04-24');
  assert.equal(parsed.orderBatch, '25-4.24');
  assert.equal(parsed.drawingNumber, '25-4.24-03');
  assert.equal(parsed.productName, '轨道霸王龙');
  assert.equal(parsed.productSize, '10米');
  assert.match(parsed.searchText, /2025-4-24/);
});

test('生产序号完整保留追加数字段，不解释追加段含义', () => {
  for (const [filename, serial, product] of [
    ['23-9.9-25-02霸王龙4米.dwg', '25-02', '霸王龙'],
    ['23-5.12-5-1腕龙.dwg', '5-1', '腕龙'],
    ['23-5.12-36-3棘龙.dwg', '36-3', '棘龙']
  ]) {
    const parsed = parseDrawingName(filename);
    assert.equal(parsed.productionSerial, serial);
    assert.equal(parsed.productName, product);
    assert.match(parsed.notes.join(' '), /追加段含义待人工确认/);
  }
});

test('字母批次保持原文，避免把同日不同批次合并', () => {
  const parsed = parseDrawingName('22-10.11B-01霸王龙4米.dwg');
  assert.equal(parsed.orderBatch, '22-10.11B');
  assert.equal(parsed.orderDate, '2022-10-11');
  assert.equal(parsed.drawingNumber, '22-10.11B-01');
});

test('占位生产序号不是实际图号，已知订单日期仍可保留', () => {
  for (const serial of ['**', 'xx', '??']) {
    const parsed = parseDrawingName(`26-10.29-${serial} 霸王龙4米.dwg`);
    assert.equal(parsed.orderDate, '2026-10-29');
    assert.equal(parsed.productionSerial, '');
    assert.equal(parsed.drawingNumber, '');
    assert.equal(parsed.productName, '霸王龙');
    assert.match(parsed.notes.join(' '), /占位/);
  }
});

test('非法日期不形成订单，闰年日历校验准确', () => {
  for (const filename of ['26-2.29-01霸王龙.dwg', '26-4.31-01霸王龙.dwg', '26-0.1-01霸王龙.dwg', '26-13.1-01霸王龙.dwg']) {
    const parsed = parseDrawingName(filename);
    assert.equal(parsed.orderDate, '');
    assert.equal(parsed.orderBatch, '');
    assert.equal(parsed.projectKind, 'unknown');
    assert.match(parsed.notes.join(' '), /有效日历日期/);
  }
  assert.equal(parseDrawingName('24-2.29-01霸王龙.dwg').orderDate, '2024-02-29');
  assert.equal(parseDrawingName('00-2.29-01霸王龙.dwg').orderDate, '2000-02-29');
});

test('未知年月、完整年份附件时间、目录年月不能猜成订单日期', () => {
  for (const filename of ['xx-10.29-01霸王龙.dwg', '26-xx.29-01霸王龙.dwg', '文件.pdf-2025-07-25-15-28.dwg', '2026-10.29-01霸王龙.dwg']) {
    const parsed = parseDrawingName(filename, ['2026年', '10月订单']);
    assert.equal(parsed.orderDate, '');
    assert.equal(parsed.orderBatch, '');
  }
});

test('微信数字前缀后的明确图号可解析，连续数字中不可截取', () => {
  assert.equal(parseDrawingName('1701234567890_26-10.29-02霸王龙4米.pdf').drawingNumber, '26-10.29-02');
  assert.equal(parseDrawingName('170123456789026-10.29-02霸王龙4米.pdf').orderDate, '');
  assert.equal(parseDrawingName('文件26-10.29-02霸王龙4米.pdf').orderDate, '');
});

test('产品尺寸在前、图号在末尾的真实展会文件仍保留描述', () => {
  for (const [filename, product, size, batch, number, date] of [
    ['迅猛龙2.4米-展会样式_26-5.28-2.dwg', '迅猛龙', '2.4米', '26-5.28', '26-5.28-2', '2026-05-28'],
    ['霸王龙8米-展会样式_26-4.2-1.dwg', '霸王龙', '8米', '26-4.2', '26-4.2-1', '2026-04-02']
  ]) {
    const parsed = parseDrawingName(filename);
    assert.equal(parsed.productName, product);
    assert.equal(parsed.productSize, size);
    assert.equal(parsed.orderBatch, batch);
    assert.equal(parsed.drawingNumber, number);
    assert.equal(parsed.orderDate, date);
    assert.equal(parsed.projectKind, 'exhibition');
    assert.equal(parsed.exhibitionName, '');
  }
  const numericPrefix = parseDrawingName('1701234567890_26-5.28-2.dwg');
  assert.equal(numericPrefix.productName, '');
  assert.equal(numericPrefix.productSize, '');
});

test('展会用途优先于订单，仍保留已识别的图号日期', () => {
  const parsed = parseDrawingName('26-10.29-03展会霸王龙3米.dwg');
  assert.equal(parsed.projectKind, 'exhibition');
  assert.equal(parsed.exhibitionName, '');
  assert.equal(parsed.orderDate, '2026-10-29');
  assert.equal(parsed.drawingNumber, '26-10.29-03');
  assert.equal(parsed.productName, '霸王龙');
  assert.equal(parsed.productSize, '3米');
});

test('用户给出的通用展会文件不编造具体展会名称或产品', () => {
  const dinosaur = parseDrawingName('展会霸王龙3米.dwg');
  assert.equal(dinosaur.projectKind, 'exhibition');
  assert.equal(dinosaur.productName, '霸王龙');
  assert.equal(dinosaur.exhibitionName, '');
  const style = parseDrawingName('展会样式**.dwg');
  assert.equal(style.projectKind, 'exhibition');
  assert.equal(style.exhibitionName, '');
  assert.equal(style.productName, '');
  assert.match(style.searchText, /展会项目/);
});

test('郑州展会备份示例去除时间戳，仅提取明确展会名称', () => {
  const parsed = parseDrawingName('郑州展会平面图 2026-03-02 14_52_26.dwg');
  assert.equal(parsed.baseName, '郑州展会平面图');
  assert.equal(parsed.exhibitionName, '郑州展会');
  assert.equal(parsed.projectKind, 'exhibition');
  assert.equal(parsed.isBackup, true);
  assert.equal(parsed.backupTimestamp, '2026-03-02T14:52:26');
  assert.equal(parsed.backupBasis, 'timestamp');
  assert.equal(parsed.backupLabel, '备份时间戳');
  assert.equal(parsed.orderDate, '');
  assert.equal(parsed.productName, '');
  assert.match(parsed.notes.join(' '), /不是下单日期/);
});

test('自动备份目录单独标记来源，备份时间和订单日期同时存在但不混用', () => {
  const parsed = parseDrawingName('26-10.29-01霸王龙4米 2026-11-01 10_20_30.dwg', ['cad自动备份']);
  assert.equal(parsed.orderDate, '2026-10-29');
  assert.equal(parsed.backupTimestamp, '2026-11-01T10:20:30');
  assert.equal(parsed.backupBasis, 'directory');
  assert.equal(parsed.backupLabel, '备份来源');
  for (const folder of ['cad自动备份', '自动备份', '备份目录', 'dwgbak files', 'modify_backup']) {
    assert.equal(parseDrawingName('霸王龙4米.dwg', [folder]).isBackup, true, folder);
  }
  assert.equal(parseDrawingName('霸王龙4米.dwg', ['baking']).isBackup, false);
  const highLevel = parseDrawingName('霸王龙4米.dwg', ['D:\\cad自动备份\\E\\用户甲\\CAD图纸\\订单CAD\\2025年\\9月']);
  assert.equal(highLevel.isBackup, true);
  assert.equal(highLevel.backupBasis, 'directory');
  assert.equal(highLevel.backupTimestamp, '');
  for (const folder of ['dyys备份', '网盘备份']) assert.equal(parseDrawingName('霸王龙4米.dwg', [folder, '甲', '乙', '丙']).isBackup, true);
});

test('非法备份日期时间保留原名，不生成错误时间戳', () => {
  for (const timestamp of ['2026-02-30 14_52_26', '2026-03-02 24_00_00', '2026-03-02 14_60_26', '2026-03-02 14_52_60']) {
    const parsed = parseDrawingName(`郑州展会平面图 ${timestamp}.dwg`);
    assert.equal(parsed.isBackup, false);
    assert.equal(parsed.backupTimestamp, '');
    assert.match(parsed.baseName, /2026-/);
    assert.equal(parsed.orderDate, '');
  }
});

test('仅末三级明确展会目录参与识别，通用年月目录不作订单或展会名', () => {
  const explicit = parseDrawingName('霸王龙4米.dwg', ['E:\\订单CAD\\郑州展会\\2025年9月']);
  assert.equal(explicit.projectKind, 'exhibition');
  assert.equal(explicit.exhibitionName, '郑州展会');
  assert.equal(explicit.orderDate, '');
  const tooFar = parseDrawingName('霸王龙4米.dwg', ['郑州展会', '甲', '乙', '丙']);
  assert.equal(tooFar.projectKind, 'unknown');
  assert.equal(tooFar.exhibitionName, '');
  const generic = parseDrawingName('霸王龙4米.dwg', ['共享', '订单CAD', '2026年10月']);
  assert.equal(generic.projectKind, 'unknown');
  assert.equal(generic.orderDate, '');
});

test('多个尺寸及背高、翼展、半身、直线描述不擅自统一为总长', () => {
  for (const [filename, product, sizes] of [
    ['26-10.29-01霸王龙背高1.6米.dwg', '霸王龙', '背高1.6米'],
    ['26-10.29-01霸王龙半身3米（9米龙）.dwg', '霸王龙', '半身3米；9米'],
    ['26-10.29-01翼龙翼展2.5米直线1.8米.dwg', '翼龙', '翼展2.5米；直线1.8米']
  ]) {
    const parsed = parseDrawingName(filename);
    assert.equal(parsed.productName, product);
    assert.equal(parsed.productSize, sizes);
    assert.match(parsed.notes.join(' '), /尺寸含义/);
  }
});

test('纯函数不更改输入，空数据不造分类，字段有界', () => {
  const folders = ['订单CAD', '展会'];
  const original = [...folders];
  const first = parseDrawingName('展会霸王龙3米.dwg', folders);
  const second = parseDrawingName('展会霸王龙3米.dwg', folders);
  assert.deepEqual(first, second);
  assert.deepEqual(folders, original);
  for (const name of [null, undefined, 123, '']) {
    const parsed = parseDrawingName(name);
    assert.equal(parsed.projectKind, 'unknown');
    assert.equal(parsed.searchText, '');
  }
  const huge = parseDrawingName('字'.repeat(10000) + '.dwg');
  assert.ok(huge.baseName.length <= 4096);
  assert.ok(huge.searchText.length <= 4096);
});

'use strict';
require('node:fs').mkdirSync(require('node:path').resolve(__dirname,'../.test-tmp'),{recursive:true});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createAiService} = require('../src/ai');
const {createCredentialVault} = require('../src/credential-vault');

const work = path.resolve(__dirname,'../.test-tmp');
fs.mkdirSync(work, {recursive: true});
const temporary = fs.mkdtempSync(path.join(work, 'ai-test-'));
const python = process.env.DRAWING_WORKBENCH_PYTHON ||
  path.resolve(__dirname, '../runtime/python/python.exe');
const fixtureKey = 'sk-fixture-only-' + require('node:crypto').randomBytes(18).toString('hex');
const hasDpapi = process.platform === 'win32' && fs.existsSync(python);
let sequence = 0;
let encryptedFixture;
const baseSettings = () => ({
  extensions: ['.dwg', '.pdf', '.dxf'],
  ai: {enabled: true, model: 'deepseek-flash', sendPdfText: false, batchSize: 5, candidateLimit: 60}
});
const metadata = (id = 'f1', extra = {}) => ({
  id, name: '霸王龙钢架.dwg', folders: ['订单', '项目甲'], format: 'DWG', project: '', type: '', tags: [], ...extra
});
const plan = {groups: [['霸王龙', 'T-Rex'], ['钢架', '骨架']], keywords: ['结构'], formats: ['.dwg']};
const suggestion = (id = 'f1', extra = {}) => ({
  id, project: '项目甲', type: '钢架结构', tags: ['钢架'], reason: '文件名包含钢架，需人工确认', summary: '钢架相关图纸', ...extra
});

test.before(async () => {
  if (!hasDpapi) return;
  const vault = createCredentialVault({dataDir: path.join(temporary, 'fixture-vault'), python});
  await vault.save(fixtureKey);
  encryptedFixture = fs.readFileSync(vault.filePath);
});
test.after(() => fs.rmSync(temporary, {recursive: true, force: true}));

function service(transport, {configured = true, settings = baseSettings(), pythonPath = python} = {}) {
  const dataDir = path.join(temporary, 'case-' + (++sequence));
  fs.mkdirSync(dataDir, {recursive: true});
  if (configured && encryptedFixture) fs.writeFileSync(path.join(dataDir, 'ai-credentials.dpapi.json'), encryptedFixture);
  const ai = createAiService({getSettings: () => settings, dataDir, python: pythonPath, transport});
  return {ai, dataDir, settings};
}

function response(content, {usage, finishReason = 'stop', message = {}} = {}) {
  return new Response(JSON.stringify({
    choices: [{finish_reason: finishReason, message: {content: typeof content === 'string' ? content : JSON.stringify(content), ...message}}],
    usage: usage || {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15}
  }), {status: 200, headers: {'Content-Type': 'application/json'}});
}

function queued(...results) {
  const calls = [];
  const transport = async (url, options) => {
    calls.push({url, options, body: JSON.parse(options.body)});
    const result = results.shift();
    if (typeof result === 'function') return result(url, options);
    if (result instanceof Error) throw result;
    if (result instanceof Response) return result;
    if (result === undefined) throw new Error('Unexpected request');
    return response(result);
  };
  return {transport, calls};
}

test('无 Key 或未授权时不出网，status 不含密钥', async () => {
  let calls = 0;
  const {ai} = service(async () => { calls++; }, {configured: false});
  assert.equal(ai.status().configured, false);
  await assert.rejects(ai.search('霸王龙', () => []), /API Key/);
  await assert.rejects(ai.classify([metadata()]), /API Key/);
  await assert.rejects(ai.testConnection(), /API Key/);
  assert.equal(calls, 0);
  assert.ok(!JSON.stringify(ai.status()).includes(fixtureKey));
});

test('status 同步查配置而不解密，空 Key 保留，冲突操作拒绝', async () => {
  const {ai, dataDir} = service(async () => {}, {configured: false, pythonPath: 'missing-python-fixture'});
  fs.writeFileSync(path.join(dataDir, 'ai-credentials.dpapi.json'), '{"ciphertext":"fixture-corrupt"}');
  assert.equal(ai.status().configured, true);
  assert.equal(ai.status().keyStorage, 'windows-dpapi-current-user');
  await ai.saveCredentials({apiKey: '  '});
  assert.equal(ai.status().configured, true);
  await assert.rejects(ai.saveCredentials({apiKey: 'fixture', clearKey: true}), /不能同时/);
  await assert.rejects(ai.saveCredentials({apiKey: 123}), /文本/);
  await ai.saveCredentials({clearKey: true});
  assert.equal(ai.status().configured, false);
  assert.equal(ai.status().busy, false);
});

test('真实 DPAPI 往返、密文保存且可覆盖/清除，使用自造测试密钥', {skip: !hasDpapi}, async () => {
  const dataDir = path.join(temporary, 'vault-roundtrip');
  const vault = createCredentialVault({dataDir, python});
  assert.equal(vault.configured(), false);
  await vault.save(fixtureKey);
  const raw = fs.readFileSync(vault.filePath, 'utf8');
  assert.ok(!raw.includes(fixtureKey));
  assert.ok(!raw.includes('apiKey'));
  assert.equal(JSON.parse(raw).protection, 'windows-dpapi-current-user');
  assert.ok((await vault.read()) === fixtureKey);
  await vault.save(fixtureKey + 'replacement');
  assert.ok((await vault.read()) === fixtureKey + 'replacement');
  assert.deepEqual(fs.readdirSync(dataDir), ['ai-credentials.dpapi.json']);
  fs.writeFileSync(vault.filePath, JSON.stringify({version: 1, protection: vault.storage, ciphertext: 'ZmFrZQ=='}));
  await assert.rejects(vault.read(), /无法解密/);
  vault.clear();
  vault.clear();
  assert.equal(vault.configured(), false);
});

test('关闭 AI 拒绝检索和分类，但允许最小连接测试', {skip: !hasDpapi}, async () => {
  const mock = queued({ok: true});
  const settings = baseSettings(); settings.ai.enabled = false;
  const {ai} = service(mock.transport, {settings});
  await assert.rejects(ai.search('霸王龙', () => []), /开启/);
  await assert.rejects(ai.classify([metadata()]), /开启/);
  assert.equal(mock.calls.length, 0);
  const result = await ai.testConnection();
  assert.equal(result.ok, true);
  assert.equal(result.model, 'deepseek-flash');
  assert.ok(result.latencyMs >= 0);
  assert.deepEqual(result.usage, {requests: 1, promptTokens: 10, completionTokens: 5, totalTokens: 15});
  const call = mock.calls[0];
  assert.equal(call.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(call.options.redirect, 'error');
  assert.ok(call.options.headers.Authorization === 'Bearer ' + fixtureKey);
  assert.deepEqual(call.body.thinking, {type: 'disabled'});
  assert.deepEqual(call.body.response_format, {type: 'json_object'});
  assert.ok(!call.options.body.includes('霸王龙钢架'));
  assert.ok(!call.options.body.includes(fixtureKey));
});

test('两阶段检索等待本地候选，仅传安全元数据，并记录两次用量', {skip: !hasDpapi}, async () => {
  const mock = queued(plan, {matches: [{id: 'f1', reason: '文件名包含霸王龙钢架'}]});
  const {ai, dataDir} = service(mock.transport);
  let callbackDone = false;
  const result = await ai.search('找霸王龙钢架', async received => {
    assert.deepEqual(received, plan);
    await new Promise(resolve => setTimeout(resolve, 5));
    callbackDone = true;
    return [metadata('f1', {path: 'C:\\不可发送\\秘密.dwg', content: '不可发送的完整内容',
      folders: ['C:\\不可发送\\一层', '二层', '三层', '四层'], text: '默认不发送的PDF片段'})];
  });
  assert.equal(callbackDone, true);
  assert.deepEqual(result.matches, [{id: 'f1', reason: '文件名包含霸王龙钢架'}]);
  assert.equal(result.totalCandidates, 1);
  assert.equal(result.usage.requests, 2);
  assert.deepEqual(result.resultAdjustments, {duplicateCount: 0, unknownIdCount: 0});
  const payload = JSON.parse(mock.calls[1].body.messages[1].content);
  assert.equal(payload.maxResults, 1);
  assert.deepEqual(payload.allowedResultIds, ['f1']);
  const sent = payload.candidates[0];
  assert.deepEqual(Object.keys(sent), ['id', 'name', 'folders', 'format', 'project', 'type', 'tags', 'naming']);
  assert.deepEqual(sent.folders, ['二层', '三层', '四层']);
  assert.ok(!mock.calls[1].options.body.includes('不可发送'));
  assert.match(mock.calls[1].body.messages[0].content, /不可信/);
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'ai-usage.json'), 'utf8'));
  assert.equal(saved.requests, 2);
  assert.equal(saved.totalTokens, 30);
  assert.ok(!JSON.stringify(saved).includes('霸王龙'));
  assert.ok(!JSON.stringify(saved).includes(fixtureKey));
  const reloaded = createAiService({getSettings: baseSettings, dataDir, python, transport: mock.transport});
  assert.equal(reloaded.status().usage.totalTokens, 30);
});

test('无候选时只调用检索规划，不再付费排序', {skip: !hasDpapi}, async () => {
  const mock = queued(plan);
  const {ai} = service(mock.transport);
  const result = await ai.search('霸王龙钢架', async () => []);
  assert.deepEqual(result.matches, []);
  assert.equal(result.totalCandidates, 0);
  assert.deepEqual(result.resultAdjustments, {duplicateCount: 0, unknownIdCount: 0});
  assert.equal(mock.calls.length, 1);
});

test('AI 元数据仅采纳本机命名解析，分类提示保留人工分类且区分订单与展会', {skip: !hasDpapi}, async () => {
  const mock = queued({suggestions: [suggestion('named')]});
  const {ai} = service(mock.transport);
  await ai.classify([metadata('named', {
    name: '22-10.11B-25-02霸王龙背高1.6米.dwg', project: '用户已核对项目',
    naming: {orderDate: '2099-01-01', productName: '伪造产品'},
    folders: ['C:\\不可发路径\\订单CAD', '2022年', '10月']
  })]);
  const sent = JSON.parse(mock.calls[0].body.messages[1].content).files[0];
  assert.equal(sent.naming.orderBatch, '22-10.11B');
  assert.equal(sent.naming.orderDate, '2022-10-11');
  assert.equal(sent.naming.productionSerial, '25-02');
  assert.equal(sent.naming.productName, '霸王龙');
  assert.equal(sent.naming.productSize, '背高1.6米');
  assert.ok(!mock.calls[0].options.body.includes('伪造产品'));
  assert.ok(!mock.calls[0].options.body.includes('不可发路径'));
  const instruction = mock.calls[0].body.messages[0].content;
  assert.match(instruction, /已有非空project\/type保持原值/);
  assert.match(instruction, /exhibitionName/);
  assert.match(instruction, /不造展会名称/);
  assert.match(instruction, /通用父目录不作项目/);
});

test('AI 可见备份来源不把备份时间戳当订单日期，检索提示避免描述词漏图', {skip: !hasDpapi}, async () => {
  const mock = queued(plan, {matches: [{id: 'backup', reason: '明确郑州展会平面图'}]});
  await service(mock.transport).ai.search('找郑州展会平面图', () => [metadata('backup', {
    name: '郑州展会平面图 2026-03-02 14_52_26.dwg', folders: ['cad自动备份']
  })]);
  const sent = JSON.parse(mock.calls[1].body.messages[1].content).candidates[0];
  assert.equal(sent.naming.projectKind, 'exhibition');
  assert.equal(sent.naming.exhibitionName, '郑州展会');
  assert.equal(sent.naming.orderDate, '');
  assert.equal(sent.naming.backupTimestamp, '2026-03-02T14:52:26');
  assert.equal(sent.naming.backupBasis, 'directory');
  assert.match(mock.calls[0].body.messages[0].content, /描述性词优先放keywords/);
  assert.match(mock.calls[0].body.messages[0].content, /ISO日期2026-10-29/);
  assert.match(mock.calls[1].body.messages[0].content, /备份时间戳不是下单日期/);
});

test('AI 保留本机确认的高层目录备份来源，仅复制备份白名单字段', {skip: !hasDpapi}, async () => {
  const mock = queued({suggestions: [suggestion()]});
  await service(mock.transport).ai.classify([metadata('f1', {
    folders: ['订单CAD', '2025年', '9月'],
    naming: {isBackup: true, backupBasis: 'directory', backupTimestamp: '',
      privateFolder: '绝不能发送的高层目录', orderDate: '2099-01-01', productName: '伪造产品'}
  })]);
  const sent = JSON.parse(mock.calls[0].body.messages[1].content).files[0];
  assert.equal(sent.naming.isBackup, true);
  assert.equal(sent.naming.backupBasis, 'directory');
  assert.equal(sent.naming.backupLabel, '备份来源');
  assert.equal(sent.naming.orderDate, '');
  assert.ok(!mock.calls[0].options.body.includes('绝不能发送的高层目录'));
  assert.ok(!mock.calls[0].options.body.includes('伪造产品'));
  const invalid = queued({suggestions: [suggestion()]});
  await service(invalid.transport).ai.classify([metadata('f1', {
    naming: {isBackup: true, backupBasis: 'timestamp', backupTimestamp: '2026-02-30T14:52:26'}
  })]);
  const invalidSent = JSON.parse(invalid.calls[0].body.messages[1].content).files[0];
  assert.equal(invalidSent.naming.isBackup, false);
  assert.equal(invalidSent.naming.backupTimestamp, '');
});

test('单并发 busy 保护，任务结束后恢复且拒绝过程中修改密钥', {skip: !hasDpapi}, async () => {
  let release;
  let entered;
  const inTransport = new Promise(resolve => { entered = resolve; });
  const {ai} = service(async () => {
    entered();
    return new Promise(resolve => { release = () => resolve(response({ok: true})); });
  });
  const pending = ai.testConnection();
  await inTransport;
  assert.equal(ai.status().busy, true);
  for (const operation of [() => ai.testConnection(), () => ai.search('霸王龙', () => []),
    () => ai.classify([metadata()]), () => ai.saveCredentials({clearKey: true})]) {
    await assert.rejects(operation(), error => error.statusCode === 409 && /正在进行/.test(error.message));
  }
  release();
  await pending;
  assert.equal(ai.status().busy, false);
});

test('搜索重复结果超过候选数时保留首次有效排名和依据，不自动重试', {skip: !hasDpapi}, async () => {
  const mock = queued(plan, {matches: [
    {id: 'f1', reason: '首次依据'}, {id: 'f1', reason: '重复依据'}, {id: 'f1', reason: '再次重复'}
  ]});
  const {ai} = service(mock.transport);
  const result = await ai.search('霸王龙', () => [metadata()]);
  assert.deepEqual(result.matches, [{id: 'f1', reason: '首次依据'}]);
  assert.deepEqual(result.resultAdjustments, {duplicateCount: 2, unknownIdCount: 0});
  assert.equal(mock.calls.length, 2);
  assert.deepEqual(result.usage, {requests: 2, promptTokens: 20, completionTokens: 10, totalTokens: 30});
});

test('搜索混合超量结果仅保留候选代表ID，去重计数按丢弃记录且保留首次有效顺序', {skip: !hasDpapi}, async () => {
  const mock = queued(plan, {matches: [
    {id: 'backup', reason: '证据版本不能当结果'},
    {id: 'f2', reason: '第二候选首次依据'},
    {id: 'f2', reason: '第二候选重复依据'},
    {id: 'forged', reason: '不存在'},
    {id: 'backup', reason: '重复未知证据版本'},
    {id: 'f1', reason: '第一候选首次依据'},
    {id: 'f1', reason: '第一候选重复依据'}
  ]});
  const {ai, dataDir} = service(mock.transport);
  const result = await ai.search('霸王龙', () => [metadata('f1', {
    evidence: [{...metadata('backup'), fileId: 'backup', matches: []}]
  }), metadata('f2')]);
  assert.deepEqual(result.matches, [
    {id: 'f2', reason: '第二候选首次依据'}, {id: 'f1', reason: '第一候选首次依据'}
  ]);
  assert.deepEqual(result.resultAdjustments, {duplicateCount: 2, unknownIdCount: 3});
  assert.equal(result.matches.length, result.totalCandidates);
  assert.equal(mock.calls.length, 2);
  assert.deepEqual(result.usage, {requests: 2, promptTokens: 20, completionTokens: 10, totalTokens: 30});
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'ai-usage.json'), 'utf8')).requests, 2);
  assert.equal(ai.status().busy, false);
  const payload = JSON.parse(mock.calls[1].body.messages[1].content);
  assert.equal(payload.maxResults, 2);
  assert.deepEqual(payload.allowedResultIds, ['f1', 'f2']);
  assert.equal(payload.candidates[0].evidence[0].fileId, 'backup');
  assert.match(mock.calls[1].body.messages[0].content, /只能使用candidates\.id/);
  assert.match(mock.calls[1].body.messages[0].content, /evidence\.fileId只作证据/);
});

test('搜索非空结果全部未知时明确拒绝，合法空数组正常返回空结果', {skip: !hasDpapi}, async () => {
  const invalid = queued(plan, {matches: [{id: 'forged', reason: '甲'}, {id: 'forged', reason: '乙'}]});
  const {ai} = service(invalid.transport);
  await assert.rejects(ai.search('霸王龙', () => [metadata()]), /没有有效候选 ID/);
  assert.equal(invalid.calls.length, 2);
  assert.equal(ai.status().usage.requests, 2);
  assert.equal(ai.status().busy, false);
  const empty = queued(plan, {matches: []});
  const result = await service(empty.transport).ai.search('霸王龙', () => [metadata()]);
  assert.deepEqual(result.matches, []);
  assert.deepEqual(result.resultAdjustments, {duplicateCount: 0, unknownIdCount: 0});
  assert.equal(result.totalCandidates, 1);
  assert.equal(result.usage.requests, 2);
  assert.equal(empty.calls.length, 2);
});

test('搜索严格拒绝坏schema、越界字符串和额外工具字段，未知或重复记录也先验格式', {skip: !hasDpapi}, async () => {
  const good = {id: 'f1', reason: '有效依据'};
  for (const ranked of [
    {}, {matches: null}, {matches: {}}, {matches: [null]}, {matches: [[]]},
    {matches: [{id: 'f1'}]}, {matches: [{reason: '依据'}]},
    ...[123, '', ' ', 'x'.repeat(101), 'f1\u0000'].map(id => ({matches: [{id, reason: '依据'}]})),
    ...[123, '', ' ', '字'.repeat(301), '坏\u0007依据'].map(reason => ({matches: [good, {id: 'f1', reason}]})),
    {matches: [good, {id: 'forged', reason: ''}]},
    {matches: [good, {id: 'f1', reason: '重复', function_call: {name: 'exec'}}]},
    {matches: [good, {id: 'forged', reason: '未知', tool_calls: []}]},
    {matches: [good], function_call: {name: 'exec'}},
    {matches: [good], tool_calls: []}
  ]) {
    const mock = queued(plan, ranked);
    const {ai} = service(mock.transport);
    await assert.rejects(ai.search('霸王龙', () => [metadata(), metadata('f2')]), /限制|格式|数组/);
    assert.equal(mock.calls.length, 2);
    assert.equal(ai.status().usage.requests, 2);
    assert.equal(ai.status().busy, false);
  }
});

test('分类仅返回输入 ID 和有界字段，PDF 文本需授权且限制 2000 字', {skip: !hasDpapi}, async () => {
  const mock = queued({suggestions: [suggestion('pdf1')]});
  const settings = baseSettings(); settings.ai.sendPdfText = true;
  const {ai} = service(mock.transport, {settings});
  const result = await ai.classify([metadata('pdf1', {format: '.pdf', text: '字'.repeat(2100),
    originalFile: '不能上传原图', image: '不能上传图片', path: 'D:\\原文件.pdf'})]);
  assert.deepEqual(result.suggestions, [suggestion('pdf1')]);
  const sent = JSON.parse(mock.calls[0].body.messages[1].content).files[0];
  assert.equal(sent.text.length, 2000);
  assert.ok(!mock.calls[0].options.body.includes('不能上传'));
  assert.ok(!('path' in sent));
  const dwgMock = queued({suggestions: [suggestion()]});
  await service(dwgMock.transport, {settings}).ai.classify([metadata('f1', {text: 'CAD不得发送的文字'})]);
  assert.ok(!dwgMock.calls[0].options.body.includes('CAD不得发送'));
});

test('分类拒绝伪造ID、重复ID、未知字段和超长文本', {skip: !hasDpapi}, async () => {
  const invalid = [suggestion('forged'), suggestion('f1', {reason: '字'.repeat(301)}),
    suggestion('f1', {tags: Array(21).fill('标签')}), suggestion('f1', {function_call: 'exec'})];
  for (const item of invalid) {
    const mock = queued({suggestions: [item]});
    const {ai} = service(mock.transport);
    await assert.rejects(ai.classify([metadata()]), /ID|限制|格式/);
  }
  const mock = queued({suggestions: [suggestion(), suggestion()]});
  await assert.rejects(service(mock.transport).ai.classify([metadata(), metadata('f2')]), /ID/);
});

test('连接坏JSON、空输出、截断、任意工具调用会拒绝，返回错误脱敏', {skip: !hasDpapi}, async () => {
  const cases = [
    new Response('not json ' + fixtureKey),
    response('{broken ' + fixtureKey),
    response('  '),
    response({ok: true}, {finishReason: 'length'}),
    response({ok: true}, {message: {tool_calls: [{function: {name: 'exec', arguments: fixtureKey}}]}}),
    Object.assign(new Error('proxy error ' + fixtureKey), {statusCode: 502}),
    new Response('private response ' + fixtureKey, {status: 401})
  ];
  for (const result of cases) {
    const mock = queued(result);
    const {ai} = service(mock.transport);
    await assert.rejects(ai.testConnection(), error => {
      assert.ok(!error.message.includes(fixtureKey));
      assert.ok(!error.message.includes('private response'));
      assert.match(error.message, /JSON|空结果|截断|工具调用|无法连接|API Key/);
      return true;
    });
    assert.equal(mock.calls.length, 1);
    assert.equal(ai.status().busy, false);
  }
});

test('请求 HTTP 错误中文分类且不自动重试', {skip: !hasDpapi}, async () => {
  for (const [code, expected] of [[402, /余额不足/], [404, /模型/], [422, /参数/], [429, /频繁/], [503, /繁忙/]]) {
    const mock = queued(new Response('private ' + fixtureKey, {status: code}));
    const {ai} = service(mock.transport);
    await assert.rejects(ai.testConnection(), expected);
    assert.equal(mock.calls.length, 1);
  }
});

test('响应最大 1MiB 限制、超时异常分类和安全用量累计', {skip: !hasDpapi}, async () => {
  const tooLarge = queued(new Response('x'.repeat(1024 * 1024 + 1)));
  const oversized = service(tooLarge.transport);
  await assert.rejects(oversized.ai.testConnection(), /1 MiB/);
  const abort = new Error('abort ' + fixtureKey); abort.name = 'AbortError';
  const timed = service(queued(abort).transport);
  await assert.rejects(timed.ai.testConnection(), error => error.statusCode === 504 && /超时/.test(error.message));
  const badContent = service(queued(response('not json')).transport);
  await assert.rejects(badContent.ai.testConnection(), /JSON/);
  assert.equal(badContent.ai.status().usage.totalTokens, 15);
  assert.equal(badContent.ai.status().usage.requests, 1);
});

test('检索计划字段严格限制，坏计划不进入本地候选或第二次出网', {skip: !hasDpapi}, async () => {
  for (const invalid of [
    {...plan, groups: Array(9).fill(['词'])},
    {...plan, keywords: ['词'.repeat(61)]},
    {...plan, formats: ['.exe']},
    {...plan, function_call: 'exec'},
    {groups: [], keywords: [], formats: []}
  ]) {
    const mock = queued(invalid);
    const {ai} = service(mock.transport);
    let candidateCalls = 0;
    await assert.rejects(ai.search('霸王龙', () => { candidateCalls++; return []; }), /限制|格式|检索词|分组/);
    assert.equal(candidateCalls, 0);
    assert.equal(mock.calls.length, 1);
  }
});

test('本地损坏凭证不出网，模型可配置但 endpoint 固定', {skip: !hasDpapi}, async () => {
  const mock = queued({ok: true});
  const {ai, dataDir, settings} = service(mock.transport);
  fs.writeFileSync(path.join(dataDir, 'ai-credentials.dpapi.json'), '{}');
  await assert.rejects(ai.testConnection(), /密钥文件/);
  assert.equal(mock.calls.length, 0);
  await ai.saveCredentials({apiKey: fixtureKey});
  assert.equal(ai.status().busy, false);
  settings.ai.model = 'deepseek-v4-pro';
  settings.ai.baseUrl = 'https://evil-fixture.invalid';
  await ai.testConnection();
  assert.equal(mock.calls[0].body.model, 'deepseek-v4-pro');
  assert.equal(mock.calls[0].url, 'https://api.deepseek.com/chat/completions');
});

test('真实AI请求载荷保留备份命中证据，去掉本地快照与绝对路径并遵守PDF开关',{skip:!hasDpapi},async()=>{
  for(const sendPdfText of [false,true]){
    const mock=queued(plan,{matches:[{id:'original',reason:'备份标签命中专用转向关节'}]}),settings=baseSettings();settings.ai.sendPdfText=sendPdfText;
    const candidate=metadata('original',{name:'机械原图.dwg',evidence:[{...metadata('backup',{name:'机械原图 2026-10-12 10_30_00.pdf',format:'PDF',tags:['专用转向关节'],text:'PDF证据'}),fileId:'backup',isBackup:true,path:'X:\\private\\backup.pdf',sourceStamp:'local-private-stamp',matches:[{field:'tags',terms:['专用转向关节'],snippet:'专用转向关节'},{field:'text',terms:['PDF'],snippet:'PDF证据'}]}]});
    await service(mock.transport,{settings}).ai.search('找专用转向关节',()=>[candidate]);
    const payload=JSON.parse(mock.calls[1].body.messages[1].content),evidence=payload.candidates[0].evidence[0];
    assert.equal(evidence.fileId,'backup');assert.equal(evidence.isBackup,true);assert.ok(evidence.matches.some(v=>v.field==='tags'));
    assert.equal(evidence.path,undefined);assert.equal(evidence.sourceStamp,undefined);
    assert.equal(evidence.text,sendPdfText?'PDF证据':undefined);assert.equal(evidence.matches.some(v=>v.field==='text'),sendPdfText);
    assert.ok(!JSON.stringify(payload).includes('private'));assert.match(payload.evidenceGuide,/实际命中/);
  }
});

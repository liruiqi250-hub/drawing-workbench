(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const state = {
    scope: { kind: 'all', value: '' }, query: '', format: '', sort: 'modified', pdfMode: '', pdfBusy: false,
    page: 1, limit: 50, total: 0, items: [], selectedId: null, selectedFile: null, grouped:true,matchingFiles:0,versionsOpen:new Set(),
    status: null, settings: null, settingsOpen: false, settingsDirty: false,
    settingsLoading: false, settingsSaving: false, filesLoading: false,
    fileRequest: 0, detailRequest: 0, filesSignature: '', navSignature: '',
    drafts: new Map(), errors: new Map(), searchTimer: null, toastTimer: null,
    lastResultRefresh: 0, pollBusy: false, scanBusy: false,
    mode: 'keyword', aiSettings: null, aiStatus: {}, aiDirty: false,
    aiSettingsLoading: false, aiSettingsSaving: false, aiTask: '', aiSearchRevision: 0,
    aiSearchResult: null, aiSearchStale: false, aiDialogRequest: 0,
    aiSuggestions: [], aiSuggestionDrafts: new Map(), aiLastIds: [], aiDialogLoading: false,
    rulesPreview:null,rulesSelections:new Map(),rulesBusy:false,rulesPage:1,rulesApplied:false
  };

  function el(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined && value !== null) node.textContent = String(value);
    return node;
  }

  function actionButton(label, handler, className = '') {
    const button = el('button', className, label);
    button.type = 'button';
    button.addEventListener('click', handler);
    return button;
  }

  async function api(path, options = {}) {
    const method = options.method || 'GET';
    const headers = { Accept: 'application/json', ...options.headers };
    if (method !== 'GET') headers['X-Requested-With'] = 'DrawingWorkbench';
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    const controller = new AbortController();
    const isAiCall = method === 'POST' && /^\/api\/ai\/(?:search|classify|test)$/.test(path);
    const timeout = setTimeout(() => controller.abort(), isAiCall ? 100000 : 20000);
    try {
      response = await fetch(path, {
        ...options, method, headers, cache: 'no-store', signal: controller.signal,
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
      });
    } catch (error) {
      if (error.name === 'AbortError') throw new Error(isAiCall ? 'AI 请求等待超过 100 秒。可手动重试；分类建议请先重新打开查看是否已保存。' : '本机服务响应超时，请稍后重试。');
      throw new Error('无法连接本机服务，请确认图纸工作台服务仍在运行。');
    } finally { clearTimeout(timeout); }
    let payload;
    try { payload = await response.json(); } catch (_) {
      throw new Error(response.ok ? '本机服务返回了无法读取的数据。' : `请求失败（${response.status}），请稍后重试。`);
    }
    if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）。`);
    return payload;
  }

  function errorFor(scope, message) {
    if (message) state.errors.set(scope, message); else state.errors.delete(scope);
    const banner = $('error-banner');
    banner.replaceChildren(...[...new Set(state.errors.values())].map(value => el('p', '', value)));
    banner.hidden = !state.errors.size;
  }

  function notice(message, failure = false) {
    $('feedback').textContent = message;
    $('feedback').style.color = failure ? 'var(--danger)' : '';
    const toast = $('toast');
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { toast.hidden = true; }, failure ? 6500 : 4200);
  }

  function number(value) { return Number(value || 0).toLocaleString('zh-CN'); }
  function formatOf(file) { return String(file.extension || '').replace(/^\./, '').toUpperCase() || '文件'; }
  function formattedDate(value, short = false) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('zh-CN', short
      ? { year: 'numeric', month: '2-digit', day: '2-digit' }
      : { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function bytes(value) {
    const size = Number(value);
    if (!Number.isFinite(size)) return '—';
    if (size < 1024) return `${number(size)} B`;
    if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
    if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
    return `${(size / 1024 ** 3).toFixed(2)} GB`;
  }
  function unclassified(value) { return !value || ['待确认', '待整理', '未分类', '未设置'].includes(value); }
  function pending(file) {
    return typeof file.classified === 'boolean' ? !file.classified : unclassified(file.project) || unclassified(file.type);
  }
  function scopeTitle() {
    if (state.scope.kind === 'projectKind') return state.scope.value === 'order' ? '订单图纸' : '展会项目';
    if (state.scope.kind === 'backup') return '含备份的图纸';
    return ({ all: '全部图纸', pending: '待整理', project: '项目：', type: '类型：', format: '格式：', orderBatch: '图号订单：' }[state.scope.kind] || '全部图纸') +
      (['project', 'type', 'format', 'orderBatch'].includes(state.scope.kind) ? state.scope.value : '');
  }
  function backupLabel(naming) {
    return naming.backupBasis === 'timestamp' ? '疑似备份 · 时间戳' : '备份来源';
  }
  function backupTime(value) {
    if (!value) return '待确认';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
  }
  function contentLabel(file) {
    if (formatOf(file) === 'DWG') return '仅名称与路径，不提取 DWG 正文';
    const status = String(file.contentStatus || '');
    const labels = {
      pending: '等待提取', queued: '等待提取', extracting: '正在提取',
      ready: '已提取文字', extracted: '已提取文字', indexed: '已提取文字',
      skipped_name: '文件名命中规则，已跳过正文',
      empty: '无可提取文字', scanned: '扫描件，尚未 OCR', unsupported: '暂不支持文字提取',
      error: '文字提取失败', failed: '文字提取失败', unavailable: '暂无文字内容',
      metadata: '已索引名称与路径', filename_only: '已索引名称与路径',
      not_supported: '暂不支持文字提取', no_text: '无可提取文字', missing: '原文件不存在'
    };
    return labels[status] || status || '已索引名称与路径';
  }

  function updateActiveNavigation() {
    document.querySelectorAll('[data-scope-kind]').forEach(button => {
      const active = button.dataset.scopeKind === state.scope.kind &&
        (button.dataset.scopeValue || '') === state.scope.value;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    $('scope-title').textContent = scopeTitle();
    $('search-note').textContent = state.mode === 'ai'
      ? `搜索范围：${scopeTitle()}${state.format ? ` · ${state.format}` : ''} · 只有点击“AI 搜索”才会调用 DeepSeek`
      : `搜索范围：${scopeTitle()} · 关键词匹配本机索引`;
  }

  function renderNavigation(stats) {
    $('all-count').textContent = number(stats.total);
    $('pending-count').textContent = number(stats.pending);
    const projectKinds = Array.isArray(stats.projectKinds) ? stats.projectKinds : [];
    $('order-count').textContent = number(projectKinds.find(group => group.name === 'order')?.count);
    $('exhibition-count').textContent = number(projectKinds.find(group => group.name === 'exhibition')?.count);
    $('backup-count').textContent = number(stats.backupCount);
    const signature = JSON.stringify([stats.projects, stats.types, stats.formats, stats.orderBatches]);
    if (signature !== state.navSignature) {
      state.navSignature = signature;
      [['orderBatch', stats.orderBatches], ['project', stats.projects], ['type', stats.types], ['format', stats.formats]].forEach(([kind, groups]) => {
        const nav = $(`${kind}-nav`);
        const list = Array.isArray(groups) ? (kind === 'orderBatch' ? groups.slice(0, 100) : groups) : [];
        nav.replaceChildren(...list.map(group => {
          const name = String(group.name || '未分类');
          const button = actionButton('', () => changeScope(kind, name));
          button.dataset.scopeKind = kind;
          button.dataset.scopeValue = name;
          button.append(el('span', '', name), el('span', 'count', number(group.count)));
          return button;
        }));
        if (!list.length) nav.append(el('div', 'nav-empty', kind === 'orderBatch' ? '暂无识别到的订单' : '暂无分类'));
      });
      const formatValue = state.format;
      const options = [el('option', '', '全部格式')];
      options[0].value = '';
      (stats.formats || []).forEach(group => {
        const option = el('option', '', String(group.name));
        option.value = String(group.name);
        options.push(option);
      });
      if (formatValue && !options.some(option => option.value === formatValue)) {
        const option = el('option', '', formatValue); option.value = formatValue; options.push(option);
      }
      $('format-filter').replaceChildren(...options);
      $('format-filter').value = formatValue;
    }
    updateActiveNavigation();
  }

  function renderStatus(status) {
    const indexing = status.indexing || {};
    const stats = status.stats || {};
    const connection = $('connection-status');
    connection.className = `connection connected${indexing.running ? ' scanning' : ''}`;
    connection.lastElementChild.textContent = indexing.running ? '本机已连接 · 扫描中' : '本机服务已连接';
    $('app-version').textContent = `V${String(status.version || '0.5.2').replace(/^v/i, '')}`;
    if (status.ai) state.aiStatus = { ...state.aiStatus, ...status.ai };
    renderAiControls();
    renderNavigation(stats);
    $('library-summary').textContent=`默认范围 ${number(stats.groupTotal)} 组 · ${number(stats.physicalTotal)} 个文件 · 索引保留 ${number(stats.indexedPhysicalTotal ?? stats.physicalTotal)} 个原始文件`;
    $('index-banner').hidden = !indexing.running;
    $('index-title').textContent = '正在扫描图纸';
    $('index-summary').textContent = `已检查 ${number(indexing.scanned)} 项 · 发现 ${number(indexing.found)} 份 · 错误 ${number(indexing.errors)}`;
    $('index-root').textContent = indexing.currentRoot ? `当前扫描：${indexing.currentRoot}` : '正在准备扫描目录…';
    const watching = Array.isArray(indexing.watching) ? indexing.watching : [];
    const watchEnabled = status.settings?.watch;
    $('watch-summary').textContent = watchEnabled ? `实时监听 ${number(watching.length)} 个扫描位置` : '实时监听已关闭';
    $('scan-button').disabled = Boolean(indexing.running || state.scanBusy);
    $('scan-button').textContent = indexing.running ? '扫描中…' : '重新扫描';
    $('settings-scan').disabled = Boolean(indexing.running || state.scanBusy);
    $('settings-scan').textContent = indexing.running ? '扫描中…' : '重新扫描';
    renderMaintenance(status);
    renderPdfStatus(status);
  }

  function renderMaintenance(status) {
    const index = status.indexing || {};
    $('setting-version').textContent = `V${String(status.version || '0.5.2').replace(/^v/i, '')}`;
    $('setting-engine').textContent = status.engine || '—';
    $('setting-total').textContent = `默认范围 ${number(status.stats?.groupTotal)} 组 · ${number(status.stats?.physicalTotal)} 个可见文件 · 索引保留 ${number(status.stats?.indexedPhysicalTotal ?? status.stats?.physicalTotal)} 个原始文件`;
    $('grouping-summary').textContent = `默认范围 ${number(status.stats?.groupTotal)} 组、${number(status.stats?.physicalTotal)} 个文件，索引保留 ${number(status.stats?.indexedPhysicalTotal ?? status.stats?.physicalTotal)} 个原始文件。可见文件中 ${number(status.stats?.backupFileCount)} 个标有备份来源或时间戳。`;
    $('setting-index-status').textContent = index.running
      ? `扫描中，检查 ${number(index.scanned)} 项，发现 ${number(index.found)} 份，错误 ${number(index.errors)}`
      : `未在扫描，最近扫描错误 ${number(index.errors)}`;
    $('setting-last-scan').textContent = formattedDate(index.finishedAt);
    $('setting-watching').textContent = (index.watching || []).join('；') || (status.settings?.watch ? '等待目录监听建立' : '实时监听已关闭');
    const watchErrors = (index.watchErrors || []).map(value => typeof value === 'string' ? value : [value.root || value.path || '', value.error || value.message || '监听失败'].filter(Boolean).join('：'));
    $('watch-errors').textContent = watchErrors.length ? `监听提示：${watchErrors.join('；')}` : '';
    $('watch-errors').hidden = !watchErrors.length;
    const scanErrors = (index.errorSamples || []).slice(0, 30).map(value => {
      if (typeof value === 'string') return value;
      const code = String(value.message || value.error || '扫描失败');
      const reason = { EPERM: '权限不足', EACCES: '权限不足', ENOENT: '位置不存在或已离线', ENOTDIR: '路径不是文件夹', EBUSY: '文件或目录正被占用' }[code] || code;
      return [value.path || value.root || '', reason].filter(Boolean).join('：');
    });
    $('scan-errors').replaceChildren();
    if (scanErrors.length) {
      $('scan-errors').append(el('strong', '', '未能完成扫描的位置（最多显示 30 项）'));
      scanErrors.forEach(message => $('scan-errors').append(el('div', '', message)));
    }
    $('scan-errors').hidden = !scanErrors.length;
  }

  async function refreshStatus() {
    try {
      const result = await api('/api/status');
      const firstLoad = !state.status;
      state.status = result;
      if (firstLoad && result.settings?.pageSize) state.limit = Number(result.settings.pageSize);
      if (!state.pdfMode) { state.pdfMode = result.settings?.pdf?.displayMode || 'drawings-pending'; $('pdf-mode').value = state.pdfMode; if (['documents','pending'].includes(state.pdfMode)) { state.format='PDF'; $('format-filter').value='PDF'; } }
      renderStatus(result);
      errorFor('status', '');
      return result;
    } catch (error) {
      $('connection-status').className = 'connection disconnected';
      $('connection-status').lastElementChild.textContent = '本机服务连接中断';
      errorFor('status', error.message);
      return null;
    }
  }

  function changeScope(kind, value = '') {
    state.scope = { kind, value };
    state.page = 1;
    if (kind === 'format') { state.format = ''; $('format-filter').value = ''; }
    updateActiveNavigation();
    if (state.mode === 'ai') invalidateAiSearch('搜索范围已变化，请点击“AI 搜索”按新范围查找。');
    else loadFiles();
  }

  function fileQuery() {
    const params = new URLSearchParams({ q: state.query, sort: state.sort, page: String(state.page), limit: String(state.limit) });
    if (state.scope.kind === 'pending') params.set('pending', '1');
    if (state.scope.kind === 'project') params.set('project', state.scope.value);
    if (state.scope.kind === 'type') params.set('type', state.scope.value);
    if (state.scope.kind === 'orderBatch') params.set('orderBatch', state.scope.value);
    if (state.scope.kind === 'projectKind') params.set('projectKind', state.scope.value);
    if (state.scope.kind === 'backup') params.set('backup', state.scope.value);
    const format = state.format || (state.scope.kind === 'format' ? state.scope.value : '');
    if (format) params.set('format', format);
    if (state.pdfMode) params.set('pdfMode', state.pdfMode);
    return params;
  }

  function clearSelection(message='当前结果没有选中的图纸') {
    if(state.selectedId&&state.drafts.get(state.selectedId)?.dirty)notice('未保存的分类草稿已保留；重新打开原图可继续编辑。');
    ++state.detailRequest;state.selectedId=null;state.selectedFile=null;
    errorFor('detail','');errorFor('action','');
    $('detail').replaceChildren(el('div','detail-top','图纸详情'),el('div','detail-empty',message));
  }
  function reconcileSelection() {
    const current=state.selectedFile;
    const present=state.items.some(file=>file.id===state.selectedId||(state.grouped&&current?.group?.id&&file.group?.id===current.group.id&&file.classification?.variants?.some(member=>member.fileId===state.selectedId)));
    if(!present){clearSelection(state.items.length?'选择当前结果中的图纸':'当前搜索没有匹配图纸');if(state.items.length)selectFile(state.items[0].id);}
    else refreshSelectedDetail();
  }
  async function loadFiles({ quiet = false } = {}) {
    if (state.mode !== 'keyword') return;
    const request = ++state.fileRequest;
    const query = fileQuery();
    state.filesLoading = true;
    renderAiControls();
    if (!quiet) {
      clearSelection('正在按当前搜索条件更新图纸…');
      $('result-count').textContent = '正在搜索…';
      $('results').setAttribute('aria-busy', 'true');
    }
    try {
      const data = await api(`/api/files?${query}`);
      if (request !== state.fileRequest || state.mode !== 'keyword') return;
      state.items = Array.isArray(data.items) ? data.items : [];
      state.total = Number(data.total || 0);
      state.grouped = Boolean(data.grouped); state.matchingFiles=Number(data.matchingFiles||0);
      state.page = Number(data.page || state.page);
      state.limit = Number(data.limit || state.limit);
      const maxPage = Math.max(1, Math.ceil(state.total / state.limit));
      if (state.page > maxPage) { state.page = maxPage; loadFiles(); return; }
      const signature = JSON.stringify([state.items, state.total, state.page, state.limit]);
      if (signature !== state.filesSignature || !quiet) {
        state.filesSignature = signature;
        renderResults();
        reconcileSelection();
      } else renderPageSummary();
      state.lastResultRefresh = Date.now();
      $('last-refresh').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
      errorFor('files', '');
      if(!state.items.length&&state.selectedId)clearSelection('当前搜索没有匹配图纸');
    } catch (error) {
      if (request !== state.fileRequest || state.mode !== 'keyword') return;
      errorFor('files', error.message);
      $('result-count').textContent = state.items.length ? `${number(state.total)} 份图纸 · 更新失败` : '图纸加载失败';
      if (!state.items.length) {
        const box = el('div', 'empty');
        box.append(el('strong', '', '暂时无法读取图纸'), el('p', '', error.message), actionButton('重新连接', () => { refreshStatus(); loadFiles(); }));
        $('results').replaceChildren(box);
      }
    } finally {
      if (request === state.fileRequest) {
        state.filesLoading = false;
        $('results').removeAttribute('aria-busy');
        renderPageButtons();
        renderAiControls();
      }
    }
  }

  function renderPageButtons() {
    const pages = Math.max(1, Math.ceil(state.total / state.limit));
    $('previous-page').disabled = state.mode === 'ai' || state.filesLoading || state.page <= 1;
    $('next-page').disabled = state.mode === 'ai' || state.filesLoading || state.page >= pages;
  }
  function renderPageSummary() {
    if (state.mode === 'ai') {
      $('result-count').textContent = state.aiSearchStale ? '等待手动 AI 搜索' : `${number(state.total)} 份 AI 相关图纸`;
      $('page-number').textContent = '1 / 1';
      $('page-summary').textContent = state.aiSearchStale ? '修改查询或筛选后需手动搜索' : '有限候选结果 · 按 AI 相关度排列';
      renderPageButtons(); renderAiControls(); return;
    }
    const pages = Math.max(1, Math.ceil(state.total / state.limit));
    $('result-count').textContent = `${number(state.total)} ${state.grouped?'组':'份'}${state.query ? '匹配的' : ''}图纸`;
    $('page-number').textContent = `${number(state.page)} / ${number(pages)}`;
    $('page-summary').textContent = state.total
      ? `显示第 ${number((state.page - 1) * state.limit + 1)}–${number(Math.min(state.page * state.limit, state.total))} ${state.grouped?'组':'份'}`
      : '当前范围内没有图纸';
    if(state.grouped)$('page-summary').textContent += ` · 原图优先 · 命中 ${number(state.matchingFiles)} 个文件`;
    renderPageButtons();
    renderAiControls();
  }

  function renderResults() {
    renderPageSummary();
    if (!state.items.length) {
      const box = el('div', 'empty');
      const indexEmpty = !state.status?.stats?.total;
      box.append(el('strong', '', indexEmpty ? '索引中暂时没有图纸' : '没有匹配的图纸'),
        el('p', '', indexEmpty ? '在设置中检查扫描位置，或等待当前扫描完成。' : '试着缩短关键词，或切换到全部图纸。'));
      box.append(actionButton(indexEmpty ? '检查扫描设置' : '清除搜索与筛选', indexEmpty ? openSettings : resetFilters));
      $('results').replaceChildren(box);
      return;
    }
    $('results').replaceChildren(...state.items.map(file => {
      const button = actionButton('', () => selectFile(file.id), `file-row${file.id === state.selectedId ? ' selected' : ''}`);
      let evidencePanel=null;
      button.dataset.fileId = String(file.id);
      button.setAttribute('aria-pressed', String(file.id === state.selectedId));
      const format = el('span', 'format-icon', formatOf(file));
      format.append(el('span', 'format-label', formatOf(file) === 'PDF' ? pdfKindLabel(file.pdfInfo?.kind) : '图纸'));
      const text = el('span', 'file-text');
      const meta = el('span', 'file-meta');
      meta.append(el('span', '', file.project || '项目待确认'), el('span', '', formattedDate(file.modified, true)), el('span', '', bytes(file.size)));
      const tags = el('span', 'tags');
      if (file.pdfInfo) tags.append(el('span', `tag ${file.pdfInfo.kind === 'pending' ? 'pending' : 'project-kind'}`, `PDF · ${pdfKindLabel(file.pdfInfo.kind)}`));
      const naming = file.naming || {};
      if(file.group?.versionCount>1)tags.append(el('span','tag version',`${file.group.versionCount} 个版本 · ${file.group.backupCount} 个备份`));
      if(file.group&&!file.group.hasOriginal)tags.append(el('span','tag backup','仅找到备份'));
      if (pending(file)) tags.append(el('span', 'tag pending', file.classification?.conflict?'分类冲突 · 待处理':'待整理'));
      if (naming.projectKind === 'exhibition') tags.append(el('span', 'tag project-kind', naming.exhibitionName || '展会项目'));
      if (naming.isBackup) {
        const backup = el('span', 'tag backup', backupLabel(naming));
        backup.title = naming.backupTimestamp ? `备份参考时间：${backupTime(naming.backupTimestamp)}` : '从所在目录识别备份来源';
        tags.append(backup);
      }
      if (file.type) tags.append(el('span', 'tag', file.type));
      (file.tags || []).slice(0, 3).forEach(tag => tags.append(el('span', 'tag', tag)));
      if (file.exists === false) tags.append(el('span', 'tag missing', '原文件不存在'));
      text.append(el('span', 'filename', file.name), meta, tags);
      const namingMeta = [];
      if (naming.drawingNumber) namingMeta.push(`图号 ${naming.drawingNumber}`);
      if (naming.orderDate) namingMeta.push(`下单 ${naming.orderDate}`);
      if (naming.productionSerial) namingMeta.push(`序号 ${naming.productionSerial}`);
      if (namingMeta.length) text.append(el('div', 'naming-meta', namingMeta.join(' · ')));
      const path = el('div', 'file-path', file.path); path.title = file.path || ''; text.append(path);
      if (pending(file) && (file.suggestion?.project || file.suggestion?.type)) {
        text.append(el('div', 'rule-hint', `本机规则建议：${[file.suggestion.project, file.suggestion.type].filter(Boolean).join(' / ')}`));
      }
      if (state.mode === 'ai' && file.aiReason) text.append(el('div', 'ai-reason', `相关理由：${file.aiReason}`));
      if(state.mode==='ai'&&file.matchEvidence?.length){const evidence=el('details','match-evidence');evidence.append(el('summary','','查看实际命中版本与证据'));file.matchEvidence.forEach(v=>{evidence.append(el('strong','small',`${v.isBackup?'备份':'原图'}：${v.name}`));(v.matches||[]).forEach(m=>evidence.append(el('p','small',`${({name:'名称',folder:'目录片段',project:'项目',type:'类型',tags:'标签',naming:'图号信息',text:'PDF文字',groupProject:'整组共同项目',groupType:'整组共同类型',groupTags:'整组共同标签'})[m.field]||m.field}：${m.snippet}`)));});if(file.evidenceTruncatedKeywords?.length)evidence.append(el('p','notice','部分可选词命中证据超过本次容量，未展开：'+file.evidenceTruncatedKeywords.join('，')));evidencePanel=evidence;}
      if (file.pdfMatches?.length) {
        const evidence = el('div','pdf-match-evidence');
        file.pdfMatches.slice(0,3).forEach(match => {
          const link=el('a','',`${match.fileId !== file.id ? match.name + ' · ' : ''}第 ${match.page} 页 · ${match.source === 'ocr' ? '本地 OCR' : 'PDF 文字'}`);
          link.href=`/api/files/${encodeURIComponent(match.fileId || file.id)}/raw#page=${Number(match.page) || 1}`; link.target='_blank'; link.rel='noopener';
          evidence.append(link,el('p','small',match.snippet));
        });
        if(evidencePanel)evidencePanel.append(evidence); else evidencePanel=evidence;
      }
      button.append(format, text);
      if(evidencePanel){const wrapper=el('div','ai-result-with-evidence');wrapper.append(button,evidencePanel);return wrapper;}
      return button;
    }));
  }

  function pdfKindLabel(kind) { return { drawing:'图纸', document:'普通文档', pending:'待判断' }[kind] || '待判断'; }
  function renderPdfStatus(status) {
    const index=status.pdfIndex || {}, counts=status.stats?.pdfCounts || {};
    const progress=index.cancelled ? (index.running?'正在暂停，等待当前本地提取结束':'后台处理已暂停') : index.running ? `正在本地提取，已处理 ${number(index.processed)}，等待 ${number(index.queued)} 份` : status.settings?.pdf?.indexText === false ? '自动文字提取已关闭（仍可单独提取）' : index.queued ? `后台已处理 ${number(index.processed)}，等待 ${number(index.queued)} 份` : '后台处理空闲';
    const summary=`PDF ${number(counts.total)} 份 · 图纸 ${number(counts.drawing)} · 待判断 ${number(counts.pending)} · 普通文档 ${number(counts.document)} · ${progress}`;
    $('pdf-index-summary').textContent=summary;
    $('setting-pdf-progress').textContent=summary + (index.current ? `；正在处理：${typeof index.current === 'object' ? index.current.name || '' : index.current}` : '') + (index.error ? `；提示：${index.error}` : '');
    const cap=index.capabilities || {}, available=cap.available ?? cap.ocrAvailable;
    $('setting-pdf-capability').textContent=available ? `本地 OCR 可用 · ${cap.engine || 'Windows.Media.Ocr'} · ${(cap.languages || []).join('、') || '本机语言'}` : `本地 OCR ${cap.error ? '暂不可用：'+cap.error : '能力检查中；无可用引擎时文件保留待判断'}`;
    $('pdf-reindex').disabled=state.pdfBusy || state.settingsSaving;
    $('pdf-cancel').disabled=state.pdfBusy || !(index.running || index.queued);
  }
  async function pdfReindex(cancel=false) {
    if(state.pdfBusy)return;
    if(state.settingsDirty && !cancel){notice('请先保存 PDF 设置，再重新提取。',true);return;}
    state.pdfBusy=true; if(state.status)renderPdfStatus(state.status);
    try { await api('/api/pdf/reindex',{method:'POST',body:cancel?{cancel:true}:{}}); notice(cancel?'已请求暂停；等待当前本地提取结束，已有结果保留。':'已安排重新提取与判断 PDF；人工指定类别和原文件保留。'); await refreshStatus(); }
    catch(error){notice(error.message,true);}
    finally {state.pdfBusy=false;if(state.status)renderPdfStatus(state.status);}
  }
  function renderPdfDetail(file) {
    const info=file.pdfInfo || {}, box=el('section','pdf-detail');
    box.append(el('h3','',`PDF 识别 · ${pdfKindLabel(info.kind)}`),el('p','small',`自动判断：${pdfKindLabel(info.automaticKind)}${info.override && info.override !== 'auto' ? '；已人工指定' : ''}。分类仅控制工作台显示，原文件保留。`));
    (info.reasons || []).forEach(reason=>box.append(el('p','small',reason)));
    const control=el('div','field-actions'), select=el('select'); select.setAttribute('aria-label','人工指定 PDF 类别');
    [['auto','恢复自动判断'],['drawing','指定为图纸'],['pending','指定为待判断'],['document','指定为普通文档']].forEach(([value,label])=>{const option=el('option','',label);option.value=value;select.append(option);}); select.value=info.override || 'auto';
    const save=actionButton('保存 PDF 类别',async()=>{
      save.disabled=true;
      try { await api(`/api/files/${encodeURIComponent(file.id)}/pdf-kind?pdfMode=${encodeURIComponent(state.pdfMode)}`,{method:'POST',body:{kind:select.value}}); notice('PDF 类别已保存，原文件未改动。'); await refreshStatus(); if(state.mode==='ai')invalidateAiSearch('PDF 类别已变化，请手动重新搜索。');else {await loadFiles({quiet:true});if(state.selectedId===file.id){state.selectedFile=null;await selectFile(file.id);}} }
      catch(error){notice(error.message,true);}finally{save.disabled=false;}
    });control.append(select,save);box.append(control);
    box.append(el('p','small',`文字索引：${{pending:'等待提取',queued:'等待提取',processing:'正在提取',skipped_name:'文件名命中规则，已跳过正文',ready:'已提取',partial:'部分提取',no_text:'未提取到文字',error:'提取失败'}[info.status] || info.status || '等待提取'} · 已读取 ${number(info.readPages ?? info.indexedPages)} / ${number(info.totalPages)} 页 · 有文字 ${number(info.indexedPages)} 页 · OCR ${number(info.ocrPages)} 页`));
    const extract=actionButton('单独提取文字与尺寸',async()=>{
      extract.disabled=true;
      try {await api(`/api/files/${encodeURIComponent(file.id)}/pdf-index?pdfMode=${encodeURIComponent(state.pdfMode)}`,{method:'POST',body:{}});notice('已安排本文件提取文字与尺寸，本次不受文件名跳过规则影响。');await refreshStatus();if(state.selectedId===file.id){state.selectedFile=null;await selectFile(file.id);}}
      catch(error){notice(error.message,true);}finally{extract.disabled=false;}
    });
    box.append(extract);
    if(info.status==='skipped_name')box.append(el('p','field-hint','本文件尚未读取图内文字和尺寸。需要时点击上方按钮，仅对这一份补提取。'));
    if(info.truncated)box.append(el('p','notice','本次读取达到页数、字符或 OCR 上限，尚未覆盖全部内容；可在设置中调整后重新提取。'));
    if(info.error)box.append(el('p','notice',info.error));
    if(info.dimensions?.length)box.append(el('p','pdf-dimensions',`尺寸线索（请核对原图）：${info.dimensions.slice(0,40).map(value=>typeof value === 'string'?value:value.raw || value.normalized).join('、')}`));
    (info.pages || []).forEach(page=>{
      const details=el('details','pdf-page-text');details.append(el('summary','',`第 ${page.page} 页 · ${page.source==='ocr'?'本地 OCR':'PDF 文字'}${page.text?'':' · 无文字'}`));
      const link=el('a','','打开原 PDF 此页');link.href=`/api/files/${encodeURIComponent(file.id)}/raw#page=${Number(page.page)||1}`;link.target='_blank';link.rel='noopener';details.append(link);
      if(page.text)details.append(el('p','pdf-text',page.text));
      if(page.ocrError || page.error)details.append(el('p','notice',page.ocrError || page.error));box.append(details);
    });
    return box;
  }

  function resetFilters() {
    clearTimeout(state.searchTimer);
    state.searchTimer = null;
    state.scope = { kind: 'all', value: '' }; state.query = ''; state.format = ''; state.page = 1;
    state.pdfMode = state.status?.settings?.pdf?.displayMode || 'drawings-pending'; $('pdf-mode').value = state.pdfMode;
    $('query').value = ''; $('format-filter').value = ''; updateActiveNavigation();
    if (state.mode === 'ai') invalidateAiSearch('查询已清空，请输入描述后点击“AI 搜索”。'); else loadFiles();
  }

  async function selectFile(id) {
    if (state.selectedId === id && state.selectedFile) return;
    const request = ++state.detailRequest;
    state.selectedId = id;
    state.selectedFile = null;
    document.querySelectorAll('[data-file-id]').forEach(button => {
      const active = button.dataset.fileId === String(id);
      button.classList.toggle('selected', active); button.setAttribute('aria-pressed', String(active));
    });
    $('detail').replaceChildren(el('div', 'detail-top', '图纸详情'), el('div', 'detail-empty', '正在读取原文件信息…'));
    try {
      const file = await api(`/api/files/${encodeURIComponent(id)}?pdfMode=${encodeURIComponent(state.pdfMode)}`);
      if (request !== state.detailRequest) return;
      state.selectedFile = file;
      renderDetail(file);
      errorFor('detail', '');
    } catch (error) {
      if (request !== state.detailRequest) return;
      errorFor('detail', error.message);
      const box = el('div', 'detail-empty');
      box.append(el('strong', '', '图纸详情加载失败'), el('p', '', error.message), actionButton('重试', () => { state.selectedFile = null; selectFile(id); }));
      $('detail').replaceChildren(el('div', 'detail-top', '图纸详情'), box);
    }
  }

  async function refreshSelectedDetail() {
    const current = state.selectedFile;
    if (!current || state.drafts.get(current.id)?.dirty || $('detail').contains(document.activeElement)) return;
    const indexed = state.items.find(file => file.id === current.id)||state.items.find(file=>file.group?.id===current.group?.id);
    if (!indexed) { reconcileSelection(); return; }
    const pdfChanged = indexed.id === current.id && JSON.stringify([indexed.pdfInfo?.kind,indexed.pdfInfo?.status,indexed.pdfInfo?.updatedAt,indexed.pdfInfo?.indexedPages]) !== JSON.stringify([current.pdfInfo?.kind,current.pdfInfo?.status,current.pdfInfo?.updatedAt,current.pdfInfo?.indexedPages]);
    const fields = ['name', 'path', 'extension', 'size', 'modified', 'project', 'type', 'tags', 'contentStatus', 'previewStatus', 'suggestion', 'naming', 'exists','group','classification','contentVersion'];
    if (!pdfChanged && (indexed.id===current.id?fields.every(key => JSON.stringify(indexed[key]) === JSON.stringify(current[key])):JSON.stringify(indexed.group)===JSON.stringify(current.group))) return;
    const request = state.detailRequest;
    try {
      const file = await api(`/api/files/${encodeURIComponent(current.id)}?pdfMode=${encodeURIComponent(state.pdfMode)}`);
      if (request !== state.detailRequest || state.selectedId !== current.id || state.drafts.get(current.id)?.dirty || $('detail').contains(document.activeElement)) return;
      state.drafts.delete(file.id); state.selectedFile = file; renderDetail(file);
    } catch (_) {
      // A background detail refresh keeps the current view; the status poll reports connectivity errors.
    }
  }

  function preview(file) {
    const wrapper = el('div', 'preview');
    const id = encodeURIComponent(file.id);
    const format = formatOf(file);
    const caption = el('div', 'preview-caption');
    function placeholder(message) {
      const empty = el('div', 'preview-placeholder');
      empty.append(el('strong', '', format), el('p', '', message));
      wrapper.replaceChildren(empty, caption);
    }
    if (file.exists === false) {
      caption.textContent = '当前索引仍保留文件信息';
      placeholder('原文件已不存在或暂时无法访问。重新扫描后会更新索引。');
    } else if (format === 'PDF') {
      const image = el('img');
      image.alt = `PDF 首页预览：${file.name}`;
      image.src = `/api/files/${id}/preview?v=${encodeURIComponent(file.contentVersion || file.modified || '')}`;
      caption.append(el('span', '', 'PDF 首页预览'));
      const link = el('a', '', '查看完整 PDF');
      link.href = `/api/files/${id}/raw`; link.target = '_blank'; link.rel = 'noopener'; caption.append(link);
      image.addEventListener('error', () => {
        placeholder('PDF 首页预览暂不可用，可点击“查看完整 PDF”或使用下方“打开原文件”查看。');
      }, { once: true });
      wrapper.append(image, caption);
    } else {
      caption.textContent = format === 'DWG' ? '原文件内嵌缩略图，清晰度取决于原文件' : '本机生成的真实文件预览';
      const image = el('img');
      image.alt = `图纸预览：${file.name}`;
      image.src = `/api/files/${id}/preview?v=${encodeURIComponent(file.contentVersion || file.modified || '')}`;
      image.addEventListener('error', () => {
        caption.textContent = `${format} 格式 · 未生成预览`;
        placeholder('暂无此格式的页面预览，可使用下方“打开原文件”查看。');
      }, { once: true });
      wrapper.append(image, caption);
    }
    return wrapper;
  }

  function getDraft(file) {
    if (!state.drafts.has(file.id)) state.drafts.set(file.id, {
      project: unclassified(file.project) ? '' : String(file.project),
      type: unclassified(file.type) ? '' : String(file.type),
      tags: (file.tags || []).join('，'), dirty: false
    });
    return state.drafts.get(file.id);
  }

  function renderNaming(file) {
    const naming = file.naming || {};
    const section = el('section', 'naming-information');
    section.setAttribute('aria-label', '图号与产品信息');
    section.append(el('h3', '', '图号与产品信息'), el('p', 'small', '从名称／目录识别，待核对。未知信息保留待确认。'));
    const data = el('dl', 'detail-data naming-data');
    const fields = [
      ['项目类别', { order: '订单图纸', exhibition: '展会项目' }[naming.projectKind] || '待确认'],
      ['完整图号', naming.drawingNumber || '待确认'], ['订单批次', naming.orderBatch || '待确认'],
      ['下单日期', naming.orderDate || '待确认'], ['生产单序号', naming.productionSerial || '待确认'],
      ['产品名称', naming.productName || '待确认'], ['产品尺寸', naming.productSize || '待确认']
    ];
    if (naming.projectKind === 'exhibition' || naming.exhibitionName) fields.push(['展会名称', naming.exhibitionName || '待确认']);
    if (naming.isBackup) {
      fields.push(['备份识别', backupLabel(naming)], ['备份参考时间', backupTime(naming.backupTimestamp)], ['原始名称', naming.baseName || '待确认']);
    }
    fields.forEach(([label, value]) => data.append(el('dt', '', label), el('dd', '', value)));
    section.append(data);
    if (naming.isBackup) section.append(el('p', 'classify-note', naming.backupTimestamp ? '备份参考时间来自名称末尾的时间戳；与下单日期分别显示。' : '备份来源由所在目录识别；参考时间待确认。'));
    const notes = Array.isArray(naming.notes) ? naming.notes.filter(Boolean) : [];
    if (notes.length) {
      const list = el('ul', 'naming-notes'); notes.forEach(note => list.append(el('li', '', note))); section.append(list);
    }
    return section;
  }

  function renderVersions(file){
    const group=file.group||{},versions=file.versions||[];
    const box=el('details','version-list');box.setAttribute('aria-label','原图与备份版本');
    box.open=state.versionsOpen.has(group.id);
    box.addEventListener('toggle',()=>{if(box.open)state.versionsOpen.add(group.id);else state.versionsOpen.delete(group.id);});
    box.append(el('summary','',`原图与备份 · ${number(group.versionCount||1)} 个版本`));
    box.append(el('p','small',group.hasOriginal?'搜索默认显示原图。可在下方切换预览、打开或定位每个版本。':'目前只找到备份，默认显示最近的备份；以后发现原图会自动优先显示。'));
    versions.forEach(version=>{
      const row=el('div',`version-row${version.id===file.id?' current':''}`);
      const role=version.isBackup?'备份':version.isRepresentative?'原图 · 默认显示':'原图副本';
      row.append(el('strong','',role),el('div','version-name',version.name));
      const date=version.backupTimestamp?`备份时间 ${backupTime(version.backupTimestamp)}`:`修改时间 ${formattedDate(version.modified)}`;
      row.append(el('div','small',`${date} · ${bytes(version.size)}`),el('div','version-path',version.path));
      const legacy=version.versionClassification||{};
      if(legacy.classified||legacy.project||legacy.type||legacy.tags?.length)row.append(el('p','small',`此版本原有人工分类（保留）：${legacy.project||'未设项目'} / ${legacy.type||'未设类型'}；标签 ${(legacy.tags||[]).join('，')||'无'}`));
      if(version.isBackup&&(version.ruleName||version.basis))row.append(el('div','small',version.ruleName||version.basis));
      const actions=el('div','detail-actions');
      const view=actionButton(version.id===file.id?'正在查看':'查看此版本',()=>selectFile(version.id));view.disabled=version.id===file.id;
      actions.append(view);
      ['open','locate'].forEach(action=>{const button=actionButton(action==='open'?'打开':'定位',()=>fileAction(version,action,button));actions.append(button);});
      row.append(actions);box.append(row);
    });
    return box;
  }

  function renderClassificationHistory(file){
    const value=file.classification||{},box=el('section',value.conflict?'classification-conflict':'classification-info');
    box.setAttribute('aria-label','整组分类状态');
    box.append(el('strong','',value.conflict?'组分类存在冲突 · 待处理':file.classified?'整组已整理':'整组待整理'),el('p','small','项目、类型和共同标签属于整组；文件名、路径、修改时间、正文和原有人工分类属于各版本。'));
    if(value.conflict){
      box.append(el('p','','下面保留全部来源值；请核对后在共同分类栏明确确认，不会自动用原图覆盖备份分类。'));
      const choices=[...(value.confirmedVariants||[]),...(value.variants||[]).filter(v=>v.classified||v.project||v.type||v.tags?.length)];
      choices.forEach(v=>box.append(el('p','small',`${v.name||'已确认共同分类'}：${v.project||'未设项目'} / ${v.type||'未设类型'}；标签 ${(v.tags||[]).join('，')||'无'}`)));
    }
    return box;
  }

  function renderDetail(file) {
    const top = el('div', 'detail-top', '图纸详情');
    if (pending(file)) top.append(el('span', 'tag pending', '待整理'));
    const body = el('div', 'detail-body');
    const visual = el('div', 'detail-visual'); visual.append(preview(file));
    const information = el('div', 'detail-information');
    information.append(el('h2', 'detail-name', file.name));
    information.append(renderVersions(file));
    information.append(renderClassificationHistory(file));
    const data = el('dl', 'detail-data');
    [['项目', file.project || '待确认'], ['类型', file.type || '待确认'], ['格式', formatOf(file)], ['修改时间', formattedDate(file.modified)], ['文件大小', bytes(file.size)], ['内容状态', contentLabel(file)]].forEach(([label, value]) => data.append(el('dt', '', label), el('dd', '', value)));
    information.append(data, renderNaming(file));
    if (formatOf(file) === 'PDF') information.append(renderPdfDetail(file));
    const pathBox = el('div', 'path-box'); pathBox.append(el('strong', '', '原文件路径'), el('span', '', file.path)); information.append(pathBox);
    const actions = el('div', 'detail-actions');
    ['open', 'locate'].forEach(action => {
      const button = actionButton(action === 'open' ? '打开原文件' : '定位目录', () => fileAction(file, action, button));
      button.disabled = file.exists === false; actions.append(button);
    });
    information.append(actions);
    const aiActions = el('div', 'detail-actions ai-detail-actions');
    const aiAnalyze = actionButton('AI 分析这份图纸', () => openAiSuggestions([file.id], true));
    aiAnalyze.dataset.aiAction = 'analyze'; aiAnalyze.disabled = aiBusy() || file.exists === false;
    aiActions.append(aiAnalyze, actionButton('查看已存 AI 建议', () => openAiSuggestions([file.id], false)));
    information.append(aiActions, el('p', 'classify-note', 'AI 分析会发送本图的名称、末 3 级目录、分类资料和本机解析的图号、下单日期、产品尺寸及备份信息；不发送绝对路径。PDF 文字按 DeepSeek 设置决定。'));
    const suggestion = file.suggestion || {};
    const draft = getDraft(file);
    if (suggestion.project || suggestion.type || suggestion.tags?.length) {
      const box = el('div', 'suggestion-box');
      box.append(el('strong', '', '本机命名与关键词规则建议 · 需人工确认'),
        el('p', '', [suggestion.project ? `项目：${suggestion.project}` : '', suggestion.type ? `类型：${suggestion.type}` : ''].filter(Boolean).join('；')));
      if (suggestion.tags?.length) box.append(el('p', '', `标签：${suggestion.tags.join('，')}`));
      const reasons = Array.isArray(suggestion.reasons) ? suggestion.reasons : [];
      if (reasons.length) { const list = el('ul'); reasons.forEach(reason => list.append(el('li', '', reason))); box.append(list); }
      box.append(el('p', 'small', '依据本机命名解析与已设置的关键词规则，不代表 AI 已识别图纸内容。'));
      box.append(actionButton('将建议填入分类栏', () => {
        if (draft.dirty) { notice('下方保留了尚未保存的手工输入，请先保存后再填入建议。'); return; }
        if (suggestion.project) draft.project = suggestion.project;
        if (suggestion.type) draft.type = suggestion.type;
        if (suggestion.tags?.length) draft.tags = [...new Set([...draft.tags.split(/[,，;；\n]+/).map(value => value.trim()).filter(Boolean), ...suggestion.tags])].join('，');
        draft.dirty = true;
        renderDetail(file);
        notice('规则建议已填入下方分类栏，确认后点击“保存分类”。');
      }));
      information.append(box);
    }
    const form = el('form', 'classify-form');
    form.append(el('h3', '', '整组共同分类与标签'),el('p','small','保存应用于这组原图和备份。各版本原有人工分类保留在版本详情中，不静默覆盖。'));
    [['project', '项目', '输入项目名称'], ['type', '图纸类型', '输入类型名称'], ['tags', '标签', '多个标签用逗号分隔']].forEach(([key, label, placeholder]) => {
      const input = el('input');
      input.type = 'text'; input.value = draft[key]; input.placeholder = placeholder; input.maxLength = key === 'tags' ? 5100 : 120;
      input.setAttribute('aria-label', label); input.autocomplete = 'off';
      input.addEventListener('input', () => { draft[key] = input.value; draft.dirty = true; });
      const field = el('label', '', label); field.append(input); form.append(field);
    });
    const formError = el('div', 'form-error'); formError.hidden = true; form.append(formError);
    const submit = el('button', 'primary', '保存分类'); submit.type = 'submit';
    const classifyActions = el('div', 'classify-actions');
    classifyActions.append(submit, actionButton('清空输入', () => {
      draft.project = ''; draft.type = ''; draft.tags = ''; draft.dirty = true; renderDetail(file);
      notice('分类输入已清空；至少填写项目或类型中的一项后再保存。');
    }));
    form.append(classifyActions, el('p', 'classify-note', '至少填写项目或类型中的一项。保存只更新本地索引中的分类标签，原图位置和内容不变。'));
    if(file.classification?.conflict){const checkbox=el('input');checkbox.type='checkbox';checkbox.checked=draft.resolveConflict===true;checkbox.addEventListener('change',()=>{draft.resolveConflict=checkbox.checked;draft.dirty=true;});const label=el('label','check-row');label.append(checkbox,el('span','','我已核对版本差异，确认以上整组共同分类；版本原值仍保留'));form.append(label);}
    form.addEventListener('submit', event => { event.preventDefault(); saveClassification(file, draft, submit, formError); });
    information.append(form);
    if (file.contentSnippet) {
      const snippet = el('details', 'snippet'); snippet.append(el('summary', '', '查看已提取的文字片段'), el('p', '', file.contentSnippet)); information.append(snippet);
    }
    body.append(visual, information);
    $('detail').replaceChildren(top, body);
  }

  async function fileAction(file, action, button) {
    button.disabled = true;
    try {
      if(action === 'locate' && window.drawingDesktop?.locateFile) await window.drawingDesktop.locateFile(file.id);
      else await api(`/api/files/${encodeURIComponent(file.id)}/${action}`, { method: 'POST' });
      errorFor('action', '');
      notice(action === 'open' ? `已请求本机打开：${file.name}` : `已请求资源管理器定位：${file.name}`);
    } catch (error) { errorFor('action', error.message); notice(error.message, true); }
    finally { button.disabled = file.exists === false; }
  }

  async function saveClassification(file, draft, button, formError) {
    const payload = {
      project: draft.project.trim(), type: draft.type.trim(),
      tags: [...new Set(draft.tags.split(/[,，;；\n]+/).map(value => value.trim()).filter(Boolean))],scope:'group',resolveConflict:draft.resolveConflict===true
    };
    if (!payload.project && !payload.type) {
      formError.textContent = '请至少填写项目或类型中的一项。'; formError.hidden = false; return;
    }
    const controls = [...button.form.querySelectorAll('input,button')];
    controls.forEach(control => { control.disabled = true; });
    button.textContent = '保存中…'; formError.hidden = true;
    try {
      const result = await api(`/api/files/${encodeURIComponent(file.id)}/classify?pdfMode=${encodeURIComponent(state.pdfMode)}`, { method: 'POST', body: payload });
      const savedFile = await api(`/api/files/${encodeURIComponent(file.id)}?pdfMode=${encodeURIComponent(state.pdfMode)}`);
      state.drafts.delete(file.id);
      if (savedFile) { state.items = state.items.map(item => item.id === savedFile.id ? { ...item, ...savedFile } : item); renderResults(); }
      if (state.selectedId === file.id && savedFile) { state.selectedFile = { ...file, ...savedFile }; renderDetail(state.selectedFile); }
      notice('分类已保存到本地索引，原图位置和内容不变。');
      errorFor('action', '');
      await refreshStatus(); await loadFiles({ quiet: true });
    } catch (error) { formError.textContent = error.message; formError.hidden = false; notice(error.message, true); }
    finally { controls.forEach(control => { control.disabled = false; }); button.textContent = '保存分类'; }
  }

  function aiBusy() { return Boolean(state.aiTask || state.aiStatus.busy); }
  function aiReady() { return Boolean(state.aiStatus.enabled && state.aiStatus.configured); }
  function batchFiles() {
    const count = Math.min(10, Math.max(1, Number(state.aiSettings?.batchSize || state.aiStatus.batchSize || 5)));
    return state.items.filter(file => pending(file) && file.exists !== false).slice(0, count);
  }
  function usageText(usage) {
    if (!usage || typeof usage !== 'object') return '服务未返回用量';
    const total = usage.total_tokens ?? usage.totalTokens;
    const input = usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens;
    const output = usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens;
    return [total != null ? `总计 ${number(total)} tokens` : '', input != null ? `输入 ${number(input)}` : '', output != null ? `输出 ${number(output)}` : ''].filter(Boolean).join(' · ') || '服务未返回用量';
  }
  function renderAiControls() {
    $('local-rules-button').disabled=state.mode!=='keyword'||state.filesLoading;
    const busy = aiBusy();
    const statusText = !state.aiStatus.configured ? 'DeepSeek 未配置密钥' : !state.aiStatus.enabled ? 'DeepSeek 已配置 · 未启用' : busy ? 'DeepSeek 正在处理任务' : `DeepSeek 已启用 · ${state.aiStatus.model || state.aiSettings?.model || 'deepseek-flash'}`;
    $('ai-short-status').textContent = statusText;
    $('ai-config-status').textContent = statusText;
    $('keyword-search-button').classList.toggle('active', state.mode === 'keyword');
    $('keyword-search-button').setAttribute('aria-pressed', String(state.mode === 'keyword'));
    $('ai-search-button').classList.toggle('active', state.mode === 'ai');
    $('ai-search-button').setAttribute('aria-pressed', String(state.mode === 'ai'));
    $('search-submit').textContent = state.mode === 'ai' ? (state.aiTask === 'search' ? 'AI 搜索中…' : 'AI 搜索') : '搜索';
    $('search-submit').disabled = state.mode === 'ai' && busy;
    $('sort').disabled = state.mode === 'ai';
    $('sort').title = state.mode === 'ai' ? 'AI 结果按相关度排列；更改排序请切回关键词搜索。' : '';
    $('query').placeholder = state.mode === 'ai' ? '例如：找去年暴龙头部机构的 PDF 图纸' : '输入名称、图号、图内文字或尺寸，如 Φ20、500mm';
    const files = batchFiles();
    const count = Math.min(10, Math.max(1, Number(state.aiSettings?.batchSize || state.aiStatus.batchSize || 5)));
    $('ai-batch-button').textContent = state.aiTask === 'classify' ? 'AI 分析中…' : `AI 分析本页前 ${number(files.length)} 份待整理`;
    $('ai-batch-button').disabled = busy || state.filesLoading || !files.length || (state.mode === 'ai' && state.aiSearchStale);
    $('ai-batch-note').textContent = `每次最多 ${number(count)} 份；当前页可分析 ${number(files.length)} 份。仅手动触发，不自动采用分类。`;
    document.querySelectorAll('[data-ai-action="analyze"]').forEach(button => { button.disabled = busy || state.selectedFile?.exists === false; });
    $('ai-settings-save').disabled = state.aiSettingsSaving || state.aiSettingsLoading || busy;
    $('ai-test-button').disabled = state.aiSettingsSaving || state.aiSettingsLoading || busy;
    $('ai-test-button').textContent = state.aiTask === 'test' ? '连接测试中…' : '测试连接';
    $('ai-clear-key').disabled = state.aiSettingsSaving || state.aiSettingsLoading || busy || !state.aiStatus.configured;
    $('ai-suggestions-retry').disabled = busy || state.aiDialogLoading;
  }
  function currentAiScope() {
    const scope = {};
    if (state.scope.kind === 'pending') scope.pending = true;
    if (state.scope.kind === 'project') scope.project = state.scope.value;
    if (state.scope.kind === 'type') scope.type = state.scope.value;
    if (state.scope.kind === 'orderBatch') scope.orderBatch = state.scope.value;
    if (state.scope.kind === 'projectKind') scope.projectKind = state.scope.value;
    if (state.scope.kind === 'backup') scope.backup = state.scope.value;
    const format = state.format || (state.scope.kind === 'format' ? state.scope.value : '');
    if (format) scope.format = format;
    if (state.pdfMode) scope.pdfMode = state.pdfMode;
    return scope;
  }
  function aiSnapshot() { return JSON.stringify([state.mode, $('query').value.trim(), currentAiScope()]); }
  function invalidateAiSearch(message) {
    clearSelection('自然语言查询或范围已变化，请重新搜索。');
    ++state.aiSearchRevision; ++state.fileRequest;
    state.filesLoading = false; state.aiSearchStale = true; state.aiSearchResult = null;
    state.items = []; state.total = 0; state.page = 1; state.filesSignature = '';
    $('results').removeAttribute('aria-busy'); $('ai-search-info').hidden = false;
    $('ai-search-info').replaceChildren(el('strong', '', '自然语言找图 · 手动调用'), el('p', '', message), el('p', 'small', '会发送当前查询和有限候选资料至 DeepSeek；结果不保证覆盖全库全部相关图纸。后台刷新不会重新调用。'));
    const box = el('div', 'empty'); box.append(el('strong', '', '等待手动搜索'), el('p', '', message));
    $('results').replaceChildren(box); errorFor('ai-search', ''); renderPageSummary();
  }
  function setSearchMode(mode) {
    if (state.mode === mode) return;
    clearTimeout(state.searchTimer); state.searchTimer = null;
    ++state.fileRequest; ++state.aiSearchRevision;
    state.filesLoading = false; state.mode = mode; state.query = $('query').value.trim(); state.page = 1;
    state.items = []; state.total = 0; state.filesSignature = '';
    $('results').removeAttribute('aria-busy'); errorFor('files', ''); errorFor('ai-search', '');
    updateActiveNavigation(); renderAiControls();
    if (mode === 'ai') invalidateAiSearch('输入需要的图纸描述，点击“AI 搜索”开始。');
    else { $('ai-search-info').hidden = true; loadFiles(); }
  }
  async function showAiSettings(message) {
    await openSettings();
    $('ai-setup-note').textContent = message; $('ai-setup-note').hidden = false;
    $('ai-settings-section').scrollIntoView({ block: 'start', behavior: 'smooth' });
    $('ai-key').focus({ preventScroll: true });
  }
  async function requireAi() {
    if (aiReady()) return true;
    await showAiSettings(!state.aiStatus.configured ? '请填写 API Key、启用 DeepSeek 并单独保存设置，再手动重试。' : '请勾选启用 DeepSeek 并单独保存设置，再手动重试。');
    return false;
  }
  async function searchAi() {
    if (aiBusy()) { notice('已有 AI 任务正在处理，请完成后再搜索。', true); return; }
    const query = $('query').value.trim();
    if (!query) { notice('请先输入需要查找的图纸描述。', true); $('query').focus(); return; }
    if (!await requireAi() || state.mode !== 'ai' || aiBusy()) return;
    state.query = query;
    const request = ++state.aiSearchRevision, snapshot = aiSnapshot();
    state.aiTask = 'search'; state.aiSearchStale = false; state.aiSearchResult = null;
    clearSelection('正在按当前自然语言查询查找图纸…');
    state.items = []; state.total = 0; state.page = 1;
    $('result-count').textContent = 'DeepSeek 正在制定检索计划并排列候选…';
    $('results').replaceChildren(el('div', 'empty', '正在分析当前查询与本机候选，最长等待约 100 秒…'));
    $('ai-search-info').hidden=false;
    $('ai-search-info').replaceChildren(el('strong','','自然语言找图 · 正在检索'),el('p','','正在处理本次查询与有限候选，请等待；不会自动重复调用。'));
    $('results').setAttribute('aria-busy', 'true'); renderAiControls(); errorFor('ai-search', '');
    try {
      const result = await api('/api/ai/search', { method: 'POST', body: { query, scope: currentAiScope() } });
      if (request !== state.aiSearchRevision || snapshot !== aiSnapshot() || state.mode !== 'ai') return;
      state.aiSearchResult = result; state.items = Array.isArray(result.items) ? result.items : [];
      state.total = state.items.length; state.page = 1;
      renderResults(); reconcileSelection(); renderAiSearchInfo(result);
      $('last-refresh').textContent = `AI 查询于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
      $('ai-usage').textContent = `最近 AI 搜索：${usageText(result.usage)}`;
      if (state.items.length) selectFile(state.items[0].id);
    } catch (error) {
      if (request !== state.aiSearchRevision || snapshot !== aiSnapshot() || state.mode !== 'ai') return;
      state.aiSearchStale = true; errorFor('ai-search', error.message);
      clearSelection('本次 AI 搜索失败，未选中图纸。请手动重试或切回关键词搜索。');
      $('ai-search-info').hidden=false;
      $('ai-search-info').replaceChildren(el('strong','','本次 AI 搜索未完成'),el('p','',error.message),el('p','small','可手动重试或切回关键词搜索；程序不会自动重复调用。'));
      $('result-count').textContent = 'AI 搜索失败';
      const box = el('div', 'empty'); box.append(el('strong', '', 'AI 搜索失败'), el('p', '', error.message), actionButton('手动重试 AI 搜索', searchAi));
      $('results').replaceChildren(box);
    } finally {
      state.aiTask = '';
      if (request === state.aiSearchRevision) $('results').removeAttribute('aria-busy');
      renderAiControls(); renderPageButtons(); refreshStatus();
    }
  }
  function renderAiSearchInfo(result) {
    const plan = result.plan || {}, groups = Array.isArray(plan.groups) ? plan.groups : [];
    const keywords = Array.isArray(plan.keywords) ? plan.keywords : [], formats = Array.isArray(plan.formats) ? plan.formats : [];
    const box = $('ai-search-info'); box.hidden = false;
    box.replaceChildren(el('strong', '', '本次检索计划与候选边界'));
    box.append(el('p', '', `关键词组：${groups.map(group => Array.isArray(group) ? group.join(' / ') : String(group)).join('；') || '无'}；补充词：${keywords.join('、') || '无'}；格式：${formats.join('、') || '不限'}`));
    box.append(el('p', '', `候选上限 ${number(state.aiSettings?.candidateLimit || state.aiStatus.candidateLimit || 60)} 份 · 本次候选 ${number(result.totalCandidates)} 份 · 返回 ${number(state.items.length)} 份 · ${usageText(result.usage)}`));
    box.append(el('p', 'small', result.notice || '结果由本机候选检索后交给 AI 排序，可能遗漏候选范围外的图纸。修改查询或筛选后需手动重新搜索。'));
  }
  function aiSettingsChanged() {
    if (state.aiSettingsLoading) return;
    state.aiDirty = true; $('ai-dirty-note').textContent = 'DeepSeek 设置有未保存的修改';
  }
  function fillAiSettings(settings) {
    state.aiSettingsLoading = true;
    $('ai-enabled').checked = Boolean(settings.enabled);
    $('ai-model').value = settings.model || 'deepseek-flash';
    $('ai-send-pdf').checked = Boolean(settings.sendPdfText);
    $('ai-batch-size').value = settings.batchSize || 5;
    $('ai-candidate-limit').value = settings.candidateLimit || 60;
    $('ai-key').value = '';
    state.aiSettingsLoading = false; state.aiDirty = false;
    $('ai-dirty-note').textContent = 'DeepSeek 设置已从本机读取，与扫描设置分别保存';
  }
  async function loadAiSettings() {
    if (state.aiDirty || state.aiSettingsLoading) return;
    state.aiSettingsLoading = true; $('ai-settings-section').disabled = true; renderAiControls();
    try {
      const result = await api('/api/ai/settings');
      state.aiSettings = result.settings || {};
      const { settings, ...status } = result; state.aiStatus = { ...state.aiStatus, ...status };
      if (!state.aiDirty) fillAiSettings(state.aiSettings);
      $('ai-settings-error').hidden = true;
    } catch (error) { $('ai-settings-error').textContent = error.message; $('ai-settings-error').hidden = false; }
    finally { state.aiSettingsLoading = false; $('ai-settings-section').disabled = false; renderAiControls(); }
  }
  function aiSettingsPayload() {
    const batchSize = Number($('ai-batch-size').value), candidateLimit = Number($('ai-candidate-limit').value);
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10) throw new Error('每次批量分析份数应为 1–10 的整数。');
    if (!Number.isInteger(candidateLimit) || candidateLimit < 20 || candidateLimit > 100) throw new Error('自然语言候选上限应为 20–100 的整数。');
    const model = $('ai-model').value.trim(); if (!model) throw new Error('请填写 DeepSeek 模型 ID。');
    const payload = { enabled: $('ai-enabled').checked, model, sendPdfText: $('ai-send-pdf').checked, batchSize, candidateLimit };
    const apiKey = $('ai-key').value.trim(); if (apiKey) payload.apiKey = apiKey;
    return payload;
  }
  async function saveAiSettings(event, clearKey = false) {
    event?.preventDefault();
    if (state.aiSettingsSaving || state.aiSettingsLoading || aiBusy()) return;
    const box = $('ai-settings-error'); box.hidden = true;
    let payload;
    try {
      payload = clearKey ? { ...(state.aiSettings || { enabled: false, model: 'deepseek-flash', sendPdfText: false, batchSize: 5, candidateLimit: 60 }), clearKey: true } : aiSettingsPayload();
    } catch (error) { box.textContent = error.message; box.hidden = false; return; }
    state.aiSettingsSaving = true; $('ai-settings-section').disabled = true; renderAiControls();
    try {
      const result = await api('/api/ai/settings', { method: 'PUT', body: payload });
      state.aiSettings = result.settings || {};
      const { settings, ...status } = result; state.aiStatus = { ...state.aiStatus, ...status };
      if (!clearKey) fillAiSettings(state.aiSettings); else $('ai-key').value = '';
      $('ai-setup-note').hidden = true;
      $('ai-dirty-note').textContent = clearKey ? '已清除本机密钥；其他未保存的输入仍保留' : 'DeepSeek 设置已保存，不会触发扫描';
      notice(clearKey ? '已清除本机加密保存的 DeepSeek 密钥。' : 'DeepSeek 设置已单独保存。');
    } catch (error) { box.textContent = error.message; box.hidden = false; notice(error.message, true); }
    finally { state.aiSettingsSaving = false; $('ai-settings-section').disabled = false; renderAiControls(); }
  }
  async function testAiConnection() {
    if (aiBusy() || state.aiSettingsSaving) return;
    if (state.aiDirty) { $('ai-settings-error').textContent = '请先保存 DeepSeek 设置，再测试已保存的配置。'; $('ai-settings-error').hidden = false; return; }
    if (!state.aiStatus.configured) { $('ai-settings-error').textContent = '请先填写 API Key 并保存 DeepSeek 设置。'; $('ai-settings-error').hidden = false; return; }
    state.aiTask = 'test'; renderAiControls(); $('ai-settings-error').hidden = true;
    $('ai-usage').textContent = '正在测试 DeepSeek 官方接口，仅发送简短测试消息…';
    try {
      const result = await api('/api/ai/test', { method: 'POST' });
      if (result.ok !== true) throw new Error('连接测试未返回成功状态，请检查配置后重试。');
      $('ai-usage').textContent = `连接成功 · ${result.model || state.aiStatus.model} · ${number(result.latencyMs)} 毫秒 · ${usageText(result.usage)}`;
      notice('DeepSeek 真实连接测试成功。');
    } catch (error) { $('ai-settings-error').textContent = error.message; $('ai-settings-error').hidden = false; $('ai-usage').textContent = '连接测试失败，可修改配置并保存后手动重试。'; notice(error.message, true); }
    finally { state.aiTask = ''; renderAiControls(); refreshStatus(); }
  }
  async function openAiSuggestions(ids, analyze) {
    if (analyze && (aiBusy() || !await requireAi())) return;
    const request = ++state.aiDialogRequest;
    state.aiLastIds = [...ids]; state.aiSuggestions = []; state.aiDialogLoading = true;
    if (!$('ai-suggestions-dialog').open) $('ai-suggestions-dialog').showModal();
    $('ai-suggestions-body').replaceChildren(el('p', 'empty', '正在读取本机已存建议…'));
    $('ai-suggestions-summary').textContent = `本次选择 ${number(ids.length)} 份图纸`;
    $('ai-suggestions-retry').hidden = true; renderAiControls();
    try {
      const saved = await Promise.all(ids.map(id => api(`/api/ai/suggestions?fileId=${encodeURIComponent(id)}`)));
      if (request !== state.aiDialogRequest) return;
      state.aiSuggestions = saved.flatMap(result => Array.isArray(result.suggestions) ? result.suggestions : []).filter(suggestion => !suggestion.status || ['pending', 'review', 'suggested'].includes(suggestion.status));
      const restored = [...state.aiSuggestions];
      const existing = new Set(restored.map(suggestion => String(suggestion.fileId)));
      const missingIds = ids.filter(id => !existing.has(String(id)));
      if (analyze && missingIds.length) await runAiClassification(missingIds, request, restored);
      else {
        renderAiSuggestions();
        $('ai-suggestions-summary').textContent = state.aiSuggestions.length ? `已恢复 ${number(state.aiSuggestions.length)} 条本地待审建议，本次未调用 AI` : '当前没有已存待审建议，可手动点击“重新分析”。';
      }
    } catch (error) {
      if (request !== state.aiDialogRequest) return;
      const box = el('div', 'form-error', error.message);
      $('ai-suggestions-body').replaceChildren(box);
      $('ai-suggestions-summary').textContent = '读取失败；可关闭后重新查看，或手动重新分析。';
    } finally {
      if (request === state.aiDialogRequest) {
        state.aiDialogLoading = false; $('ai-suggestions-retry').hidden = false;
        $('ai-suggestions-retry').textContent = `重新分析所选 ${number(ids.length)} 份（调用 AI）`;
        renderAiControls();
      }
    }
  }
  async function runAiClassification(ids, request = state.aiDialogRequest, restored = []) {
    if (aiBusy()) { $('ai-suggestions-summary').textContent = '已有 AI 任务正在处理，请稍后手动重新分析。'; renderAiSuggestions(); return; }
    if (!await requireAi() || request !== state.aiDialogRequest || aiBusy()) return;
    const previousSuggestions = [...state.aiSuggestions];
    state.aiTask = 'classify'; renderAiControls();
    $('ai-suggestions-body').replaceChildren(el('p', 'empty', `正在分析 ${number(ids.length)} 份图纸，生成可编辑建议…`));
    $('ai-suggestions-summary').textContent = '仅生成建议，不会自动保存分类。';
    try {
      const result = await api('/api/ai/classify', { method: 'POST', body: { ids } });
      if (request !== state.aiDialogRequest) return;
      state.aiSuggestions = [...restored, ...(Array.isArray(result.suggestions) ? result.suggestions : [])];
      renderAiSuggestions();
      $('ai-suggestions-summary').textContent = `${restored.length ? `本地恢复 ${number(restored.length)} 条 · ` : ''}本次分析 ${number(ids.length)} 份 · 共 ${number(state.aiSuggestions.length)} 条建议 · ${usageText(result.usage)}${result.notice ? ` · ${result.notice}` : ''}`;
      $('ai-usage').textContent = `最近分类分析：${usageText(result.usage)}`;
    } catch (error) {
      if (request !== state.aiDialogRequest) return;
      if (previousSuggestions.length) { state.aiSuggestions = previousSuggestions; renderAiSuggestions(); $('ai-suggestions-body').prepend(el('div', 'form-error', error.message)); }
      else $('ai-suggestions-body').replaceChildren(el('div', 'form-error', error.message));
      $('ai-suggestions-summary').textContent = 'AI 分析失败，可手动重试。建议可能已落本机库时，可关闭后查看已存建议。';
    } finally { state.aiTask = ''; renderAiControls(); refreshStatus(); }
  }
  function renderAiSuggestions() {
    const root = $('ai-suggestions-body'); root.replaceChildren();
    if (!state.aiSuggestions.length) { root.append(el('div', 'empty', '没有待审 AI 建议。')); return; }
    state.aiSuggestions.forEach(suggestion => {
      if (!state.aiSuggestionDrafts.has(suggestion.id)) state.aiSuggestionDrafts.set(suggestion.id, { project: suggestion.project || suggestion.existingClassification?.project || '', type: suggestion.type || suggestion.existingClassification?.type || '', tags: [...new Set([...(suggestion.existingClassification?.tags||[]),...(suggestion.tags||[])])].join('，'), dirty: false,confirmTagRemoval:false,resolveConflict:false });
      const draft = state.aiSuggestionDrafts.get(suggestion.id), card = el('section', 'ai-suggestion-card');
      card.append(el('h3', '', suggestion.name || `图纸 ${suggestion.fileId}`), el('p', 'small break-anywhere', suggestion.path || ''), el('p', 'ai-reason', `判断理由：${suggestion.reason || '服务未提供理由'}`));
      if (suggestion.rulesVersion && !['0.3.1','0.4.0','0.5.0','0.5.1','0.5.2'].includes(suggestion.rulesVersion)) card.append(el('p', 'notice', `这条建议生成于 V${String(suggestion.rulesVersion).replace(/^v/i, '')}，尚未参考图号规则；可手动重新分析。`));
      if (suggestion.summary) card.append(el('p', 'small', suggestion.summary));
      const form = el('form', 'ai-suggestion-form');
      [['project', '项目'], ['type', '图纸类型'], ['tags', '标签（逗号分隔）']].forEach(([key, label]) => {
        const field = el('label', '', label), input = el('input'); input.type = 'text'; input.value = draft[key]; input.maxLength = key === 'tags' ? 7100 : 120;
        input.autocomplete = 'off'; input.addEventListener('input', () => { draft[key] = input.value; draft.dirty = true; if(key==='tags'){draft.confirmTagRemoval=false;renderTagDifference();} }); field.append(input); form.append(field);
      });
      const tagDifference=el('div','tag-difference');
      function renderTagDifference(){
        tagDifference.replaceChildren(el('p','small','默认合并完整人工标签；模型没有返回的标签不会自动删除。'));
        const edited=draft.tags.split(/[,，;；\n]+/).map(v=>v.trim()).filter(Boolean);
        const removed=(suggestion.existingClassification?.tags||[]).filter(tag=>!edited.includes(tag));
        if(removed.length){tagDifference.append(el('p','notice',`输入中移除的人工标签（${removed.length}）：${removed.join('，')}`));const checkbox=el('input');checkbox.type='checkbox';checkbox.checked=draft.confirmTagRemoval===true;checkbox.addEventListener('change',()=>{draft.confirmTagRemoval=checkbox.checked;});const label=el('label','check-row');label.append(checkbox,el('span','','确认删除上面明确列出的人工标签；未勾选则保留它们'));tagDifference.append(label);}
      }
      renderTagDifference();form.append(tagDifference);
      if(suggestion.existingClassification?.conflict){form.append(renderClassificationHistory({classification:suggestion.existingClassification}));const checkbox=el('input');checkbox.type='checkbox';checkbox.addEventListener('change',()=>{draft.resolveConflict=checkbox.checked;});const label=el('label','check-row');label.append(checkbox,el('span','','已核对组内分类冲突，确认以上共同分类（各版本原值保留）'));form.append(label);}
      const errorBox = el('div', 'form-error'); errorBox.hidden = true; form.append(errorBox);
      const actions = el('div', 'field-actions'), apply = el('button', 'primary', '确认保存这份分类'); apply.type = 'submit';
      const dismiss = actionButton('忽略建议', () => saveAiSuggestion(suggestion, draft, form, errorBox, false));
      actions.append(apply, dismiss); form.append(actions);
      form.addEventListener('submit', event => { event.preventDefault(); saveAiSuggestion(suggestion, draft, form, errorBox, true); });
      card.append(form); root.append(card);
    });
  }
  async function saveAiSuggestion(suggestion, draft, form, errorBox, apply) {
    const payload = { project: draft.project.trim(), type: draft.type.trim(), tags: [...new Set(draft.tags.split(/[,，;；\n]+/).map(value => value.trim()).filter(Boolean))],confirmTagRemoval:draft.confirmTagRemoval===true,resolveConflict:draft.resolveConflict===true };
    if (apply && !payload.project && !payload.type) { errorBox.textContent = '请至少填写项目或类型中的一项。'; errorBox.hidden = false; return; }
    const controls = [...form.querySelectorAll('input,button')]; controls.forEach(control => { control.disabled = true; }); errorBox.hidden = true;
    try {
      const result = await api(`/api/ai/suggestions/${encodeURIComponent(suggestion.id)}/${apply ? 'apply' : 'dismiss'}`, { method: 'POST', ...(apply ? { body: payload } : {}) });
      state.aiSuggestionDrafts.delete(suggestion.id); state.aiSuggestions = state.aiSuggestions.filter(item => item.id !== suggestion.id);
      form.closest('.ai-suggestion-card').replaceChildren(el('p', 'ai-resolved', `${suggestion.name || '此图纸'}：${apply ? '分类已确认并保存到本地索引' : '已忽略建议'}。`));
      if (apply && result.file) {
        const manualDraft = state.drafts.get(suggestion.fileId);
        if (!manualDraft?.dirty) state.drafts.delete(suggestion.fileId);
        state.items = state.items.map(file => file.id === result.file.id ? { ...file, ...result.file } : file);
        if (state.selectedId === result.file.id) { state.selectedFile = { ...state.selectedFile, ...result.file }; renderDetail(state.selectedFile); }
        renderResults();
        notice(manualDraft?.dirty ? 'AI 分类已保存；详情中的手工分类草稿仍保留，尚未保存。' : 'AI 建议已确认，分类已保存到本地索引。');
      } else notice('已忽略这条 AI 建议。');
      await refreshStatus(); if (state.mode === 'keyword') await loadFiles({ quiet: true });
    } catch (error) { errorBox.textContent = `${error.message} 可检查后重试；过期建议需重新分析。`; errorBox.hidden = false; notice(error.message, true); }
    finally { controls.forEach(control => { control.disabled = false; }); }
  }
  function closeAiSuggestions() { ++state.aiDialogRequest; state.aiDialogLoading = false; $('ai-suggestions-dialog').close(); }

  function renderRuleSelection(){
    const items=state.rulesPreview?.items||[],chosen=items.filter(item=>state.rulesSelections.get(item.id)?.checked);
    const unresolved=chosen.some(item=>item.conflict&&!state.rulesSelections.get(item.id).resolveConflict);
    $('local-rules-apply').disabled=state.rulesBusy||!chosen.length||unresolved;
    $('local-rules-apply').textContent=`确认所选 ${chosen.length} 组分类`;
    $('local-rules-summary').textContent=`范围共 ${number(state.rulesPreview?.total)} 组 · 本批 ${items.length} 组 · 冲突 ${items.filter(item=>item.conflict).length} 组${unresolved?' · 所选冲突需明确复核':''}`;
  }
  function renderRulePreview(){
    const root=$('local-rules-body');root.replaceChildren();state.rulesSelections.clear();
    (state.rulesPreview?.items||[]).forEach(item=>{
      const decision={checked:item.actionable&&!item.conflict,resolveConflict:false};state.rulesSelections.set(item.id,decision);
      const card=el('section',item.conflict?'ai-suggestion-card classification-conflict':'ai-suggestion-card');
      const checkbox=el('input');checkbox.type='checkbox';checkbox.checked=decision.checked;checkbox.disabled=!item.actionable;checkbox.setAttribute('aria-label',`选择 ${item.name}`);checkbox.addEventListener('change',()=>{decision.checked=checkbox.checked;renderRuleSelection();});
      const heading=el('label','check-row');heading.append(checkbox,el('strong','',item.name));card.append(heading);
      card.append(el('p','small',`已有：${item.current.project||'未设项目'} / ${item.current.type||'未设类型'}；标签 ${(item.current.tags||[]).join('，')||'无'}`));
      card.append(el('p','',`规则建议：${item.suggestion.project||'项目待确认'} / ${item.suggestion.type||'类型待确认'}；追加标签 ${(item.suggestion.tags||[]).join('，')||'无'}`));
      card.append(el('p','small',(item.suggestion.reasons||[]).join('；')));
      if(item.conflicts?.length){const list=el('ul');item.conflicts.forEach(value=>list.append(el('li','',value)));card.append(list);}
      if(item.current?.conflict)card.append(renderClassificationHistory({classification:item.current}));
      if(item.conflict&&item.actionable){const resolve=el('input');resolve.type='checkbox';resolve.setAttribute('aria-label',`确认冲突 ${item.name}`);resolve.addEventListener('change',()=>{decision.resolveConflict=resolve.checked;renderRuleSelection();});const label=el('label','check-row');label.append(resolve,el('span','','已核对差异，明确采用本组规则建议替换冲突共同值（版本原值保留）'));card.append(label);}
      const versions=el('details');versions.append(el('summary','','查看各版本规则依据'));(item.versionSuggestions||[]).forEach(v=>versions.append(el('p','small',`${v.name}：${v.project||'未设项目'} / ${v.type||'未设类型'}；${(v.reasons||[]).join('；')}`)));card.append(versions);
      if(!item.actionable)card.append(el('p','notice','建议不完整或标签超限，请打开图纸详情人工处理。'));
      root.append(card);
    });
    if(!state.rulesPreview?.items.length)root.append(el('div','empty','当前范围没有可预览的图纸组。'));
    renderRuleSelection();
  }
  async function previewRules(page=1){
    if(state.rulesBusy)return;state.rulesBusy=true;state.rulesPreview=null;state.rulesSelections.clear();$('local-rules-error').hidden=true;$('local-rules-body').replaceChildren(el('p','','正在生成本机规则预览…'));renderRuleSelection();
    try{state.rulesPage=page;state.rulesApplied=false;state.rulesPreview=await api('/api/rules/preview',{method:'POST',body:{scope:currentAiScope(),query:state.query,includeClassified:$('local-rules-include').checked,limit:Number($('local-rules-limit').value),page}});state.rulesPage=state.rulesPreview.page;renderRulePreview();}
    catch(error){$('local-rules-error').textContent=error.message;$('local-rules-error').hidden=false;}
    finally{state.rulesBusy=false;renderRuleSelection();}
  }
  async function applyRules(){
    if(state.rulesBusy||!state.rulesPreview)return;
    const selections=state.rulesPreview.items.filter(item=>state.rulesSelections.get(item.id)?.checked).map(item=>({id:item.id,stamp:item.stamp,resolveConflict:state.rulesSelections.get(item.id).resolveConflict}));
    if(!selections.length)return;state.rulesBusy=true;renderRuleSelection();$('local-rules-error').hidden=true;
    try{
      const result=await api('/api/rules/apply',{method:'POST',body:{previewId:state.rulesPreview.previewId,selections}});
      $('local-rules-body').replaceChildren(el('p','ai-resolved',`已确认 ${result.applied} 组共同分类。点击“预览下一批”继续；原文件和版本原值保留。`));
      state.rulesSelections.clear();notice(`本机规则已整理 ${result.applied} 组，未调用 AI。`);await refreshStatus();await loadFiles({quiet:true});
      state.rulesApplied=true;
    }catch(error){$('local-rules-error').textContent=error.message;$('local-rules-error').hidden=false;}
    finally{state.rulesBusy=false;renderRuleSelection();}
  }
  function openLocalRules(){if(state.mode!=='keyword')return;$('local-rules-dialog').showModal();$('local-rules-scope').textContent=`当前范围：${scopeTitle()}${state.query?'；关键词：'+state.query:''}。整组共同分类；每批最多50组，冲突需单独确认。`;previewRules();}

  function lines(value) { return [...new Set(value.split(/\r?\n/).map(item => item.trim().replace(/^"|"$/g, '')).filter(Boolean))]; }
  function settingsChanged(event) {
    if (event?.target?.closest('#ai-settings-section')) return;
    if (state.settingsLoading) return;
    state.settingsDirty = true;
    $('settings-dirty-note').textContent = '有未保存的修改';
    $('settings-save').disabled = state.settingsSaving;
  }

  function appendRule(rule = {}) {
    const row = el('tr');
    [['keyword', '关键词'], ['project', '建议项目'], ['type', '建议类型']].forEach(([key, label]) => {
      const cell = el('td'); const input = el('input');
      input.type = 'text'; input.value = rule[key] || ''; input.dataset.ruleField = key;
      input.setAttribute('aria-label', label); input.placeholder = label; input.maxLength = 120;
      cell.append(input); row.append(cell);
    });
    const operation = el('td');
    operation.append(actionButton('删除', () => { row.remove(); settingsChanged(); })); row.append(operation);
    $('rules-body').append(row);
  }

  function appendGroupRule(rule={name:'',backupRoot:'',sourceRoot:'',enabled:true}){
    const row=el('div','group-rule-row');
    [['name','规则名称'],['backupRoot','备份目录'],['sourceRoot','对应原图目录']].forEach(([field,label])=>{
      const input=el('input');input.type='text';input.value=rule[field]||'';input.dataset.groupField=field;input.required=true;input.setAttribute('aria-label',label);input.spellcheck=false;
      const wrapper=el('label','',label);wrapper.append(input);row.append(wrapper);
    });
    const checkbox=el('input');checkbox.type='checkbox';checkbox.checked=rule.enabled!==false;checkbox.dataset.groupField='enabled';
    const enabled=el('label','check-row');enabled.append(checkbox,el('span','','启用此规则'));
    row.append(enabled,actionButton('移除来源规则',()=>{row.remove();settingsChanged();}));
    const count=state.status?.stats?.groupingRules?.find(item=>item.name===rule.name)?.matchedFiles;
    if(count!==undefined)row.append(el('span','small',`当前匹配 ${number(count)} 个备份文件`));
    $('grouping-rules-body').append(row);
  }

  function fillSettings(settings) {
    state.settingsLoading = true;
    const pdf = settings.pdf || {};
    $('setting-pdf-mode').value = pdf.displayMode || 'drawings-pending';
    $('setting-pdf-index').checked = pdf.indexText !== false;
    $('setting-pdf-skip-named').checked = pdf.skipNamedDrawings !== false;
    $('setting-pdf-ocr').checked = pdf.ocrEnabled !== false;
    $('setting-pdf-pages').value = pdf.maxPages || 30;
    $('setting-pdf-ocr-pages').value = pdf.ocrMaxPages || 10;
    $('setting-pdf-includes').value = (pdf.includeKeywords || []).join('\n');
    $('setting-pdf-excludes').value = (pdf.excludeKeywords || []).join('\n');
    $('setting-roots').value = (settings.roots || []).join('\n');
    $('setting-extensions').value = (settings.extensions || []).join(' ');
    $('setting-excludes').value = (settings.excludeDirs || []).join('\n');
    $('setting-watch').checked = Boolean(settings.watch);
    $('setting-grouping').checked=settings.versionGrouping!==false;
    $('grouping-rules-body').replaceChildren();(settings.groupingRules||[]).forEach(appendGroupRule);
    $('setting-rescan').value = settings.rescanMinutes ?? 30;
    $('setting-autostart').checked = Boolean(settings.autoStart);
    const pageValue = String(settings.pageSize || 50);
    if (![...$('setting-page-size').options].some(option => option.value === pageValue)) {
      const option = el('option', '', `${pageValue} 份`); option.value = pageValue; $('setting-page-size').append(option);
    }
    $('setting-page-size').value = pageValue;
    $('rules-body').replaceChildren(); (settings.classificationRules || []).forEach(appendRule);
    state.settingsLoading = false; state.settingsDirty = false;
    $('settings-dirty-note').textContent = '设置已从本机读取';
    $('settings-save').disabled = false;
  }

  async function openSettings() {
    if (state.settingsOpen) return;
    state.settingsOpen = true;
    $('settings-dialog').showModal();
    $('settings-error').hidden = true;
    const aiLoading = loadAiSettings();
    if (state.settings && state.settingsDirty) {
      $('settings-dirty-note').textContent = '已恢复上次未保存的修改'; await aiLoading; return;
    }
    state.settingsLoading = true; $('settings-save').disabled = true;
    $('settings-dirty-note').textContent = '正在读取本机设置…';
    try {
      const settings = await api('/api/settings');
      state.settings = settings; fillSettings(settings);
      if (state.status) renderMaintenance(state.status);
    } catch (error) {
      $('settings-error').textContent = error.message; $('settings-error').hidden = false;
      $('settings-dirty-note').textContent = '读取失败，关闭后可重试';
    } finally { state.settingsLoading = false; await aiLoading; }
  }

  function closeSettings() {
    if (state.settingsSaving || state.aiSettingsSaving) return;
    state.settingsOpen = false; $('settings-dialog').close();
    $('add-root-row').hidden = true;
    if ($('ai-key').value) {
      $('ai-key').value = '';
      $('ai-dirty-note').textContent = '关闭设置时已清空未保存的密钥输入；其他修改保留';
    }
  }

  function settingsPayload() {
    const roots = lines($('setting-roots').value);
    if (!roots.length) throw new Error('请至少填写一个盘符或文件夹路径。');
    if (roots.some(path => !/^(?:[a-zA-Z]:[\\/]|\\\\[^\\]+[\\/])/.test(path))) throw new Error('扫描位置需要完整路径，例如 D:\\CAD图纸 或 \\\\服务器\\共享文件夹。');
    const extensions = [...new Set($('setting-extensions').value.split(/[\s,，;；]+/).map(value => value.trim().toLowerCase()).filter(Boolean).map(value => value.startsWith('.') ? value : `.${value}`))];
    if (!extensions.length || extensions.some(value => !/^\.[a-z0-9]+$/.test(value))) throw new Error('请填写有效的文件扩展名，例如 .dwg .dxf .pdf。');
    const rescanMinutes = Number($('setting-rescan').value);
    if (!Number.isInteger(rescanMinutes) || rescanMinutes < 1 || rescanMinutes > 1440) throw new Error('补充扫描间隔应为 1–1440 分钟的整数。');
    const classificationRules = [];
    [...$('rules-body').rows].forEach((row, index) => {
      const rule = {};
      row.querySelectorAll('[data-rule-field]').forEach(input => { rule[input.dataset.ruleField] = input.value.trim(); });
      if (!rule.keyword && !rule.project && !rule.type) return;
      if (!rule.keyword || (!rule.project && !rule.type)) throw new Error(`第 ${index + 1} 条分类规则需要关键词，以及项目或类型中的至少一项。`);
      classificationRules.push(rule);
    });
    const groupingRules=[...$('grouping-rules-body').children].map(row=>{const rule={};row.querySelectorAll('[data-group-field]').forEach(input=>{rule[input.dataset.groupField]=input.type==='checkbox'?input.checked:input.value.trim();});return rule;});
    return { roots, extensions, excludeDirs: lines($('setting-excludes').value), watch: $('setting-watch').checked, versionGrouping:$('setting-grouping').checked,groupingRules,
      pdf: { displayMode: $('setting-pdf-mode').value, indexText: $('setting-pdf-index').checked, skipNamedDrawings: $('setting-pdf-skip-named').checked, ocrEnabled: $('setting-pdf-ocr').checked, maxPages: Number($('setting-pdf-pages').value), ocrMaxPages: Number($('setting-pdf-ocr-pages').value), includeKeywords: lines($('setting-pdf-includes').value), excludeKeywords: lines($('setting-pdf-excludes').value) },
      rescanMinutes, pageSize: Number($('setting-page-size').value), autoStart: $('setting-autostart').checked, classificationRules };
  }

  async function saveSettings(event) {
    event.preventDefault();
    if (state.settingsLoading || state.settingsSaving) return;
    const errorBox = $('settings-error'); errorBox.hidden = true;
    let payload;
    try { payload = settingsPayload(); } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; errorBox.scrollIntoView({ block: 'nearest' }); return; }
    state.settingsSaving = true;
    $('settings-form').querySelectorAll('fieldset:not(#ai-settings-section)').forEach(fieldset => { fieldset.disabled = true; });
    $('settings-save').disabled = true; $('settings-save').textContent = '保存中…';
    $('settings-close').disabled = true; $('settings-cancel').disabled = true;
    try {
      const result = await api('/api/settings', { method: 'PUT', body: payload });
      state.settings = result.settings; state.limit = Number(result.settings.pageSize || payload.pageSize); state.page = 1;
      fillSettings(result.settings);
      state.pdfMode = result.settings.pdf?.displayMode || 'drawings-pending'; $('pdf-mode').value = state.pdfMode;
      if (['documents','pending'].includes(state.pdfMode)) { state.format='PDF'; $('format-filter').value='PDF'; }
      if (state.mode === 'ai') invalidateAiSearch('扫描设置已保存，请按当前索引范围手动重新 AI 搜索。');
      $('settings-dirty-note').textContent = result.reindexing ? '设置已保存，正在重新扫描' : '设置已保存';
      notice(result.reindexing ? '设置已保存，已开始按新范围扫描。' : '设置已保存到本机。');
      await refreshStatus(); await loadFiles({ quiet: true });
    } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; notice(error.message, true); }
    finally {
      state.settingsSaving = false; $('settings-save').disabled = false; $('settings-save').textContent = '保存设置';
      $('settings-form').querySelectorAll('fieldset:not(#ai-settings-section)').forEach(fieldset => { fieldset.disabled = false; });
      $('settings-close').disabled = false; $('settings-cancel').disabled = false;
    }
  }

  async function scan() {
    if (state.scanBusy || state.status?.indexing?.running) return;
    state.scanBusy = true; $('scan-button').disabled = true; $('settings-scan').disabled = true;
    try {
      await api('/api/index/scan', { method: 'POST' });
      notice('已提交真实扫描任务，进度会自动更新。'); errorFor('action', '');
      await refreshStatus();
    } catch (error) { errorFor('action', error.message); notice(error.message, true); }
    finally { state.scanBusy = false; if (state.status) renderStatus(state.status); else { $('scan-button').disabled = false; $('settings-scan').disabled = false; } }
  }

  async function backup() {
    const button = $('backup-button'); button.disabled = true; button.textContent = '备份中…';
    try {
      const result = await api('/api/backup', { method: 'POST' });
      if (!result.path) throw new Error('本机服务未返回备份路径，请检查备份结果。');
      $('backup-result').textContent = `备份已生成：${result.path}`; $('backup-result').hidden = false;
      notice('本地索引备份已生成，保存路径见设置中的“索引与维护”。');
    } catch (error) { $('settings-error').textContent = error.message; $('settings-error').hidden = false; notice(error.message, true); }
    finally { button.disabled = false; button.textContent = '备份本地索引'; }
  }

  $('main-nav').addEventListener('click', event => {
    const button = event.target.closest('[data-scope-kind]');
    if (button) changeScope(button.dataset.scopeKind, button.dataset.scopeValue || '');
  });
  $('query').addEventListener('input', () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = null;
    if (state.mode === 'ai') { invalidateAiSearch('查询已变化，请点击“AI 搜索”手动查找。'); return; }
    state.searchTimer = setTimeout(() => { state.searchTimer = null; state.query = $('query').value.trim(); state.page = 1; loadFiles(); }, 280);
  });
  $('search-form').addEventListener('submit', event => {
    event.preventDefault(); clearTimeout(state.searchTimer); state.searchTimer = null;
    state.query = $('query').value.trim(); state.page = 1;
    if (state.mode === 'ai') searchAi(); else loadFiles();
  });
  $('format-filter').addEventListener('change', () => { state.format = $('format-filter').value; state.page = 1; updateActiveNavigation(); if (state.mode === 'ai') invalidateAiSearch('文件格式已变化，请点击“AI 搜索”按新范围查找。'); else loadFiles(); });
  $('sort').addEventListener('change', () => { if (state.mode !== 'keyword') return; state.sort = $('sort').value; state.page = 1; loadFiles(); });
  $('previous-page').addEventListener('click', () => { if (state.mode === 'keyword' && state.page > 1) { state.page--; loadFiles(); } });
  $('next-page').addEventListener('click', () => { if (state.mode === 'keyword' && state.page < Math.ceil(state.total / state.limit)) { state.page++; loadFiles(); } });
  $('keyword-search-button').addEventListener('click', () => setSearchMode('keyword'));
  $('ai-search-button').addEventListener('click', () => setSearchMode('ai'));
  $('ai-batch-button').addEventListener('click', () => {
    if (state.filesLoading || aiBusy() || (state.mode === 'ai' && state.aiSearchStale)) return;
    const files = batchFiles();
    if (!files.length) { notice('当前页没有可分析的待整理图纸。'); return; }
    openAiSuggestions(files.map(file => file.id), true);
  });
  $('ai-settings-section').addEventListener('input', aiSettingsChanged);
  $('local-rules-button').addEventListener('click',openLocalRules);
  $('local-rules-close').addEventListener('click',()=>{if(!state.rulesBusy)$('local-rules-dialog').close();});
  $('local-rules-dialog').addEventListener('cancel',event=>{if(state.rulesBusy)event.preventDefault();});
  $('local-rules-refresh').addEventListener('click',()=>previewRules(1));
  $('local-rules-next').addEventListener('click',()=>previewRules(!$('local-rules-include').checked&&state.rulesApplied?1:state.rulesPage+1));
  $('local-rules-apply').addEventListener('click',applyRules);
  $('ai-settings-section').addEventListener('change', aiSettingsChanged);
  $('ai-settings-form').addEventListener('submit', saveAiSettings);
  $('ai-test-button').addEventListener('click', testAiConnection);
  $('ai-clear-key').addEventListener('click', event => saveAiSettings(event, true));
  $('ai-suggestions-close').addEventListener('click', closeAiSuggestions);
  $('ai-suggestions-dialog').addEventListener('cancel', event => { event.preventDefault(); closeAiSuggestions(); });
  $('ai-suggestions-retry').addEventListener('click', () => runAiClassification([...state.aiLastIds]));
  $('settings-open').addEventListener('click', openSettings); $('sidebar-settings').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', closeSettings); $('settings-cancel').addEventListener('click', closeSettings);
  $('settings-dialog').addEventListener('cancel', event => { event.preventDefault(); closeSettings(); });
  $('settings-dialog').addEventListener('click', event => { if (event.target === $('settings-dialog')) { const bounds = $('settings-dialog').getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeSettings(); } });
  $('settings-form').addEventListener('input', settingsChanged); $('settings-form').addEventListener('change', settingsChanged);
  $('settings-form').addEventListener('submit', saveSettings);
  $('add-rule').addEventListener('click', () => { appendRule(); settingsChanged(); $('rules-body').lastElementChild?.querySelector('input')?.focus(); });
  $('add-group-rule').addEventListener('click',()=>{appendGroupRule();settingsChanged();});
  $('add-root').addEventListener('click', () => { $('add-root-row').hidden = false; $('new-root').value = ''; $('new-root').focus(); });
  $('cancel-root').addEventListener('click', () => { $('add-root-row').hidden = true; });
  function addRoot() {
    const value = $('new-root').value.trim().replace(/^"|"$/g, '');
    if (!value) { $('new-root').focus(); return; }
    $('setting-roots').value = [...new Set([...lines($('setting-roots').value), value])].join('\n');
    $('add-root-row').hidden = true; settingsChanged();
  }
  $('confirm-root').addEventListener('click', addRoot);
  $('new-root').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addRoot(); } });
  $('pdf-mode').addEventListener('change',()=>{
    state.pdfMode=$('pdf-mode').value;state.page=1;state.detailRequest++;state.selectedFile=null;
    if(['documents','pending'].includes(state.pdfMode)){state.format='PDF';$('format-filter').value='PDF';}
    if(state.mode==='ai')invalidateAiSearch('PDF 显示范围已变化，请手动重新搜索。');else loadFiles();
  });
  $('pdf-reindex').addEventListener('click',()=>pdfReindex(false));
  $('pdf-cancel').addEventListener('click',()=>pdfReindex(true));
  $('scan-button').addEventListener('click', scan); $('settings-scan').addEventListener('click', scan); $('backup-button').addEventListener('click', backup);

  async function poll() {
    if (state.pollBusy || document.hidden) return;
    state.pollBusy = true;
    try {
      const previous = state.status;
      const current = await refreshStatus();
      const changed = current && (current.indexing?.lastEventAt !== previous?.indexing?.lastEventAt || current.stats?.total !== previous?.stats?.total || current.stats?.pending !== previous?.stats?.pending || current.pdfIndex?.processed !== previous?.pdfIndex?.processed || Boolean(previous?.indexing?.running && !current.indexing?.running));
      if (current && state.mode === 'keyword' && !state.filesLoading && !state.searchTimer && (changed || Date.now() - state.lastResultRefresh > 15000)) await loadFiles({ quiet: true });
    } finally { state.pollBusy = false; }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  window.addEventListener('beforeunload', event => {
    if (state.settingsDirty || state.aiDirty || [...state.drafts.values(), ...state.aiSuggestionDrafts.values()].some(draft => draft.dirty)) { event.preventDefault(); event.returnValue = ''; }
  });

  (async () => { await refreshStatus(); await Promise.all([loadFiles(), loadAiSettings()]); setInterval(poll, 3000); })();
})();

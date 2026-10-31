/*
 * Copyright (c) 2026 dsh-rfiles contributors
 * SPDX-License-Identifier: GPL-3.0-only
 * See LICENSE for current terms and NOTICE for historical MIT permissions.
 */

/*
 * dsh-rfiles 客户端小部件（vanilla JS，经典脚本，无构建步骤、无外部依赖）
 * ---------------------------------------------------------------------------
 * 由 dsh-rfiles Host 半区通过 webserver/index-inject 注入到官方 index 的 <head>，
 * 早于 GUI boot 执行。DOM 就绪后挂一个右下角浮动按钮（「文件」），点击打开面板。
 *
 * 契约要点（见 CONTRACT.md §3）：
 * - 注入的全局只有 window.__DSH_RFILES__ = { remote, version }（不注入 sessionId，
 *   因为 index 是所有会话共享的）；会话列表在面板打开时 GET /api/rfiles.sessions 获取，
 *   默认选中最后一个（最近创建），下拉可切换；列表为空提示先打开会话。
 * - 远程判定是「运行时」检查第三方配对通道 boot 补丁发布的全局
 *   __DSH_REMOTE_CHANNEL_BOOT__；不能用 hostname，也不能依赖注入的 remote 标志
 *   （LAN HTTP 直连且没装配对插件时 hostname 同样不是回环，但下载必须走 /api）。
 * - 业务请求统一写 /api/rfiles.*：远程页的第三方 boot patch 会自动改写成
 *   /remote/api/rfiles.* 并附带设备凭据；不要手动加 /remote 前缀。
 * - 只有 <a download> 导航不会被改写，所以下载链接 href 必须是
 *   (remote ? '/remote' : '') + '/api/rfiles.download?...'。
 * - 分块上传用 fetch（XHR 不在改写范围），File.slice -> PUT，8 MiB 一块。
 * - 错误响应统一为 { ok:false, error:{ code, message } }；401/403 提示重新扫码配对。
 *
 * 注意：本文件会被原样内联进 <script> 标签，源码中不得出现 <\/script 子串，
 * 也不得出现 HTML 注释起始符；保持经典脚本语法（不使用 import/export）。
 */
(function () {
  'use strict';

  var CLIENT_FLAG = '__DSH_RFILES_CLIENT__';
  if (window[CLIENT_FLAG]) { return; }
  window[CLIENT_FLAG] = true;

  var UI_HOST_ID = 'dsh-rfiles-host';
  var CLIENT_VERSION = '1';
  var CHUNK_FALLBACK = 8 * 1024 * 1024;
  var MAX_FILE_FALLBACK = 2 * 1024 * 1024 * 1024;
  var RESUME_PREFIX = 'dsh-rfiles:resume:';
  var RESUME_TTL = 24 * 60 * 60 * 1000; // 暂存区可能被清理，超过 24h 的续传记录不再使用

  // ---------------------------------------------------------------------------
  // 小工具
  // ---------------------------------------------------------------------------

  function makeError(code, message, extra) {
    var err = new Error(message || code || 'error');
    err.code = code || 'error';
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) { err[key] = extra[key]; }
      }
    }
    return err;
  }

  function isAbortError(err) {
    return !!err && (err.name === 'AbortError' || err.code === 'cancelled' || err.code === 'aborted');
  }

  function enc(value) { return encodeURIComponent(String(value == null ? '' : value)); }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) { return n + ' B'; }
    var units = ['KB', 'MB', 'GB', 'TB'];
    var value = n / 1024;
    var index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
    return (value >= 10 ? value.toFixed(0) : value.toFixed(1)) + ' ' + units[index];
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function shortId(id) {
    id = String(id || '');
    if (id.length <= 10) { return id; }
    return id.slice(0, 6) + '…' + id.slice(-3);
  }

  function storeGet(key) {
    try { return window.localStorage ? window.localStorage.getItem(key) : null; } catch (e) { return null; }
  }
  function storeSet(key, value) {
    try { if (window.localStorage) { window.localStorage.setItem(key, value); } } catch (e) { /* 隐私模式忽略 */ }
  }
  function storeDel(key) {
    try { if (window.localStorage) { window.localStorage.removeItem(key); } } catch (e) { /* 忽略 */ }
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text !== undefined && text !== null) { node.textContent = String(text); }
    return node;
  }

  function clearNode(node) {
    if (!node) { return; }
    while (node.firstChild) { node.removeChild(node.firstChild); }
  }

  function closestAttr(node, root, attr) {
    while (node && node !== root) {
      if (node.getAttribute && node.getAttribute(attr) !== null) { return node; }
      node = node.parentNode;
    }
    return null;
  }

  function joinPath(base, name) {
    base = String(base || '');
    name = String(name || '');
    return base ? (base + '/' + name) : name;
  }

  // ---------------------------------------------------------------------------
  // 状态
  // ---------------------------------------------------------------------------

  var state = {
    mounted: false,
    open: false,
    tab: 'upload',
    sessionId: '',
    sessions: [],
    sessionsLoading: false,
    sessionsError: '',
    config: { chunkBytes: CHUNK_FALLBACK, maxFileBytes: MAX_FILE_FALLBACK },
    configLoaded: false,
    items: [],
    nextId: 1,
    running: false,
    current: null,
    abort: null,
    cancelled: false,
    mode: 'send',
    sending: false,
    text: '',
    dl: { path: '', entries: [], loading: false, loaded: false, error: '' }
  };

  var refs = {};
  var noticeTimers = {};

  // ---------------------------------------------------------------------------
  // 远程判定 / 会话选择
  // ---------------------------------------------------------------------------

  // 只有第三方配对通道的 boot 补丁会发布这个全局；loopback 与没装该插件的部署都没有。
  function isRemotePage() {
    try {
      return typeof window.__DSH_REMOTE_CHANNEL_BOOT__ !== 'undefined';
    } catch (e) {
      return false;
    }
  }

  function findSession(sessionId) {
    for (var i = 0; i < state.sessions.length; i += 1) {
      if (state.sessions[i].id === sessionId) { return state.sessions[i]; }
    }
    return null;
  }

  function sessionLabel(session, index) {
    var label = '';
    if (session && typeof session.title === 'string' && session.title) {
      label = session.title;
    } else {
      label = '会话 ' + shortId(session && session.id);
    }
    if (index === state.sessions.length - 1) { label += '（最新）'; }
    return label;
  }

  async function refreshSessions() {
    state.sessionsLoading = true;
    state.sessionsError = '';
    renderSessionSelect();
    var previousSession = state.sessionId;
    try {
      var res = await api('/rfiles.sessions');
      var list = res && Array.isArray(res.sessions) ? res.sessions : [];
      var usable = [];
      for (var i = 0; i < list.length; i += 1) {
        var item = list[i];
        if (item && typeof item.id === 'string' && item.id) { usable.push(item); }
      }
      state.sessions = usable;
      if (!usable.length) {
        state.sessionId = '';
      } else if (!findSession(state.sessionId)) {
        // 契约：默认选中最后一个（最近创建）
        state.sessionId = usable[usable.length - 1].id;
      }
    } catch (err) {
      state.sessions = [];
      state.sessionId = '';
      state.sessionsError = describeError(err);
      showNotice('upload', state.sessionsError, 'error');
    } finally {
      state.sessionsLoading = false;
      if (previousSession !== state.sessionId) { resetDownloadState(); }
      renderHeader();
      renderSessionSelect();
      applySessionVisibility();
      renderUpload();
      renderDownload();
      if (state.sessionId && !state.configLoaded) { loadConfig(); }
    }
  }

  async function loadConfig() {
    try {
      var res = await api('/rfiles.config');
      var limits = res && res.limits ? res.limits : {};
      if (typeof limits.chunkBytes === 'number' && limits.chunkBytes > 0) {
        state.config.chunkBytes = Math.min(limits.chunkBytes, 64 * 1024 * 1024);
      }
      if (typeof limits.maxFileBytes === 'number' && limits.maxFileBytes > 0) {
        state.config.maxFileBytes = limits.maxFileBytes;
      }
      state.configLoaded = true;
    } catch (e) {
      // 配置接口失败不阻塞主流程，保留默认值
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP 层：统一解析契约响应
  // ---------------------------------------------------------------------------

  function fromEnvelope(data, status) {
    var errorObj = (data && data.error) || {};
    var code = typeof errorObj.code === 'string' && errorObj.code ? errorObj.code : ('http-' + status);
    var message = typeof errorObj.message === 'string' ? errorObj.message : '';
    var received;
    if (typeof data.received === 'number') { received = data.received; }
    else if (typeof errorObj.received === 'number') { received = errorObj.received; }
    return makeError(code, message, { status: status, received: received, body: data });
  }

  async function api(pathAndQuery, options) {
    options = options || {};
    var headers = {};
    var sourceHeaders = options.headers || {};
    for (var key in sourceHeaders) {
      if (Object.prototype.hasOwnProperty.call(sourceHeaders, key)) { headers[key] = sourceHeaders[key]; }
    }
    var body = options.body;
    if (options.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.json);
    }
    var init = { method: options.method || 'GET', headers: headers, credentials: 'same-origin' };
    if (body !== undefined && body !== null) { init.body = body; }
    if (options.signal) { init.signal = options.signal; }

    var response;
    try {
      response = await window.fetch('/api' + pathAndQuery, init);
    } catch (err) {
      if (isAbortError(err)) { throw err; }
      throw makeError('network', '网络连接失败，请检查网络后重试', { status: 0 });
    }

    var text = '';
    try { text = await response.text(); } catch (e) { text = ''; }
    var data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (e) { data = null; }
    }

    if (response.ok) {
      if (data && data.ok === false) { throw fromEnvelope(data, response.status); }
      return data || {};
    }
    if (data && data.ok === false) { throw fromEnvelope(data, response.status); }
    var fallback = '请求失败（HTTP ' + response.status + '）';
    if (response.status === 401 || response.status === 403) { fallback = '请重新扫码配对。'; }
    else if (response.status === 404) { fallback = '接口不存在（插件未安装或版本不匹配）。'; }
    throw makeError('http-' + response.status, fallback, { status: response.status, body: data });
  }

  function describeError(err) {
    if (!err) { return '未知错误'; }
    var code = String(err.code || '');
    var status = Number(err.status) || 0;
    if (status === 401 || status === 403) { return '请重新扫码配对。'; }
    switch (code) {
      case 'unpaired':
      case 'unauthorized':
      case 'forbidden':
      case 'no-auth':
      case 'auth-required':
        return '请重新扫码配对。';
      case 'offset-mismatch':
        return '续传位置已过期，正在自动对齐…';
      case 'incomplete':
        return '文件尚未上传完成，请重试。';
      case 'too-large':
      case 'payload-too-large':
      case 'file-too-large':
      case 'quota-exceeded':
        return '文件超过大小限制。';
      case 'not-found':
      case 'enoent':
        return '文件或目录不存在。';
      case 'path-escape':
      case 'invalid-path':
        return '该路径不允许访问。';
      case 'unknown-upload':
      case 'upload-not-found':
      case 'upload-expired':
        return '上传会话已失效，请重新上传。';
      case 'no-session':
      case 'session-not-found':
        return '会话无效或已关闭，请刷新页面重试。';
      case 'network':
        return '网络连接失败，请检查网络后重试。';
      case 'busy':
        return '上一次操作还在进行中，请稍候。';
      case 'is-directory':
        return '这是文件夹，不能直接下载。';
      case 'upload-stalled':
        return '上传进度异常，请重试。';
      case 'http-404':
        return '接口不存在（插件未安装或版本不匹配）。';
      default:
        break;
    }
    if (err.message) { return err.message; }
    if (status) { return '请求失败（HTTP ' + status + '）'; }
    return '请求失败，请重试。';
  }

  // ---------------------------------------------------------------------------
  // 提示条
  // ---------------------------------------------------------------------------

  function showNotice(where, message, tone) {
    var target = where === 'download' ? refs.dlNotice : refs.notice;
    if (!target) { return; }
    target.hidden = !message;
    target.textContent = message || '';
    target.className = 'rf-notice' + (tone === 'error' ? ' is-error' : (tone === 'ok' ? ' is-ok' : ''));
    if (noticeTimers[where]) { window.clearTimeout(noticeTimers[where]); }
    noticeTimers[where] = window.setTimeout(function () {
      noticeTimers[where] = null;
      if (target) { target.hidden = true; target.textContent = ''; }
    }, tone === 'error' ? 9000 : 4500);
  }

  // ---------------------------------------------------------------------------
  // 续传记录（localStorage key 按契约：<sessionId>:<name>:<size>:<lastModified>）
  // ---------------------------------------------------------------------------

  function resumeKey(item) {
    return RESUME_PREFIX + [state.sessionId, item.name, item.size, item.lastModified || 0].join(':');
  }

  function saveResume(item) {
    if (!item || !item.uploadId) { return; }
    storeSet(resumeKey(item), JSON.stringify({
      uploadId: item.uploadId,
      offset: Number(item.sent) || 0,
      mode: item.mode,
      at: Date.now()
    }));
  }

  function loadResume(item) {
    var raw = storeGet(resumeKey(item));
    if (!raw) { return null; }
    var record = null;
    try { record = JSON.parse(raw); } catch (e) { record = null; }
    if (!record || typeof record.uploadId !== 'string' || !record.uploadId) {
      storeDel(resumeKey(item));
      return null;
    }
    if (record.mode !== item.mode) { return null; } // 模式变了就不能复用暂存
    if (!record.at || (Date.now() - record.at) > RESUME_TTL) {
      storeDel(resumeKey(item));
      return null;
    }
    return record;
  }

  function clearResume(item) {
    if (item) { storeDel(resumeKey(item)); }
  }

  // ---------------------------------------------------------------------------
  // 上传
  // ---------------------------------------------------------------------------

  function addFiles(fileList) {
    if (!state.sessionId) {
      showNotice('upload', '请先打开一个会话。', 'error');
      return;
    }
    if (!fileList || !fileList.length) { return; }
    var added = 0;
    var tooLarge = [];
    for (var i = 0; i < fileList.length; i += 1) {
      var file = fileList[i];
      if (!file || typeof file.size !== 'number') { continue; }
      if (file.size > state.config.maxFileBytes) {
        tooLarge.push(file.name + '（' + fmtBytes(file.size) + '）');
        continue;
      }
      state.items.push({
        id: 'f' + (state.nextId++),
        file: file,
        name: file.name || ('未命名-' + state.nextId),
        size: file.size,
        lastModified: file.lastModified || 0,
        mode: state.mode,
        status: 'pending',
        sent: 0,
        uploadId: null,
        result: null,
        error: ''
      });
      added += 1;
    }
    if (tooLarge.length) {
      showNotice('upload', '超过单文件上限 ' + fmtBytes(state.config.maxFileBytes) + '：' + tooLarge.join('、'), 'error');
    } else if (added) {
      showNotice('upload', '已添加 ' + added + ' 个文件', 'info');
    }
    if (added) { startQueue(); } else { renderUpload(); }
  }

  function startQueue() {
    if (state.running) { renderUpload(); return; }
    var hasPending = false;
    for (var i = 0; i < state.items.length; i += 1) {
      if (state.items[i].status === 'pending') { hasPending = true; break; }
    }
    if (!hasPending) { renderUpload(); return; }
    state.running = true;
    state.cancelled = false;
    state.abort = typeof AbortController === 'function' ? new AbortController() : null;
    renderUpload();
    runQueue();
  }

  async function runQueue() {
    try {
      // 用实时长度，让运行中追加的文件也能被本队列接住
      for (var i = 0; i < state.items.length; i += 1) {
        var item = state.items[i];
        if (item.status !== 'pending') { continue; }
        if (state.cancelled) { break; }
        state.current = item;
        item.status = 'uploading';
        item.error = '';
        item.sent = 0;
        item.uploadId = null;
        item.result = null;
        renderUpload();
        try {
          await uploadOne(item);
          item.status = 'done';
        } catch (err) {
          if (isAbortError(err) || state.cancelled) {
            item.status = 'cancelled';
          } else {
            item.status = 'failed';
            item.error = describeError(err);
            showNotice('upload', '「' + item.name + '」上传失败：' + item.error, 'error');
          }
        }
        state.current = null;
        renderUpload();
      }
    } finally {
      state.running = false;
      state.current = null;
      state.abort = null;
      renderUpload();
    }
  }

  async function initUpload(item) {
    var res = await api('/rfiles.upload.init', {
      method: 'POST',
      json: { sessionId: state.sessionId, mode: item.mode, name: item.name, size: item.size },
      signal: state.abort ? state.abort.signal : undefined
    });
    if (!res || typeof res.uploadId !== 'string' || !res.uploadId) {
      throw makeError('bad-response', '服务器未返回 uploadId');
    }
    item.uploadId = res.uploadId;
    item.sent = Math.max(0, Math.min(Number(res.offset) || 0, item.size));
    saveResume(item);
  }

  async function uploadOne(item) {
    var chunkBytes = state.config.chunkBytes || CHUNK_FALLBACK;

    // 1) 优先复用上次未完成的暂存（localStorage 续传）
    if (!item.uploadId) {
      var saved = loadResume(item);
      if (saved) {
        item.uploadId = saved.uploadId;
        item.sent = Math.max(0, Math.min(Number(saved.offset) || 0, item.size));
      }
    }
    if (!item.uploadId) { await initUpload(item); }
    renderUpload();

    // 2) 顺序分块上传
    var guard = Math.ceil(item.size / chunkBytes) + 16;
    while (item.sent < item.size) {
      if (state.cancelled) { throw makeError('cancelled', '已取消'); }
      guard -= 1;
      if (guard <= 0) { throw makeError('upload-stalled', '上传进度异常，请重试'); }
      var startOffset = item.sent;
      var endOffset = Math.min(startOffset + chunkBytes, item.size);
      var blob = item.file.slice(startOffset, endOffset);
      var chunkPath = '/rfiles.upload.chunk?uploadId=' + enc(item.uploadId) + '&offset=' + startOffset;
      var res;
      try {
        res = await api(chunkPath, {
          method: 'PUT',
          body: blob,
          headers: { 'content-type': 'application/octet-stream' },
          signal: state.abort ? state.abort.signal : undefined
        });
      } catch (err) {
        if (isAbortError(err)) { throw err; }
        // offset 不匹配：按服务端返回的 received 续传
        if (err && err.code === 'offset-mismatch' && typeof err.received === 'number') {
          item.sent = Math.max(0, Math.min(err.received, item.size));
          saveResume(item);
          renderUpload();
          continue;
        }
        // 暂存丢失：重开一次上传
        if (err && (err.code === 'unknown-upload' || err.code === 'upload-not-found' || err.code === 'upload-expired' || err.code === 'not-found')) {
          item.uploadId = null;
          item.sent = 0;
          clearResume(item);
          await initUpload(item);
          renderUpload();
          continue;
        }
        throw err;
      }
      var next = endOffset;
      if (res && typeof res.received === 'number') { next = res.received; }
      else if (res && typeof res.offset === 'number') { next = res.offset; }
      if (next <= startOffset) { throw makeError('upload-stalled', '服务器未确认上传进度，请重试'); }
      item.sent = Math.min(next, item.size);
      saveResume(item);
      renderUpload();
    }

    // 3) 收尾（workspace 模式会在此刻移动到工作区）
    var finished = await api('/rfiles.upload.finish', {
      method: 'POST',
      json: { uploadId: item.uploadId },
      signal: state.abort ? state.abort.signal : undefined
    });
    item.result = finished || {};
    if (finished && typeof finished.uploadId === 'string') { item.uploadId = finished.uploadId; }
    clearResume(item);
  }

  function cancelUploads() {
    if (!state.running) { return; }
    state.cancelled = true;
    if (state.abort) { try { state.abort.abort(); } catch (e) { /* 忽略 */ } }
    var current = state.current;
    if (current && current.uploadId) {
      api('/rfiles.upload.cancel', { method: 'POST', json: { uploadId: current.uploadId } }).catch(function () { /* 尽力而为 */ });
      clearResume(current);
      current.uploadId = null;
    }
    for (var i = 0; i < state.items.length; i += 1) {
      var item = state.items[i];
      if (item.status === 'pending') {
        item.status = 'cancelled';
        clearResume(item);
      }
    }
    showNotice('upload', '已取消上传', 'info');
    renderUpload();
  }

  function retryItem(item) {
    if (state.running) { return; }
    if (item.status !== 'failed' && item.status !== 'cancelled') { return; }
    item.status = 'pending';
    item.error = '';
    item.sent = 0;
    item.uploadId = null;
    item.result = null;
    startQueue();
  }

  function removeItem(item) {
    var index = state.items.indexOf(item);
    if (index >= 0) { state.items.splice(index, 1); }
    clearResume(item);
    renderUpload();
  }

  function clearFinished() {
    if (state.running) { return; }
    for (var i = state.items.length - 1; i >= 0; i -= 1) {
      var status = state.items[i].status;
      if (status === 'done' || status === 'failed' || status === 'cancelled') {
        clearResume(state.items[i]);
        state.items.splice(i, 1);
      }
    }
    renderUpload();
  }

  function sendableUploadIds() {
    var ids = [];
    for (var i = 0; i < state.items.length; i += 1) {
      var item = state.items[i];
      if (item.status !== 'done' || item.mode !== 'send') { continue; }
      var id = (item.result && item.result.uploadId) || item.uploadId;
      if (id) { ids.push(id); }
    }
    return ids;
  }

  async function sendToAgent() {
    if (state.sending || state.running) { return; }
    if (!state.sessionId) { showNotice('upload', '请先打开一个会话。', 'error'); return; }
    var ids = sendableUploadIds();
    if (!ids.length) {
      showNotice('upload', '没有可发送的文件', 'error');
      return;
    }
    state.sending = true;
    renderUpload();
    try {
      var text = (state.text || '').trim();
      var payload = { sessionId: state.sessionId, uploadIds: ids };
      if (text) { payload.text = text; }
      var res = await api('/rfiles.send', { method: 'POST', json: payload });
      var sentNames = res && Array.isArray(res.sent) ? res.sent : [];
      showNotice('upload', '已发送给 Agent' + (sentNames.length ? '：' + sentNames.join('、') : ''), 'ok');
      for (var i = state.items.length - 1; i >= 0; i -= 1) {
        var item = state.items[i];
        if (item.status === 'done' && item.mode === 'send') {
          clearResume(item);
          state.items.splice(i, 1);
        }
      }
      state.text = '';
      if (refs.text) { refs.text.value = ''; }
    } catch (err) {
      showNotice('upload', describeError(err), 'error');
    } finally {
      state.sending = false;
      renderUpload();
    }
  }

  // ---------------------------------------------------------------------------
  // 下载
  // ---------------------------------------------------------------------------

  // 业务请求路径（远程会被 boot patch 改写）
  function apiDownloadPath(relPath) {
    return '/rfiles.download?sessionId=' + enc(state.sessionId) + '&path=' + enc(relPath);
  }
  function apiExportPath() {
    return '/rfiles.export?sessionId=' + enc(state.sessionId);
  }
  // 导航 / 下载链接（远程必须显式带 /remote 前缀，运行时判定）
  function navHref(pathAndQuery) {
    return (isRemotePage() ? '/remote' : '') + '/api' + pathAndQuery;
  }

  function resetDownloadState() {
    state.dl = { path: '', entries: [], loading: false, loaded: false, error: '' };
  }

  async function loadList(pathValue) {
    if (!state.sessionId) { applySessionVisibility(); return; }
    if (state.dl.loading) { return; }
    state.dl.loading = true;
    state.dl.error = '';
    renderDownload();
    try {
      var res = await api('/rfiles.list?sessionId=' + enc(state.sessionId) + '&path=' + enc(pathValue || ''));
      state.dl.path = res && typeof res.path === 'string' ? res.path : (pathValue || '');
      state.dl.entries = res && Array.isArray(res.entries) ? res.entries : [];
      state.dl.loaded = true;
    } catch (err) {
      state.dl.entries = [];
      state.dl.error = describeError(err);
      showNotice('download', state.dl.error, 'error');
    } finally {
      state.dl.loading = false;
      renderDownload();
    }
  }

  async function saveViaFetch(pathAndQuery, filename, triggerButton) {
    if (triggerButton) { triggerButton.disabled = true; }
    try {
      var res = await window.fetch('/api' + pathAndQuery, { credentials: 'same-origin' });
      if (!res.ok) {
        var text = '';
        try { text = await res.text(); } catch (e) { text = ''; }
        var data = null;
        if (text) { try { data = JSON.parse(text); } catch (e2) { data = null; } }
        throw fromEnvelope(data, res.status);
      }
      var blob = await res.blob();
      var href = URL.createObjectURL(blob);
      var anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = filename || 'download';
      anchor.style.display = 'none';
      (document.body || document.documentElement).appendChild(anchor);
      anchor.click();
      window.setTimeout(function () {
        try { URL.revokeObjectURL(href); } catch (e) { /* 忽略 */ }
        if (anchor.parentNode) { anchor.parentNode.removeChild(anchor); }
      }, 5000);
      showNotice('download', '已开始保存：' + (filename || '文件'), 'ok');
    } catch (err) {
      showNotice('download', describeError(err), 'error');
    } finally {
      if (triggerButton) { triggerButton.disabled = false; }
    }
  }

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------

  function renderHeader() {
    if (refs.remoteBadge) { refs.remoteBadge.hidden = !isRemotePage(); }
  }

  function renderSessionSelect() {
    if (!refs.sessionSelect) { return; }
    var select = refs.sessionSelect;
    clearNode(select);
    if (state.sessionsLoading) {
      var loadingOption = el('option', '', '加载会话…');
      loadingOption.value = '';
      select.appendChild(loadingOption);
      select.disabled = true;
      return;
    }
    if (!state.sessions.length) {
      var emptyOption = el('option', '', state.sessionsError ? '会话加载失败' : '（没有打开的会话）');
      emptyOption.value = '';
      select.appendChild(emptyOption);
      select.disabled = true;
      return;
    }
    select.disabled = false;
    for (var i = 0; i < state.sessions.length; i += 1) {
      var session = state.sessions[i];
      var option = el('option', '', sessionLabel(session, i));
      option.value = session.id;
      if (session.cwd) { option.title = String(session.cwd); }
      select.appendChild(option);
    }
    select.value = state.sessionId;
  }

  function itemMeta(item) {
    var parts = [fmtBytes(item.size)];
    switch (item.status) {
      case 'pending':
        parts.push('等待上传');
        break;
      case 'uploading': {
        var pct = item.size > 0 ? Math.floor((Number(item.sent) || 0) * 100 / item.size) : 0;
        parts.push(pct + '%');
        break;
      }
      case 'done':
        if (item.mode === 'workspace' && item.result && item.result.path) {
          parts.push('已存入 ' + item.result.path);
        } else if (item.result && item.result.name) {
          parts.push('已上传，待发送');
        } else {
          parts.push('完成');
        }
        break;
      case 'failed':
        parts.push('失败：' + (item.error || '未知错误'));
        break;
      case 'cancelled':
        parts.push('已取消');
        break;
      default:
        break;
    }
    return parts.join(' · ');
  }

  function renderUpload() {
    if (!refs.queue) { return; }
    clearNode(refs.queue);
    for (var i = 0; i < state.items.length; i += 1) {
      var item = state.items[i];
      var li = el('li', 'rf-item');
      var nameNode = el('div', 'rf-item-name', item.name);
      nameNode.title = item.name;
      li.appendChild(nameNode);
      li.appendChild(el('div', 'rf-item-meta', itemMeta(item)));

      var ops = el('div', 'rf-item-ops');
      if ((item.status === 'failed' || item.status === 'cancelled') && !state.running) {
        var retryBtn = el('button', 'rf-mini rf-btn', '重试');
        retryBtn.type = 'button';
        retryBtn.setAttribute('aria-label', '重试 ' + item.name);
        retryBtn.addEventListener('click', (function (target) {
          return function () { retryItem(target); };
        })(item));
        ops.appendChild(retryBtn);
      }
      if (!state.running && item.status !== 'uploading') {
        var removeBtn = el('button', 'rf-mini rf-btn rf-btn-ghost', '移除');
        removeBtn.type = 'button';
        removeBtn.setAttribute('aria-label', '移除 ' + item.name);
        removeBtn.addEventListener('click', (function (target) {
          return function () { removeItem(target); };
        })(item));
        ops.appendChild(removeBtn);
      }
      if (ops.firstChild) { li.appendChild(ops); }
      refs.queue.appendChild(li);
    }
    refs.queue.hidden = state.items.length === 0;
    if (refs.uploadEmpty) { refs.uploadEmpty.hidden = state.items.length > 0; }

    var total = 0;
    var sent = 0;
    for (var k = 0; k < state.items.length; k += 1) {
      total += state.items[k].size;
      sent += Math.min(Number(state.items[k].sent) || 0, state.items[k].size);
    }
    var showProgress = total > 0 && (state.running || sent > 0);
    if (refs.progressWrap) { refs.progressWrap.hidden = !showProgress; }
    if (showProgress) {
      var pct = total > 0 ? Math.floor(sent * 100 / total) : 0;
      if (refs.progressBar) { refs.progressBar.style.width = Math.max(2, Math.min(100, pct)) + '%'; }
      if (refs.progressMeta) {
        refs.progressMeta.textContent = '已传 ' + fmtBytes(sent) + ' / ' + fmtBytes(total) + '（' + pct + '%）';
      }
    }
    if (refs.cancelBtn) { refs.cancelBtn.hidden = !state.running; }
    if (refs.clearBtn) { refs.clearBtn.hidden = state.running || state.items.length === 0; }

    var hasSendable = sendableUploadIds().length > 0;
    if (refs.sendBox) { refs.sendBox.hidden = !hasSendable; }
    if (refs.sendBtn) {
      refs.sendBtn.disabled = state.sending || state.running;
      refs.sendBtn.textContent = state.sending ? '发送中…' : '发送给 Agent';
    }
    if (refs.sendHint) {
      var stored = 0;
      for (var s = 0; s < state.items.length; s += 1) {
        if (state.items[s].status === 'done' && state.items[s].mode === 'workspace') { stored += 1; }
      }
      refs.sendHint.textContent = stored > 0
        ? ('另有 ' + stored + ' 个文件已存入工作区，可在「下载」标签页查看。')
        : '文件将作为附件随消息发送给 Agent。';
    }
  }

  function renderCrumbs() {
    if (!refs.crumbs) { return; }
    clearNode(refs.crumbs);
    var rootBtn = el('button', 'rf-crumb', '工作区');
    rootBtn.type = 'button';
    rootBtn.addEventListener('click', function () { loadList(''); });
    refs.crumbs.appendChild(rootBtn);
    var path = String(state.dl.path || '');
    if (!path) { return; }
    var segments = path.split('/');
    for (var i = 0; i < segments.length; i += 1) {
      refs.crumbs.appendChild(el('span', 'rf-crumb-sep', '/'));
      var target = segments.slice(0, i + 1).join('/');
      var btn = el('button', 'rf-crumb', segments[i]);
      btn.type = 'button';
      btn.addEventListener('click', (function (targetPath) {
        return function () { loadList(targetPath); };
      })(target));
      refs.crumbs.appendChild(btn);
    }
  }

  function renderEntry(entry) {
    var li = el('li', 'rf-entry');
    var name = entry && entry.name ? String(entry.name) : '';
    var relPath = joinPath(state.dl.path, name);
    if (entry && entry.kind === 'dir') {
      var dirBtn = el('button', 'rf-entry-main');
      dirBtn.type = 'button';
      dirBtn.appendChild(el('span', 'rf-entry-ico', '📁'));
      var dirName = el('span', 'rf-entry-name', name);
      dirName.title = name;
      dirBtn.appendChild(dirName);
      dirBtn.appendChild(el('span', 'rf-entry-meta', '文件夹'));
      dirBtn.addEventListener('click', function () { loadList(relPath); });
      li.appendChild(dirBtn);
      return li;
    }
    // 文件：主链接触发浏览器原生下载（远程带 /remote 前缀）
    var link = el('a', 'rf-entry-main');
    link.href = navHref(apiDownloadPath(relPath));
    link.setAttribute('download', name || 'download');
    link.rel = 'noopener';
    link.appendChild(el('span', 'rf-entry-ico', '📄'));
    var fileName = el('span', 'rf-entry-name', name);
    fileName.title = name;
    link.appendChild(fileName);
    link.appendChild(el('span', 'rf-entry-meta', fmtBytes(entry ? entry.size : 0)));
    // 下载是导航请求，不经过 fetch 改写；点击时再按运行时远程状态刷新一次 href
    link.addEventListener('click', function () {
      link.href = navHref(apiDownloadPath(relPath));
    });
    li.appendChild(link);

    // 兜底：fetch + blob 保存（无 cookie 的设备也能用，因为 fetch 会被改写并带设备头）
    var saveBtn = el('button', 'rf-mini rf-btn rf-btn-ghost', '⤓');
    saveBtn.type = 'button';
    saveBtn.title = '通过请求保存（无 cookie 时可用）';
    saveBtn.setAttribute('aria-label', '通过请求保存 ' + name);
    saveBtn.addEventListener('click', function () {
      saveViaFetch(apiDownloadPath(relPath), name || 'download', saveBtn);
    });
    li.appendChild(saveBtn);
    return li;
  }

  function renderDownload() {
    if (!refs.entries) { return; }
    if (refs.exportLink) {
      if (state.sessionId) {
        refs.exportLink.setAttribute('href', navHref(apiExportPath()));
        refs.exportLink.removeAttribute('aria-disabled');
      } else {
        refs.exportLink.setAttribute('href', '#');
        refs.exportLink.setAttribute('aria-disabled', 'true');
      }
    }
    renderCrumbs();
    clearNode(refs.entries);
    for (var i = 0; i < state.dl.entries.length; i += 1) {
      refs.entries.appendChild(renderEntry(state.dl.entries[i]));
    }
    if (refs.dlStatus) {
      var statusText = '';
      if (state.dl.loading) { statusText = '加载中…'; }
      else if (!state.dl.entries.length && !state.dl.error) { statusText = '这个目录是空的'; }
      refs.dlStatus.textContent = statusText;
    }
  }

  function applySessionVisibility() {
    var hasSession = !!state.sessionId;
    for (var i = 0; i < refs.panes.length; i += 1) { refs.panes[i].hidden = true; }
    if (!hasSession) {
      if (refs.paneNoSession) { refs.paneNoSession.hidden = false; }
      return;
    }
    var tab = state.tab === 'download' ? 'download' : 'upload';
    var pane = tab === 'download' ? refs.paneDownload : refs.paneUpload;
    if (pane) { pane.hidden = false; }
    if (tab === 'download' && !state.dl.loaded && !state.dl.loading) { loadList(state.dl.path); }
  }

  function setTab(tab) {
    state.tab = tab === 'download' ? 'download' : 'upload';
    for (var i = 0; i < refs.tabButtons.length; i += 1) {
      var btn = refs.tabButtons[i];
      btn.setAttribute('aria-selected', btn.getAttribute('data-tab') === state.tab ? 'true' : 'false');
    }
    if (!state.sessionId) { applySessionVisibility(); return; }
    if (refs.paneUpload) { refs.paneUpload.hidden = state.tab !== 'upload'; }
    if (refs.paneDownload) { refs.paneDownload.hidden = state.tab !== 'download'; }
    if (state.tab === 'download') { loadList(state.dl.path); }
  }

  function setMode(mode) {
    state.mode = mode === 'workspace' ? 'workspace' : 'send';
    for (var i = 0; i < refs.modeButtons.length; i += 1) {
      var btn = refs.modeButtons[i];
      if (btn.getAttribute('data-mode') === state.mode) { btn.classList.add('is-active'); }
      else { btn.classList.remove('is-active'); }
    }
  }

  function selectSession(sessionId) {
    if (!sessionId || sessionId === state.sessionId) { return; }
    state.sessionId = sessionId;
    resetDownloadState();
    renderHeader();
    renderSessionSelect();
    applySessionVisibility();
    renderUpload();
    renderDownload();
    if (state.configLoaded) { loadConfig(); }
    if (state.tab === 'download') { loadList(''); }
  }

  function setOpen(open) {
    state.open = !!open;
    if (refs.root) {
      if (state.open) { refs.root.classList.add('is-open'); }
      else { refs.root.classList.remove('is-open'); }
    }
    if (refs.sheet) { refs.sheet.hidden = !state.open; }
    if (refs.fab) { refs.fab.setAttribute('aria-expanded', state.open ? 'true' : 'false'); }
    if (state.open) {
      renderHeader();
      renderSessionSelect();
      applySessionVisibility();
      renderUpload();
      renderDownload();
    }
  }

  async function openPanel() {
    setOpen(true);
    // 每次打开都刷新会话列表（GUI 里可能刚新建/关闭了会话）
    await refreshSessions();
    if (!state.open) { return; }
    if (state.sessionId && state.tab === 'download') { loadList(state.dl.path); }
  }

  async function onLocationChange() {
    if (!state.mounted || !state.open) { return; }
    await refreshSessions();
    if (state.sessionId && state.tab === 'download') { loadList(state.dl.path); }
  }

  // ---------------------------------------------------------------------------
  // 模板与样式（全部挂在 Shadow DOM 内，避免与官方样式互相污染）
  // ---------------------------------------------------------------------------

  var TEMPLATE = '' +
    '<style>' +
    '  [hidden] { display: none !important; }' +
    '  .rf-root {' +
    '    all: initial;' +
    '    display: block;' +
    '    position: absolute;' +
    '    inset: 0;' +
    '    pointer-events: none;' +
    '    --rf-surface: #ffffff;' +
    '    --rf-surface-2: #f4f5f7;' +
    '    --rf-fg: #1b1c1f;' +
    '    --rf-muted: #6b7280;' +
    '    --rf-border: #e2e4e9;' +
    '    --rf-primary: #2f6feb;' +
    '    --rf-primary-fg: #ffffff;' +
    '    --rf-danger: #d93025;' +
    '    --rf-ok: #15803d;' +
    '    --rf-shadow: 0 12px 32px rgba(15, 23, 42, 0.20);' +
    '    font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;' +
    '    color: var(--rf-fg);' +
    '    direction: ltr;' +
    '    text-align: left;' +
    '  }' +
    '  @media (prefers-color-scheme: dark) {' +
    '    .rf-root {' +
    '      --rf-surface: #1e2024;' +
    '      --rf-surface-2: #2a2d33;' +
    '      --rf-fg: #e9eaec;' +
    '      --rf-muted: #9aa0a6;' +
    '      --rf-border: #3a3f46;' +
    '      --rf-primary: #5b8dfa;' +
    '      --rf-primary-fg: #0b1220;' +
    '      --rf-danger: #f07369;' +
    '      --rf-ok: #56c27a;' +
    '      --rf-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);' +
    '    }' +
    '  }' +
    '  .rf-root *, .rf-root *::before, .rf-root *::after { box-sizing: border-box; }' +
    '  .rf-fab {' +
    '    position: absolute;' +
    '    right: 16px;' +
    '    bottom: calc(16px + env(safe-area-inset-bottom, 0px));' +
    '    pointer-events: auto;' +
    '    display: inline-flex;' +
    '    align-items: center;' +
    '    gap: 8px;' +
    '    min-height: 44px;' +
    '    padding: 0 16px;' +
    '    border-radius: 999px;' +
    '    border: 1px solid var(--rf-border);' +
    '    background: var(--rf-surface);' +
    '    color: var(--rf-fg);' +
    '    box-shadow: var(--rf-shadow);' +
    '    font-family: inherit;' +
    '    font-size: 14px;' +
    '    font-weight: 600;' +
    '    line-height: 1;' +
    '    cursor: pointer;' +
    '    -webkit-tap-highlight-color: transparent;' +
    '  }' +
    '  .rf-fab:active { transform: scale(0.97); }' +
    '  .rf-fab-ico { font-size: 17px; line-height: 1; }' +
    '  .rf-fab-text { font-size: 14px; line-height: 1; }' +
    '  .rf-sheet {' +
    '    position: absolute;' +
    '    pointer-events: auto;' +
    '    right: 16px;' +
    '    bottom: calc(72px + env(safe-area-inset-bottom, 0px));' +
    '    width: min(420px, calc(100vw - 32px));' +
    '    max-height: min(78vh, 760px);' +
    '    display: flex;' +
    '    flex-direction: column;' +
    '    background: var(--rf-surface);' +
    '    color: var(--rf-fg);' +
    '    border: 1px solid var(--rf-border);' +
    '    border-radius: 16px;' +
    '    box-shadow: var(--rf-shadow);' +
    '    overflow: hidden;' +
    '    -webkit-tap-highlight-color: transparent;' +
    '  }' +
    '  .rf-head {' +
    '    display: flex;' +
    '    align-items: center;' +
    '    gap: 8px;' +
    '    padding: 10px 12px;' +
    '    border-bottom: 1px solid var(--rf-border);' +
    '    flex: 0 0 auto;' +
    '  }' +
    '  .rf-head-title { flex: 0 0 auto; font-weight: 700; font-size: 16px; }' +
    '  .rf-select {' +
    '    flex: 1 1 auto;' +
    '    min-width: 0;' +
    '    max-width: 190px;' +
    '    min-height: 44px;' +
    '    padding: 0 8px;' +
    '    border-radius: 10px;' +
    '    border: 1px solid var(--rf-border);' +
    '    background: var(--rf-surface-2);' +
    '    color: var(--rf-fg);' +
    '    font-family: inherit;' +
    '    font-size: 16px;' +
    '    line-height: 1.2;' +
    '    cursor: pointer;' +
    '  }' +
    '  .rf-select:disabled { opacity: 0.6; cursor: default; }' +
    '  .rf-badge {' +
    '    flex: 0 0 auto;' +
    '    padding: 2px 7px;' +
    '    border: 1px solid var(--rf-border);' +
    '    border-radius: 999px;' +
    '    color: var(--rf-muted);' +
    '    font-size: 11px;' +
    '    line-height: 1.6;' +
    '  }' +
    '  .rf-icon-btn {' +
    '    flex: 0 0 auto;' +
    '    min-width: 44px;' +
    '    min-height: 44px;' +
    '    border: 0;' +
    '    border-radius: 10px;' +
    '    background: transparent;' +
    '    color: var(--rf-fg);' +
    '    font-size: 20px;' +
    '    line-height: 1;' +
    '    cursor: pointer;' +
    '  }' +
    '  .rf-icon-btn:active { background: var(--rf-surface-2); }' +
    '  .rf-tabs { display: flex; gap: 8px; padding: 10px 12px 0; flex: 0 0 auto; }' +
    '  .rf-tab {' +
    '    flex: 1 1 0;' +
    '    min-height: 44px;' +
    '    border-radius: 10px;' +
    '    border: 1px solid var(--rf-border);' +
    '    background: var(--rf-surface-2);' +
    '    color: var(--rf-fg);' +
    '    font-family: inherit;' +
    '    font-size: 15px;' +
    '    font-weight: 600;' +
    '    line-height: 1;' +
    '    cursor: pointer;' +
    '  }' +
    '  .rf-tab[aria-selected="true"] {' +
    '    background: var(--rf-primary);' +
    '    border-color: var(--rf-primary);' +
    '    color: var(--rf-primary-fg);' +
    '  }' +
    '  .rf-body {' +
    '    flex: 1 1 auto;' +
    '    min-height: 0;' +
    '    overflow-y: auto;' +
    '    -webkit-overflow-scrolling: touch;' +
    '    padding: 12px 12px 14px;' +
    '  }' +
    '  .rf-seg {' +
    '    display: flex;' +
    '    padding: 3px;' +
    '    margin: 2px 0 10px;' +
    '    border-radius: 12px;' +
    '    background: var(--rf-surface-2);' +
    '    border: 1px solid var(--rf-border);' +
    '  }' +
    '  .rf-seg-btn {' +
    '    flex: 1 1 0;' +
    '    min-height: 44px;' +
    '    border: 0;' +
    '    border-radius: 9px;' +
    '    background: transparent;' +
    '    color: var(--rf-muted);' +
    '    font-family: inherit;' +
    '    font-size: 14px;' +
    '    font-weight: 600;' +
    '    line-height: 1;' +
    '    cursor: pointer;' +
    '  }' +
    '  .rf-seg-btn.is-active {' +
    '    background: var(--rf-surface);' +
    '    color: var(--rf-fg);' +
    '    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);' +
    '  }' +
    '  .rf-actions { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }' +
    '  .rf-file-btn {' +
    '    position: relative;' +
    '    flex: 1 1 140px;' +
    '    display: inline-flex;' +
    '    align-items: center;' +
    '    justify-content: center;' +
    '    min-height: 44px;' +
    '    padding: 0 14px;' +
    '    border-radius: 10px;' +
    '    border: 1px dashed var(--rf-border);' +
    '    background: var(--rf-surface-2);' +
    '    color: var(--rf-fg);' +
    '    font-family: inherit;' +
    '    font-size: 15px;' +
    '    font-weight: 600;' +
    '    line-height: 1;' +
    '    text-align: center;' +
    '    cursor: pointer;' +
    '    overflow: hidden;' +
    '  }' +
    '  .rf-file-btn input {' +
    '    position: absolute;' +
    '    top: 0;' +
    '    left: 0;' +
    '    width: 100%;' +
    '    height: 100%;' +
    '    opacity: 0;' +
    '    font-size: 16px;' +
    '    cursor: pointer;' +
    '  }' +
    '  .rf-list { list-style: none; margin: 8px 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }' +
    '  .rf-item {' +
    '    display: grid;' +
    '    grid-template-columns: minmax(0, 1fr) auto;' +
    '    grid-template-rows: auto auto;' +
    '    gap: 2px 10px;' +
    '    padding: 8px 10px;' +
    '    border: 1px solid var(--rf-border);' +
    '    border-radius: 10px;' +
    '    background: var(--rf-surface-2);' +
    '  }' +
    '  .rf-item-name {' +
    '    grid-column: 1;' +
    '    grid-row: 1;' +
    '    font-size: 14px;' +
    '    font-weight: 600;' +
    '    overflow: hidden;' +
    '    text-overflow: ellipsis;' +
    '    white-space: nowrap;' +
    '  }' +
    '  .rf-item-meta {' +
    '    grid-column: 1;' +
    '    grid-row: 2;' +
    '    font-size: 12px;' +
    '    color: var(--rf-muted);' +
    '    overflow-wrap: anywhere;' +
    '  }' +
    '  .rf-item-ops {' +
    '    grid-column: 2;' +
    '    grid-row: 1 / span 2;' +
    '    display: flex;' +
    '    align-items: center;' +
    '    gap: 4px;' +
    '  }' +
    '  .rf-btn {' +
    '    min-height: 44px;' +
    '    padding: 0 14px;' +
    '    border-radius: 10px;' +
    '    border: 1px solid var(--rf-border);' +
    '    background: var(--rf-surface-2);' +
    '    color: var(--rf-fg);' +
    '    font-family: inherit;' +
    '    font-size: 15px;' +
    '    font-weight: 600;' +
    '    line-height: 1;' +
    '    text-align: center;' +
    '    text-decoration: none;' +
    '    display: inline-flex;' +
    '    align-items: center;' +
    '    justify-content: center;' +
    '    cursor: pointer;' +
    '  }' +
    '  .rf-btn:disabled { opacity: 0.55; cursor: default; }' +
    '  .rf-btn-primary { background: var(--rf-primary); border-color: var(--rf-primary); color: var(--rf-primary-fg); }' +
    '  .rf-btn-ghost { background: transparent; }' +
    '  .rf-btn-danger { color: var(--rf-danger); border-color: var(--rf-danger); background: transparent; }' +
    '  .rf-mini { min-height: 44px; min-width: 44px; padding: 0 8px; font-size: 13px; }' +
    '  .rf-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }' +
    '  .rf-progress { margin: 10px 0 2px; }' +
    '  .rf-progress-track {' +
    '    height: 8px;' +
    '    border-radius: 999px;' +
    '    background: var(--rf-surface-2);' +
    '    border: 1px solid var(--rf-border);' +
    '    overflow: hidden;' +
    '  }' +
    '  .rf-progress-bar {' +
    '    height: 100%;' +
    '    width: 0;' +
    '    background: var(--rf-primary);' +
    '    transition: width 0.15s linear;' +
    '  }' +
    '  .rf-progress-meta { margin-top: 6px; font-size: 12px; color: var(--rf-muted); }' +
    '  .rf-send-box { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }' +
    '  .rf-send-box textarea {' +
    '    width: 100%;' +
    '    min-height: 64px;' +
    '    padding: 10px;' +
    '    border-radius: 10px;' +
    '    border: 1px solid var(--rf-border);' +
    '    background: var(--rf-surface-2);' +
    '    color: var(--rf-fg);' +
    '    font-family: inherit;' +
    '    font-size: 16px;' +
    '    line-height: 1.45;' +
    '    resize: vertical;' +
    '  }' +
    '  .rf-hint { margin: 8px 0 0; font-size: 12px; line-height: 1.5; color: var(--rf-muted); }' +
    '  .rf-empty { margin: 0; padding: 18px 6px; text-align: center; font-size: 13px; color: var(--rf-muted); }' +
    '  .rf-notice {' +
    '    margin: 0 0 10px;' +
    '    padding: 8px 10px;' +
    '    border-radius: 10px;' +
    '    border: 1px solid var(--rf-border);' +
    '    background: var(--rf-surface-2);' +
    '    font-size: 13px;' +
    '    overflow-wrap: anywhere;' +
    '  }' +
    '  .rf-notice.is-error { color: var(--rf-danger); border-color: var(--rf-danger); }' +
    '  .rf-notice.is-ok { color: var(--rf-ok); border-color: var(--rf-ok); }' +
    '  .rf-toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 6px; }' +
    '  .rf-toolbar .rf-btn { flex: 1 1 130px; }' +
    '  .rf-crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; margin: 4px 0 6px; }' +
    '  .rf-crumb {' +
    '    min-height: 44px;' +
    '    padding: 0 6px;' +
    '    border: 0;' +
    '    border-radius: 8px;' +
    '    background: transparent;' +
    '    color: var(--rf-primary);' +
    '    font-family: inherit;' +
    '    font-size: 13px;' +
    '    font-weight: 600;' +
    '    line-height: 1;' +
    '    cursor: pointer;' +
    '    max-width: 40vw;' +
    '    overflow: hidden;' +
    '    text-overflow: ellipsis;' +
    '    white-space: nowrap;' +
    '  }' +
    '  .rf-crumb-sep { color: var(--rf-muted); font-size: 12px; }' +
    '  .rf-entry { display: flex; align-items: center; gap: 4px; border-bottom: 1px solid var(--rf-border); }' +
    '  .rf-entry-main {' +
    '    flex: 1 1 auto;' +
    '    min-width: 0;' +
    '    display: flex;' +
    '    align-items: center;' +
    '    gap: 8px;' +
    '    min-height: 52px;' +
    '    padding: 4px 2px;' +
    '    border: 0;' +
    '    background: transparent;' +
    '    color: var(--rf-fg);' +
    '    font-family: inherit;' +
    '    font-size: 14px;' +
    '    line-height: 1.3;' +
    '    text-align: left;' +
    '    text-decoration: none;' +
    '    cursor: pointer;' +
    '  }' +
    '  .rf-entry-ico { flex: 0 0 auto; font-size: 16px; }' +
    '  .rf-entry-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }' +
    '  .rf-entry-meta { flex: 0 0 auto; color: var(--rf-muted); font-size: 12px; }' +
    '  .rf-dl-status { padding: 10px 0; text-align: center; font-size: 12px; color: var(--rf-muted); }' +
    '  @media (max-width: 640px) {' +
    '    .rf-fab { right: 12px; bottom: calc(84px + env(safe-area-inset-bottom, 0px)); padding: 0 14px; }' +
    '    .rf-root.is-open .rf-fab { display: none; }' +
    '    .rf-select { max-width: 46vw; }' +
    '    .rf-sheet {' +
    '      left: 0;' +
    '      right: 0;' +
    '      bottom: 0;' +
    '      width: auto;' +
    '      max-height: 86vh;' +
    '      border-radius: 18px 18px 0 0;' +
    '      border-left: 0;' +
    '      border-right: 0;' +
    '      border-bottom: 0;' +
    '      padding-bottom: env(safe-area-inset-bottom, 0px);' +
    '    }' +
    '    .rf-head { padding-top: 14px; }' +
    '  }' +
    '</style>' +
    '<div class="rf-root" data-ref="root">' +
    '  <button class="rf-fab" data-ref="fab" type="button" aria-label="文件传输" aria-expanded="false">' +
    '    <span class="rf-fab-ico" aria-hidden="true">📁</span>' +
    '    <span class="rf-fab-text">文件</span>' +
    '  </button>' +
    '  <section class="rf-sheet" data-ref="sheet" role="dialog" aria-label="远程文件传输" hidden>' +
    '    <header class="rf-head">' +
    '      <span class="rf-head-title">文件</span>' +
    '      <select class="rf-select" data-ref="sessionSelect" aria-label="选择会话"></select>' +
    '      <span class="rf-badge" data-ref="remoteBadge" hidden>远程</span>' +
    '      <button class="rf-icon-btn" data-ref="close" type="button" aria-label="收起面板">×</button>' +
    '    </header>' +
    '    <nav class="rf-tabs" data-ref="tabs" role="tablist">' +
    '      <button class="rf-tab" data-tab="upload" role="tab" aria-selected="true" type="button">上传</button>' +
    '      <button class="rf-tab" data-tab="download" role="tab" aria-selected="false" type="button">下载</button>' +
    '    </nav>' +
    '    <div class="rf-body">' +
    '      <div class="rf-pane" data-ref="paneUpload">' +
    '        <div class="rf-notice" data-ref="notice" hidden></div>' +
    '        <div class="rf-seg" role="group" aria-label="上传方式">' +
    '          <button class="rf-seg-btn is-active" data-mode="send" type="button">发送给 Agent</button>' +
    '          <button class="rf-seg-btn" data-mode="workspace" type="button">只存入工作区</button>' +
    '        </div>' +
    '        <div class="rf-actions">' +
    '          <label class="rf-file-btn">选择文件<input type="file" multiple data-ref="fileInput"></label>' +
    '          <label class="rf-file-btn">拍照 / 相册<input type="file" accept="image/*" capture="environment" data-ref="cameraInput"></label>' +
    '        </div>' +
    '        <ul class="rf-list" data-ref="queue" hidden></ul>' +
    '        <p class="rf-empty" data-ref="uploadEmpty">还没有选择文件</p>' +
    '        <div class="rf-progress" data-ref="progressWrap" hidden>' +
    '          <div class="rf-progress-track"><div class="rf-progress-bar" data-ref="progressBar"></div></div>' +
    '          <div class="rf-progress-meta" data-ref="progressMeta"></div>' +
    '        </div>' +
    '        <div class="rf-row">' +
    '          <button class="rf-btn rf-btn-danger" data-ref="cancelBtn" type="button" hidden>取消上传</button>' +
    '          <button class="rf-btn rf-btn-ghost" data-ref="clearBtn" type="button" hidden>清空列表</button>' +
    '        </div>' +
    '        <div class="rf-send-box" data-ref="sendBox" hidden>' +
    '          <textarea data-ref="text" rows="2" placeholder="补充说明（可留空）" autocomplete="off"></textarea>' +
    '          <button class="rf-btn rf-btn-primary" data-ref="sendBtn" type="button">发送给 Agent</button>' +
    '          <p class="rf-hint" data-ref="sendHint"></p>' +
    '        </div>' +
    '      </div>' +
    '      <div class="rf-pane" data-ref="paneDownload" hidden>' +
    '        <div class="rf-notice" data-ref="dlNotice" hidden></div>' +
    '        <div class="rf-toolbar">' +
    '          <a class="rf-btn rf-btn-primary" data-ref="exportLink" href="#" download>下载会话日志 ZIP</a>' +
    '          <button class="rf-btn rf-btn-ghost" data-ref="exportFetch" type="button" title="通过请求保存（无 cookie 时可用）">通过请求保存</button>' +
    '          <button class="rf-btn rf-btn-ghost" data-ref="refreshBtn" type="button">刷新</button>' +
    '        </div>' +
    '        <div class="rf-crumbs" data-ref="crumbs"></div>' +
    '        <ul class="rf-list" data-ref="entries"></ul>' +
    '        <div class="rf-dl-status" data-ref="dlStatus"></div>' +
    '        <p class="rf-hint">点击文件用浏览器原生下载；若没有反应，点右侧「⤓」通过请求保存（无 cookie 设备可用）。</p>' +
    '      </div>' +
    '      <div class="rf-pane" data-ref="paneNoSession" hidden>' +
    '        <p class="rf-empty">请先在 GUI 里打开一个会话。</p>' +
    '        <p class="rf-hint">打开任意会话后回到这里，点击「刷新」或重新打开面板即可看到会话列表。</p>' +
    '        <div class="rf-row">' +
    '          <button class="rf-btn" data-ref="reloadSessions" type="button">刷新会话列表</button>' +
    '        </div>' +
    '      </div>' +
    '    </div>' +
    '  </section>' +
    '</div>';

  var REF_NAMES = [
    'root', 'fab', 'sheet', 'tabs', 'sessionSelect', 'remoteBadge', 'close',
    'paneUpload', 'paneDownload', 'paneNoSession', 'notice', 'dlNotice',
    'fileInput', 'cameraInput', 'queue', 'progressWrap', 'progressBar', 'progressMeta',
    'cancelBtn', 'clearBtn', 'sendBox', 'text', 'sendBtn', 'sendHint', 'uploadEmpty',
    'refreshBtn', 'exportLink', 'exportFetch', 'crumbs', 'entries', 'dlStatus',
    'reloadSessions'
  ];

  function bindRefs(shadow) {
    var bound = {};
    for (var i = 0; i < REF_NAMES.length; i += 1) {
      bound[REF_NAMES[i]] = shadow.querySelector('[data-ref="' + REF_NAMES[i] + '"]');
    }
    bound.tabButtons = shadow.querySelectorAll('[data-tab]');
    bound.modeButtons = shadow.querySelectorAll('[data-mode]');
    var panes = [];
    var paneNames = ['paneUpload', 'paneDownload', 'paneNoSession'];
    for (var p = 0; p < paneNames.length; p += 1) {
      if (bound[paneNames[p]]) { panes.push(bound[paneNames[p]]); }
    }
    bound.panes = panes;
    return bound;
  }

  function wireEvents() {
    refs.fab.addEventListener('click', function () {
      if (state.open) { setOpen(false); } else { openPanel(); }
    });
    refs.close.addEventListener('click', function () { setOpen(false); });

    refs.tabs.addEventListener('click', function (ev) {
      var btn = closestAttr(ev.target, refs.tabs, 'data-tab');
      if (btn) { setTab(btn.getAttribute('data-tab')); }
    });

    refs.sessionSelect.addEventListener('change', function () {
      selectSession(refs.sessionSelect.value);
    });

    var segRoot = refs.root.querySelector('.rf-seg');
    if (segRoot) {
      segRoot.addEventListener('click', function (ev) {
        var btn = closestAttr(ev.target, segRoot, 'data-mode');
        if (btn) { setMode(btn.getAttribute('data-mode')); }
      });
    }

    refs.fileInput.addEventListener('change', function () {
      var input = this;
      if (input.files && input.files.length) { addFiles(input.files); }
      try { input.value = ''; } catch (e) { /* 忽略 */ }
    });
    refs.cameraInput.addEventListener('change', function () {
      var input = this;
      if (input.files && input.files.length) { addFiles(input.files); }
      try { input.value = ''; } catch (e) { /* 忽略 */ }
    });

    refs.cancelBtn.addEventListener('click', cancelUploads);
    refs.clearBtn.addEventListener('click', clearFinished);
    refs.sendBtn.addEventListener('click', sendToAgent);
    refs.text.addEventListener('input', function () { state.text = refs.text.value; });

    refs.refreshBtn.addEventListener('click', function () { loadList(state.dl.path); });
    refs.exportFetch.addEventListener('click', function () {
      if (!state.sessionId) { showNotice('download', '请先打开一个会话。', 'error'); return; }
      saveViaFetch(apiExportPath(), 'session-log.zip', refs.exportFetch);
    });
    refs.exportLink.addEventListener('click', function () {
      if (state.sessionId) { refs.exportLink.href = navHref(apiExportPath()); }
    });
    refs.reloadSessions.addEventListener('click', function () { refreshSessions(); });

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && state.open) { setOpen(false); }
    });
    window.addEventListener('popstate', onLocationChange);
    window.addEventListener('hashchange', onLocationChange);
  }

  // ---------------------------------------------------------------------------
  // 挂载（DOM 就绪后）
  // ---------------------------------------------------------------------------

  function mount() {
    if (state.mounted) { return; }
    if (!document.body) { return; }
    if (document.getElementById(UI_HOST_ID)) { state.mounted = true; return; }

    var host = document.createElement('div');
    host.id = UI_HOST_ID;
    host.setAttribute('data-dsh-rfiles', '1');
    host.style.cssText = 'position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483000;pointer-events:none;';

    var shadow = null;
    try {
      shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : null;
    } catch (e) {
      shadow = null;
    }
    if (!shadow) {
      if (window.console && console.warn) { console.warn('[dsh-rfiles] 浏览器不支持 Shadow DOM，文件小部件未启用'); }
      return;
    }

    shadow.innerHTML = TEMPLATE;
    document.body.appendChild(host);
    refs = bindRefs(shadow);
    wireEvents();
    state.mounted = true;

    setMode(state.mode);
    setOpen(false);
    renderHeader();
    renderSessionSelect();
    renderUpload();
    renderDownload();

    // 配对通道的 boot 补丁可能在本脚本之后才就位，稍后再同步一次远程徽标
    window.setTimeout(function () {
      if (state.mounted) { renderHeader(); }
    }, 700);

    // 官方是 SPA，极端情况下 body 被整体替换时尝试重新挂载
    window.setInterval(function () {
      if (!document.getElementById(UI_HOST_ID)) {
        state.mounted = false;
        try { mount(); } catch (e) { /* 忽略 */ }
      }
    }, 3000);

    // 便于手工联调 / 自动化测试的最小公开接口
    if (!window.__DSH_RFILES_UI__) {
      window.__DSH_RFILES_UI__ = {
        version: CLIENT_VERSION,
        open: function () { return openPanel(); },
        close: function () { setOpen(false); },
        refresh: function () { return refreshSessions(); },
        state: function () {
          return {
            open: state.open,
            tab: state.tab,
            sessionId: state.sessionId,
            sessions: state.sessions.slice(),
            remote: isRemotePage(),
            items: state.items.map(function (item) {
              return { name: item.name, size: item.size, status: item.status, sent: item.sent, mode: item.mode, error: item.error };
            }),
            download: { path: state.dl.path, entries: state.dl.entries.slice(), loaded: state.dl.loaded, error: state.dl.error }
          };
        }
      };
    }
  }

  function boot() {
    try {
      mount();
    } catch (err) {
      if (window.console && console.warn) { console.warn('[dsh-rfiles] 小部件挂载失败', err); }
    }
  }

  if (document.readyState === 'loading') {
    var onReady = function () {
      document.removeEventListener('DOMContentLoaded', onReady);
      boot();
    };
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    boot();
  }
})();

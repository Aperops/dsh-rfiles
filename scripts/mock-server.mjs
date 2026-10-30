#!/usr/bin/env node
/*
 * dsh-rfiles 契约模拟服务器（内存实现，仅用于客户端 UI 联调）
 * ---------------------------------------------------------------------------
 * 目的：在没有 DSH 的环境里，按 CONTRACT.md §1 的路由语义把 lib/client.js 跑起来。
 *   node scripts/mock-server.mjs --port 4399
 *   - mock 页面：      http://127.0.0.1:4399/mock.html
 *   - 远程前缀模式：    http://127.0.0.1:4399/mock.html?remote=1
 *     （页面会发布 __DSH_REMOTE_CHANNEL_BOOT__，下载链接改用 /remote/api/...，
 *       本服务器同时把 /remote 前缀透传到同一套处理逻辑）
 *
 * 说明：
 * - 全部数据在内存里，重启即重置；下载内容是即时生成的字节。
 * - 不是生产实现：没有鉴权、没有真实工作区扫描、没有持久化。
 * - 依赖：仅 Node 内置模块（node >= 18）。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const CLIENT_JS_PATH = path.join(PKG_ROOT, 'lib', 'client.js');
const MOCK_HTML_PATH = path.join(PKG_ROOT, 'scripts', 'mock.html');

const WORKSPACE_ROOT = '/mock-workspace';
const CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_LIST_ENTRIES = 500;
const SEED_TIME = Date.now();

// 假会话列表：客户端默认取最后一个（最近创建）
const SESSIONS = [
  { id: 'mock-session-a', cwd: WORKSPACE_ROOT, title: '示例会话 A' },
  { id: 'mock-session-b', cwd: WORKSPACE_ROOT, title: '示例会话 B' }
];

// ---------------------------------------------------------------------------
// 内存工作区
// ---------------------------------------------------------------------------

/** @type {Map<string, {data: Buffer, mime: string, mtime: number}>} */
const workspaceFiles = new Map();
/** @type {Map<string, number>} 相对目录 -> mtime（'' 为根） */
const workspaceDirs = new Map([['', SEED_TIME]]);
/** @type {Map<string, {id: string, name: string, size: number, mode: string, dir: string, received: number, parts: Buffer[], mime: string, finished: boolean, createdAt: number}>} */
const uploads = new Map();
const sentMessages = [];

const MIME_BY_EXT = new Map([
  ['.txt', 'text/plain; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.jsonl', 'application/x-ndjson; charset=utf-8'],
  ['.zip', 'application/zip'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bin', 'application/octet-stream']
]);

function guessMime(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  return MIME_BY_EXT.get(ext) || 'application/octet-stream';
}

function parentOf(relPath) {
  const index = relPath.lastIndexOf('/');
  return index < 0 ? '' : relPath.slice(0, index);
}

function baseNameOf(relPath) {
  const index = relPath.lastIndexOf('/');
  return index < 0 ? relPath : relPath.slice(index + 1);
}

function pathError() {
  const err = new Error('路径不允许访问');
  err.code = 'path-escape';
  return err;
}

// 相对路径归一化：拒绝 NUL 与 ..（与宿主实现同语义）
function normalizeRel(value) {
  const raw = typeof value === 'string' ? value : '';
  if (raw.indexOf('\u0000') >= 0) { throw pathError(); }
  const segments = raw.split('/');
  const out = [];
  for (const segment of segments) {
    if (!segment || segment === '.') { continue; }
    if (segment === '..') { throw pathError(); }
    out.push(segment);
  }
  return out.join('/');
}

function ensureDir(relPath) {
  if (relPath === '') { workspaceDirs.set('', SEED_TIME); return; }
  const segments = relPath.split('/');
  let current = '';
  for (const segment of segments) {
    current = current ? current + '/' + segment : segment;
    if (!workspaceDirs.has(current)) { workspaceDirs.set(current, SEED_TIME); }
  }
}

function addFile(relPath, data, mime, mtime) {
  ensureDir(parentOf(relPath));
  workspaceFiles.set(relPath, { data, mime: mime || guessMime(relPath), mtime: mtime || Date.now() });
}

function uniqueTargetPath(dir, name) {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const prefix = dir ? dir + '/' : '';
  let candidate = prefix + name;
  let index = 1;
  while (workspaceFiles.has(candidate) || workspaceDirs.has(candidate)) {
    candidate = prefix + stem + ' (' + index + ')' + ext;
    index += 1;
    if (index > 1000) { throw new Error('重名文件过多'); }
  }
  return candidate;
}

function listEntries(relPath) {
  const entries = [];
  for (const [dirPath, mtime] of workspaceDirs) {
    if (!dirPath || parentOf(dirPath) !== relPath) { continue; }
    entries.push({ name: baseNameOf(dirPath), kind: 'dir', size: 0, mtime });
  }
  for (const [filePath, file] of workspaceFiles) {
    if (parentOf(filePath) !== relPath) { continue; }
    entries.push({ name: baseNameOf(filePath), kind: 'file', size: file.data.length, mtime: file.mtime });
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) { return a.kind === 'dir' ? -1 : 1; }
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
  return entries.slice(0, MAX_LIST_ENTRIES);
}

// ---------------------------------------------------------------------------
// 极简 ZIP 写入（store 方式，仅 mock 导出用）
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let k = 0; k < 8; k += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[n] = value;
  }
  return table;
})();

function crc32(buffer) {
  let value = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    value = CRC_TABLE[(value ^ buffer[i]) & 0xff] ^ (value >>> 8);
  }
  return (value ^ -1) >>> 0;
}

function makeZip(entries) {
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = entry.data || Buffer.alloc(0);
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(0, 8);      // store
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + data.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDir, end]);
}

// ---------------------------------------------------------------------------
// 种子数据
// ---------------------------------------------------------------------------

function makeDemoBuffer(size) {
  const buffer = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) { buffer[i] = i % 251; }
  return buffer;
}

function seedWorkspace() {
  ensureDir('.uploads');
  ensureDir('exports');
  addFile('readme.txt', Buffer.from(
    '# dsh-rfiles mock 工作区\n\n' +
    '这是 scripts/mock-server.mjs 生成的内存工作区，用于在普通浏览器里联调小部件。\n' +
    '上传「只存入工作区」的文件会出现在 .uploads/ 目录。\n',
    'utf8'
  ), 'text/plain; charset=utf-8');
  addFile('demo.bin', makeDemoBuffer(1024 * 1024), 'application/octet-stream');
  addFile('examples/notes.md', Buffer.from(
    '## 下载测试\n\n- demo.bin 有 1 MiB，适合验证 Range / 断点续传。\n- 本文件用于验证多级目录面包屑。\n',
    'utf8'
  ), 'text/markdown; charset=utf-8');
  addFile('exports/session-log.zip', makeZip([
    { name: 'session.md', data: Buffer.from('# mock session log\n\nhello from dsh-rfiles mock.\n') },
    { name: 'messages.jsonl', data: Buffer.from('{"role":"user","text":"hi"}\n{"role":"assistant","text":"hello"}\n') }
  ]), 'application/zip');
  // 1x1 透明 PNG
  addFile('示例图片.png', Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  ), 'image/png');
}

seedWorkspace();

// ---------------------------------------------------------------------------
// HTTP 辅助
// ---------------------------------------------------------------------------

function sendBuffer(req, res, status, body, headers) {
  const head = Object.assign({
    'content-length': String(body.length),
    'cache-control': 'no-store'
  }, headers || {});
  res.writeHead(status, head);
  if (req && req.method === 'HEAD') { res.end(); return; }
  res.end(body);
}

function sendJson(req, res, status, payload, headers) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  sendBuffer(req, res, status, body, Object.assign({ 'content-type': 'application/json; charset=utf-8' }, headers || {}));
}

function fail(req, res, status, code, message, extra) {
  const payload = { ok: false, error: { code, message } };
  if (extra) { Object.assign(payload, extra); }
  sendJson(req, res, status, payload);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) { return; }
      total += chunk.length;
      if (total > limit) {
        settled = true;
        const err = new Error('请求体超过上限');
        err.code = 'payload-too-large';
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) { return; }
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (settled) { return; }
      settled = true;
      reject(err);
    });
  });
}

async function readJson(req) {
  const buffer = await readBody(req, 1024 * 1024);
  if (!buffer.length) { return {}; }
  try {
    const parsed = JSON.parse(buffer.toString('utf8'));
    if (!parsed || typeof parsed !== 'object') { throw new Error('not an object'); }
    return parsed;
  } catch (err) {
    const error = new Error('请求体不是合法 JSON');
    error.code = 'invalid-json';
    throw error;
  }
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    const err = new Error('缺少字段 ' + field);
    err.code = 'bad-request';
    throw err;
  }
  return value;
}

function requireSessionId(query) {
  const sessionId = query.get('sessionId') || '';
  if (!sessionId.trim()) {
    const err = new Error('缺少 sessionId');
    err.code = 'no-session';
    throw err;
  }
  return sessionId;
}

function contentDisposition(name) {
  const fallback = String(name || 'download')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');
  return 'attachment; filename="' + fallback + '"; filename*=UTF-8\'\'' + encodeURIComponent(String(name || 'download'));
}

function parseRangeHeader(header, size) {
  if (!header) { return null; }
  const matched = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!matched) { return { invalid: true }; }
  const rawStart = matched[1];
  const rawEnd = matched[2];
  if (rawStart === '' && rawEnd === '') { return { invalid: true }; }
  let start;
  let end;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) { return { invalid: true }; }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) { return { invalid: true }; }
    if (start > end) { return { invalid: true }; }
  }
  if (size === 0 || start >= size) { return { unsatisfiable: true }; }
  if (end >= size) { end = size - 1; }
  return { start, end };
}

function serveDownload(req, res, relPath, queryName) {
  const file = workspaceFiles.get(relPath);
  if (!file) {
    if (workspaceDirs.has(relPath)) {
      fail(req, res, 400, 'is-directory', '这是文件夹，不能直接下载');
      return;
    }
    fail(req, res, 404, 'not-found', '文件不存在：' + relPath);
    return;
  }
  const data = file.data;
  const name = queryName || baseNameOf(relPath);
  const baseHeaders = {
    'content-type': file.mime,
    'content-disposition': contentDisposition(name),
    'accept-ranges': 'bytes'
  };
  const range = parseRangeHeader(req.headers.range, data.length);
  if (range && range.invalid) {
    fail(req, res, 416, 'range-not-satisfiable', 'Range 头不合法', { 'content-range': 'bytes */' + data.length });
    return;
  }
  if (range && range.unsatisfiable) {
    fail(req, res, 416, 'range-not-satisfiable', 'Range 超出文件大小', { 'content-range': 'bytes */' + data.length });
    return;
  }
  if (range) {
    const slice = data.subarray(range.start, range.end + 1);
    sendBuffer(req, res, 206, slice, Object.assign({}, baseHeaders, {
      'content-range': 'bytes ' + range.start + '-' + range.end + '/' + data.length
    }));
    return;
  }
  sendBuffer(req, res, 200, data, baseHeaders);
}

function serveStatic(req, res, filePath, contentType) {
  let content;
  try {
    content = fs.readFileSync(filePath);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('无法读取文件：' + path.basename(filePath));
    return;
  }
  sendBuffer(req, res, 200, content, { 'content-type': contentType });
}

function serveMockHtml(req, res) {
  let html;
  let client;
  try {
    html = fs.readFileSync(MOCK_HTML_PATH, 'utf8');
    client = fs.readFileSync(CLIENT_JS_PATH, 'utf8');
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('无法读取 mock.html 或 lib/client.js');
    return;
  }
  const marker = '<!-- MOCK_CLIENT_JS -->';
  const scriptTag = '<script>\n' + client + '\n</scr' + 'ipt>';
  const output = html.indexOf(marker) >= 0 ? html.replace(marker, scriptTag) : html;
  sendBuffer(req, res, 200, Buffer.from(output, 'utf8'), { 'content-type': 'text/html; charset=utf-8' });
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

async function handle(req, res) {
  const parsed = new URL(req.url || '/', 'http://mock.local');
  let pathname = parsed.pathname;
  try { pathname = decodeURIComponent(pathname); } catch (err) { /* 保留原始值 */ }

  // /remote 前缀透传：模拟第三方配对通道的对外路径
  if (pathname === '/remote' || pathname.startsWith('/remote/')) {
    pathname = pathname.slice('/remote'.length) || '/';
    res.setHeader('x-mock-remote-prefix', '1');
  }

  const method = req.method || 'GET';
  const query = parsed.searchParams;

  // 静态资源
  if ((method === 'GET' || method === 'HEAD') && (pathname === '/' || pathname === '/mock.html')) {
    serveMockHtml(req, res);
    return;
  }
  if ((method === 'GET' || method === 'HEAD') && (pathname === '/client.js' || pathname === '/lib/client.js')) {
    serveStatic(req, res, CLIENT_JS_PATH, 'text/javascript; charset=utf-8');
    return;
  }

  if (method === 'GET' && pathname === '/api/rfiles.health') {
    sendJson(req, res, 200, { ok: true, version: '1', workspaceRoot: WORKSPACE_ROOT });
    return;
  }

  if (method === 'GET' && pathname === '/api/rfiles.config') {
    sendJson(req, res, 200, {
      ok: true,
      workspaceRoot: WORKSPACE_ROOT,
      limits: { chunkBytes: CHUNK_BYTES, maxFileBytes: MAX_FILE_BYTES }
    });
    return;
  }

  if (method === 'GET' && pathname === '/api/rfiles.sessions') {
    sendJson(req, res, 200, { ok: true, sessions: SESSIONS });
    return;
  }

  if (method === 'GET' && pathname === '/api/rfiles.list') {
    requireSessionId(query);
    const relPath = normalizeRel(query.get('path') || '');
    if (!workspaceDirs.has(relPath)) { throw Object.assign(new Error('目录不存在：' + relPath), { code: 'not-found' }); }
    sendJson(req, res, 200, { ok: true, path: relPath, entries: listEntries(relPath) });
    return;
  }

  if (method === 'POST' && pathname === '/api/rfiles.upload.init') {
    const body = await readJson(req);
    const sessionId = requireString(body.sessionId, 'sessionId');
    const mode = body.mode === 'workspace' ? 'workspace' : (body.mode === 'send' ? 'send' : '');
    if (!mode) { throw Object.assign(new Error('mode 必须是 workspace 或 send'), { code: 'bad-request' }); }
    const name = requireString(body.name, 'name');
    if (/[\/\\\u0000]/.test(name) || name === '.' || name === '..') {
      throw Object.assign(new Error('文件名不合法'), { code: 'invalid-path' });
    }
    const size = Number(body.size);
    if (!Number.isInteger(size) || size < 0) {
      throw Object.assign(new Error('size 必须是非负整数'), { code: 'bad-request' });
    }
    if (size > MAX_FILE_BYTES) {
      throw Object.assign(new Error('文件超过单文件上限'), { code: 'too-large' });
    }
    const dir = mode === 'workspace' ? normalizeRel(body.dir || '.uploads') : '';
    const uploadId = randomUUID(); // 与宿主一致：随机 UUID
    uploads.set(uploadId, {
      id: uploadId,
      name,
      size,
      mode,
      dir,
      received: 0,
      parts: [],
      mime: guessMime(name),
      finished: false,
      createdAt: Date.now()
    });
    sendJson(req, res, 200, { ok: true, uploadId, offset: 0 });
    return;
  }

  if (method === 'PUT' && pathname === '/api/rfiles.upload.chunk') {
    const uploadId = query.get('uploadId') || '';
    const upload = uploads.get(uploadId);
    if (!upload) {
      fail(req, res, 404, 'unknown-upload', '上传会话不存在或已过期');
      return;
    }
    const offset = Number(query.get('offset'));
    if (!Number.isInteger(offset) || offset < 0) {
      throw Object.assign(new Error('offset 必须是非负整数'), { code: 'bad-request' });
    }
    const buffer = await readBody(req, CHUNK_BYTES * 2);
    if (offset !== upload.received) {
      fail(req, res, 409, 'offset-mismatch', '偏移不匹配，请从 received 继续', { received: upload.received });
      return;
    }
    if (upload.received + buffer.length > upload.size) {
      fail(req, res, 413, 'payload-too-large', '写入字节超过声明大小');
      return;
    }
    upload.parts.push(buffer);
    upload.received += buffer.length;
    sendJson(req, res, 200, { ok: true, offset: upload.received, received: upload.received });
    return;
  }

  if (method === 'POST' && pathname === '/api/rfiles.upload.finish') {
    const body = await readJson(req);
    const uploadId = requireString(body.uploadId, 'uploadId');
    const upload = uploads.get(uploadId);
    if (!upload) {
      fail(req, res, 404, 'unknown-upload', '上传会话不存在或已过期');
      return;
    }
    if (upload.received !== upload.size) {
      fail(req, res, 400, 'incomplete', '文件尚未接收完整', { received: upload.received });
      return;
    }
    const data = Buffer.concat(upload.parts);
    if (upload.mode === 'workspace') {
      ensureDir(upload.dir);
      const target = uniqueTargetPath(upload.dir, upload.name);
      addFile(target, data, upload.mime);
      uploads.delete(uploadId);
      console.log('[mock] 已存入工作区：' + target + '（' + data.length + ' 字节）');
      sendJson(req, res, 200, {
        ok: true,
        mode: 'workspace',
        path: target,
        uploadId,
        name: upload.name,
        size: upload.size,
        mime: upload.mime
      });
      return;
    }
    upload.finished = true;
    sendJson(req, res, 200, {
      ok: true,
      mode: 'send',
      uploadId,
      name: upload.name,
      size: upload.size,
      mime: upload.mime
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/rfiles.upload.cancel') {
    const body = await readJson(req);
    const uploadId = typeof body.uploadId === 'string' ? body.uploadId : '';
    uploads.delete(uploadId);
    sendJson(req, res, 200, { ok: true });
    return;
  }

  if (method === 'POST' && pathname === '/api/rfiles.send') {
    const body = await readJson(req);
    const sessionId = requireString(body.sessionId, 'sessionId');
    if (!Array.isArray(body.uploadIds) || !body.uploadIds.length) {
      throw Object.assign(new Error('uploadIds 不能为空'), { code: 'bad-request' });
    }
    const names = [];
    for (const rawId of body.uploadIds) {
      const upload = uploads.get(String(rawId));
      if (!upload) { throw Object.assign(new Error('上传会话不存在：' + rawId), { code: 'unknown-upload' }); }
      if (!upload.finished) { throw Object.assign(new Error('文件尚未上传完成：' + upload.name), { code: 'incomplete' }); }
      names.push(upload.name);
    }
    for (const rawId of body.uploadIds) { uploads.delete(String(rawId)); }
    sentMessages.push({ sessionId, text: String(body.text || ''), names, at: Date.now() });
    console.log('[mock] 发送给 Agent：' + names.join('、') + (body.text ? '（' + body.text + '）' : ''));
    sendJson(req, res, 200, { ok: true, sent: names });
    return;
  }

  if ((method === 'GET' || method === 'HEAD') && pathname === '/api/rfiles.download') {
    requireSessionId(query);
    const relPath = normalizeRel(query.get('path') || '');
    if (!relPath) { throw Object.assign(new Error('path 不能为空'), { code: 'bad-request' }); }
    serveDownload(req, res, relPath);
    return;
  }

  if ((method === 'GET' || method === 'HEAD') && (pathname === '/api/rfiles.export' || pathname === '/api/session.export')) {
    requireSessionId(query);
    const zip = makeZip([
      { name: 'session.md', data: Buffer.from('# mock session log\n\n- 会话：' + (query.get('sessionId') || '') + '\n- 导出时间：' + new Date().toISOString() + '\n') },
      { name: 'messages.jsonl', data: Buffer.from('{"role":"user","text":"hi"}\n{"role":"assistant","text":"hello"}\n') },
      { name: 'files.json', data: Buffer.from(JSON.stringify([...workspaceFiles.keys()], null, 2) + '\n') }
    ]);
    sendBuffer(req, res, 200, zip, {
      'content-type': 'application/zip',
      'content-disposition': contentDisposition('session-log.zip')
    });
    return;
  }

  if (pathname.startsWith('/api/')) {
    fail(req, res, 404, 'not-found', '未实现的 mock 路由：' + method + ' ' + pathname);
    return;
  }

  fail(req, res, 404, 'not-found', '未知路径：' + method + ' ' + pathname);
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { port: 4399, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') {
      options.port = Number(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--port=')) {
      options.port = Number(arg.slice('--port='.length));
    } else if (arg === '--host') {
      options.host = String(argv[i + 1] || options.host);
      i += 1;
    } else if (arg.startsWith('--host=')) {
      options.host = arg.slice('--host='.length);
    } else if (arg === '--help' || arg === '-h') {
      console.log('用法：node scripts/mock-server.mjs [--port 4399] [--host 127.0.0.1]');
      process.exit(0);
    } else {
      console.error('未知参数：' + arg);
      process.exit(2);
    }
  }
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
    console.error('端口不合法：' + options.port);
    process.exit(2);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

const server = http.createServer((req, res) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    console.log(req.method + ' ' + req.url + ' -> ' + res.statusCode + ' (' + (Date.now() - startedAt) + 'ms)');
  });
  handle(req, res).catch((err) => {
    const code = (err && err.code) || 'internal-error';
    const status = code === 'payload-too-large' ? 413
      : (code === 'bad-request' || code === 'invalid-json' || code === 'path-escape' || code === 'no-session' || code === 'invalid-path') ? 400
        : (code === 'not-found') ? 404
          : 500;
    if (!res.headersSent) {
      fail(req, res, status, code, (err && err.message) || '请求处理失败');
    } else {
      res.end();
    }
  });
});

server.on('error', (err) => {
  console.error('启动失败：' + err.message);
  process.exit(1);
});

server.listen(options.port, options.host, () => {
  const shownHost = options.host === '0.0.0.0' ? '127.0.0.1' : options.host;
  const base = 'http://' + shownHost + ':' + options.port;
  console.log('dsh-rfiles mock server 已启动');
  console.log('  mock 页面（本机）: ' + base + '/mock.html');
  console.log('  mock 页面（远程）: ' + base + '/mock.html?remote=1');
  console.log('  工作区根（虚拟）: ' + WORKSPACE_ROOT);
  console.log('  会话列表: ' + SESSIONS.map((item) => item.id).join('、'));
  console.log('  按 Ctrl+C 退出');
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});

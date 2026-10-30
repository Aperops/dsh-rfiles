/**
 * dsh-rfiles —— profile-local 伴生插件（Host 半区）。
 *
 * 目的：让远程（手机 / 别的电脑）配对页面既能【发文件给 Agent】，也能
 * 【把工作区/产出文件下载到本机】，且完全不改 @linxin666/dsh-remote-web-ui
 * 与 DSH 核心。
 *
 * 原理：
 * - 远程通道只改写 `fetch`（/api/* → /remote/api/*），锚点导航不改写。
 *   因此所有交互都走 fetch；下载用原生 `<a download>` 并显式加 /remote 前缀。
 * - 上传走自建“分块 + 偏移幂等”通道，绕开官方单次流式上传在手机上的问题；
 *   发送给 Agent 时复用官方 `ctx.fileUploads` 收据机制，等价于官方 composer。
 * - 下载走自建 Route，支持单段 Range（桌面直连可用；远程代理会丢弃 Range 头，
 *   但 Content-Disposition 会被透传，原生下载仍然可用）。
 *
 * 契约：见同目录 CONTRACT.md（不得擅改）。
 *
 * @module dsh-rfiles
 */

import { randomUUID } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import {
  CoreError,
  DEFAULT_CHUNK_BYTES,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_STAGING_BYTES,
  DEFAULT_UPLOAD_DIR,
  PROTOCOL_VERSION,
  RANGE_UNSATISFIABLE,
  TransferStore,
  bodyChunks,
  contentDisposition,
  contentTypeFor,
  escapeInlineScript,
  parseSingleRange,
  relativeDisplayPath,
  resolveInside,
  sanitizeFileName,
  toCoreError,
} from './core.js'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'rfiles'

/** 依赖的宿主服务：路由注册、会话定位、附件收据与 prompt 提交。 */
export const inject = [
  'webServer',
  'connection',
  'sessions',
  'sessionPersistence',
  'sandboxPolicy',
  'fileUploads',
  'sessionController',
]

/** 所有路由共用的 JSON 响应头。 */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

/** 图片附件的扩展名 → mediaType（仅契约允许的四种）。 */
const IMAGE_MEDIA_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
])

/** 图片走官方图片准入的体积上限：20 MiB。 */
const IMAGE_MAX_BYTES = 20 * 1024 * 1024

/** workspace 列目录一次最多返回的条目数。 */
const LIST_LIMIT = 500

/** client.js 缺失时的告警只打一次，避免每次 index 渲染刷屏。 */
let warnedMissingClient = false

/**
 * 解析插件配置，给所有配额与路径选项补默认值。
 * @param {Record<string, unknown>} [config] - cordis.patch.yml 里的 config。
 * @returns {{chunkBytes:number,maxFileBytes:number,stagingBytes:number,uploadDir:string,transferRoot:string}}
 */
function normalizeConfig(config = {}) {
  const positiveInt = (value, fallback) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
  const dshHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
  return {
    chunkBytes: positiveInt(config.chunkBytes, DEFAULT_CHUNK_BYTES),
    maxFileBytes: positiveInt(config.maxFileBytes, DEFAULT_MAX_FILE_BYTES),
    stagingBytes: positiveInt(config.stagingBytes, DEFAULT_STAGING_BYTES),
    uploadDir: typeof config.uploadDir === 'string' && config.uploadDir !== '' ? config.uploadDir : DEFAULT_UPLOAD_DIR,
    transferRoot: typeof config.transferRoot === 'string' && config.transferRoot !== ''
      ? path.resolve(config.transferRoot)
      : path.join(dshHome, 'rfile-transfers'),
  }
}

/** 构造成功 JSON 响应。 */
function okJson(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS })
}

/** 构造契约里的失败信封：`{ ok:false, error:{ code, message, ...extra } }`。 */
function failJson(status, code, message, extra = {}) {
  return okJson({ ok: false, error: { code, message, ...extra } }, status)
}

/** 把任意异常转成契约失败响应。 */
function errorResponse(error) {
  const mapped = toCoreError(error)
  if (mapped.status >= 500) console.error('[dsh-rfiles]', mapped.code, mapped.message)
  return failJson(mapped.status, mapped.code, mapped.message, mapped.extra)
}

/** 统一包一层：handler 内抛错也能返回标准信封，而不是 500 空响应。 */
function guarded(handler) {
  return async (request) => {
    try {
      return await handler(request)
    } catch (error) {
      return errorResponse(error)
    }
  }
}

/** 读取 JSON 请求体并校验必须是对象。 */
async function readJsonBody(request) {
  let text
  try {
    text = await request.text()
  } catch {
    throw new CoreError('invalid-request', '无法读取请求体', 400)
  }
  if (typeof text !== 'string' || text.trim() === '') {
    throw new CoreError('invalid-request', '请求体必须是 JSON 对象', 400)
  }
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new CoreError('invalid-request', '请求体不是合法 JSON', 400)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CoreError('invalid-request', '请求体必须是 JSON 对象', 400)
  }
  return value
}

/** 必填非空字符串字段。 */
function requireString(value, field) {
  if (typeof value !== 'string' || value === '') {
    throw new CoreError('invalid-request', `${field} 必须是非空字符串`, 400)
  }
  return value
}

/**
 * 把官方服务抛出的 RemoteError（带稳定 code 的 { code, message }）收敛成契约信封，
 * 保留官方文案，便于客户端直接展示“模型不支持图片”等提示。
 * @param {unknown} error
 * @returns {CoreError}
 */
function mapRemoteFailure(error) {
  if (error instanceof CoreError) return error
  const remoteCode = typeof error === 'object' && error !== null && typeof error.code === 'string'
    ? error.code
    : undefined
  const message = error instanceof Error && error.message !== '' ? error.message : '发送给 Agent 失败'
  if (remoteCode !== undefined && remoteCode !== 'ENOENT') {
    const status = remoteCode.endsWith('not-found') ? 404 : 400
    return new CoreError(remoteCode, message, status)
  }
  return new CoreError('send-failed', message, 500)
}

/** 清理暂存区但忽略清理失败（send 成功后尽力而为）。 */
async function cancelQuietly(store, uploadId) {
  await store.cancel(uploadId).catch(() => undefined)
}

/** 尽量读完并丢弃请求体（保持 HTTP keep-alive 干净；失败也不抛）。 */
async function drainBody(request) {
  const body = request.body
  if (body === null || body === undefined) return
  try {
    const reader = body.getReader()
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done === true) return
      }
    } finally {
      reader.releaseLock()
    }
  } catch {
    // 客户端已断开或流已被取消：忽略。
  }
}

/**
 * 找到会话的创建元数据（header）：先查活会话，再回落到持久化存储（冷会话）。
 * @param {any} ctx - 宿主上下文。
 * @param {string} sessionId
 * @returns {Promise<Record<string, any>>}
 */
async function sessionHeaderFor(ctx, sessionId) {
  const live = typeof ctx.sessions?.get === 'function' ? ctx.sessions.get(sessionId) : undefined
  let header = live?.header
  if (header === undefined) {
    const persistence = typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : undefined
    if (persistence !== undefined && typeof persistence.stat === 'function') {
      const stored = await persistence.stat(sessionId).catch(() => undefined)
      header = stored?.header
    }
  }
  if (header === undefined) {
    throw new CoreError('session-not-found', '会话不存在或尚未加载', 404, { sessionId })
  }
  return header
}

/**
 * 解析某个会话对应的工作区根目录。
 * sessionId 缺省时退回 `ctx.sandboxPolicy.workspaceRoot`（单工作区部署）。
 * @param {any} ctx
 * @param {string | null | undefined} sessionId
 * @returns {Promise<string>}
 */
async function workspaceRootFor(ctx, sessionId) {
  let fallback
  if (typeof sessionId === 'string' && sessionId !== '') {
    const header = await sessionHeaderFor(ctx, sessionId)
    fallback = typeof header.cwd === 'string' && header.cwd !== '' ? header.cwd : undefined
  }
  if (fallback === undefined) {
    const configured = ctx.sandboxPolicy?.workspaceRoot
    if (typeof configured === 'string' && configured !== '') fallback = configured
  }
  if (fallback === undefined) {
    throw new CoreError('workspace-unavailable', '无法确定会话的工作区目录', 400)
  }
  return path.resolve(fallback)
}

/** 判断一个暂存文件是否应作为图片附件发送；是则返回 mediaType。 */
function imageMediaTypeFor(name, size) {
  if (typeof name !== 'string') return null
  const mediaType = IMAGE_MEDIA_TYPES.get(path.extname(name).toLowerCase())
  if (mediaType === undefined) return null
  if (!Number.isSafeInteger(size) || size > IMAGE_MAX_BYTES) return null
  return mediaType
}

/**
 * 把客户端脚本注入官方 index 页面。
 * 只烘入 `{ version }`：是否远程由客户端运行时判断，sessionId 由客户端选会话后传。
 * @param {any} ctx
 */
function installWidget(ctx) {
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: '__DSH_RFILES__', value: { version: PROTOCOL_VERSION } })
    let source = ''
    try {
      source = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
    } catch (error) {
      if (!warnedMissingClient) {
        warnedMissingClient = true
        console.warn('[dsh-rfiles] lib/client.js 缺失，暂不注入浏览器小部件：', error instanceof Error ? error.message : String(error))
      }
    }
    // 空脚本也是合法注入：等 client.js 就绪后下次 index 渲染即可生效。
    table.push({ kind: 'script', placement: 'head', text: escapeInlineScript(source) })
  })
}

/**
 * Cordis 插件入口：注册全部 /api/rfiles.* exact Fetch 路由，并注入客户端脚本。
 * @param {any} ctx - 宿主上下文（webServer / connection / sessions / fileUploads / sessionController …）。
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  const settings = normalizeConfig(config ?? {})
  const store = new TransferStore({
    root: settings.transferRoot,
    maxFileBytes: settings.maxFileBytes,
    stagingBytes: settings.stagingBytes,
  })

  /** 注册一条 exact Fetch 路由（由 Connection 提供鉴权与远程 /remote 改写）。 */
  const registerRoute = (routePath, methods, requestBody, handler) => {
    ctx.effect(() => ctx.connection.fetch.register({
      path: routePath,
      methods,
      requestBody,
      fetch: guarded(handler),
    }), `rfiles: ${routePath}`)
  }

  // ── 诊断与配置 ──────────────────────────────────────────────

  registerRoute('/api/rfiles.health', ['GET'], 'buffered', async () => {
    const root = ctx.sandboxPolicy?.workspaceRoot
    return okJson({
      ok: true,
      version: PROTOCOL_VERSION,
      workspaceRoot: typeof root === 'string' ? root : null,
    })
  })

  registerRoute('/api/rfiles.config', ['GET'], 'buffered', async (request) => {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('sessionId')
    const limits = { chunkBytes: settings.chunkBytes, maxFileBytes: settings.maxFileBytes }
    if (sessionId === null || sessionId === '') return okJson({ ok: true, limits })
    const workspaceRoot = await workspaceRootFor(ctx, sessionId)
    return okJson({ ok: true, workspaceRoot, limits })
  })

  // ── 会话列表（客户端据此选择 sessionId） ────────────────────

  registerRoute('/api/rfiles.sessions', ['GET'], 'buffered', async () => {
    const sessions = typeof ctx.sessions?.list === 'function' ? ctx.sessions.list() : []
    const rows = []
    for (const session of sessions) {
      const header = session?.header ?? session
      if (header === null || typeof header !== 'object') continue
      if (typeof header.cwd !== 'string' || header.cwd === '') continue
      rows.push({
        id: String(header.id ?? ''),
        cwd: header.cwd,
        createdAt: typeof header.createdAt === 'number' ? header.createdAt : 0,
        title: typeof header.title === 'string' && header.title !== '' ? header.title : undefined,
      })
    }
    rows.sort((left, right) => left.createdAt - right.createdAt)
    return okJson({
      ok: true,
      sessions: rows.map((row) => {
        const item = { id: row.id, cwd: row.cwd }
        if (row.title !== undefined) item.title = row.title
        return item
      }),
    })
  })

  // ── 列目录 ──────────────────────────────────────────────────

  registerRoute('/api/rfiles.list', ['GET'], 'buffered', async (request) => {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('sessionId')
    const relative = url.searchParams.get('path') ?? ''
    const root = await workspaceRootFor(ctx, sessionId)
    const absolute = await resolveInside(root, relative)
    const info = await stat(absolute)
    if (!info.isDirectory()) throw new CoreError('not-a-directory', '该路径不是目录', 400)

    const dirents = await readdir(absolute, { withFileTypes: true })
    const classified = []
    for (const dirent of dirents) {
      if (dirent.isDirectory()) {
        classified.push({ name: dirent.name, kind: 'dir' })
        continue
      }
      if (dirent.isFile()) {
        classified.push({ name: dirent.name, kind: 'file' })
        continue
      }
      if (dirent.isSymbolicLink()) {
        // 软链接：只有仍指向工作区内时才展示（否则隐藏，避免越权预览）。
        const childRelative = relative === '' ? dirent.name : `${relative}/${dirent.name}`
        let childAbsolute
        try {
          childAbsolute = await resolveInside(root, childRelative)
          const childInfo = await stat(childAbsolute)
          classified.push({ name: dirent.name, kind: childInfo.isDirectory() ? 'dir' : 'file' })
        } catch {
          // 逃逸或无权限：直接跳过。
        }
        continue
      }
      // socket / fifo / device 等特殊文件不展示。
    }
    classified.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'dir' ? -1 : 1
      return left.name.localeCompare(right.name)
    })

    const entries = []
    for (const item of classified.slice(0, LIST_LIMIT)) {
      const childRelative = relative === '' ? item.name : `${relative}/${item.name}`
      let childInfo
      try {
        childInfo = await stat(await resolveInside(root, childRelative))
      } catch {
        continue
      }
      entries.push({
        name: item.name,
        kind: item.kind,
        size: item.kind === 'file' ? childInfo.size : 0,
        mtime: Math.floor(childInfo.mtimeMs),
      })
    }
    return okJson({ ok: true, path: relative.split(path.sep).join('/'), entries })
  })

  // ── 分块上传 ────────────────────────────────────────────────

  registerRoute('/api/rfiles.upload.init', ['POST'], 'buffered', async (request) => {
    const body = await readJsonBody(request)
    const sessionId = requireString(body.sessionId, 'sessionId')
    const mode = body.mode
    if (mode !== 'workspace' && mode !== 'send') {
      throw new CoreError('invalid-mode', 'mode 必须是 "workspace" 或 "send"', 400)
    }
    const fileName = sanitizeFileName(body.name)
    if (!Number.isSafeInteger(body.size) || body.size < 0) {
      throw new CoreError('invalid-size', 'size 必须是非负整数', 400)
    }
    // 提前校验会话存在（send 模式不必等到发送时才发现会话已失效）。
    const header = await sessionHeaderFor(ctx, sessionId)
    let dir = null
    if (mode === 'workspace') {
      const workspaceRoot = typeof header.cwd === 'string' && header.cwd !== ''
        ? path.resolve(header.cwd)
        : await workspaceRootFor(ctx, sessionId)
      dir = typeof body.dir === 'string' && body.dir !== '' ? body.dir : settings.uploadDir
      await resolveInside(workspaceRoot, dir)
    }
    const result = await store.init({ sessionId, mode, name: fileName, size: body.size, dir })
    return okJson({ ok: true, uploadId: result.uploadId, offset: 0 })
  })

  registerRoute('/api/rfiles.upload.chunk', ['PUT'], 'streaming', async (request) => {
    const url = new URL(request.url)
    const uploadId = url.searchParams.get('uploadId') ?? ''
    const offsetRaw = url.searchParams.get('offset')
    if (offsetRaw === null || !/^\d+$/.test(offsetRaw)) {
      await drainBody(request)
      throw new CoreError('invalid-offset', 'offset 必须是非负整数字符串', 400)
    }
    const offset = Number(offsetRaw)
    try {
      const result = await store.chunk(uploadId, offset, bodyChunks(request.body), {
        maxChunkBytes: settings.chunkBytes,
      })
      return okJson({ ok: true, offset: result.offset, received: result.received })
    } catch (error) {
      // 偏移不匹配 / 超限等错误也要把剩余请求体读掉，避免代理层看到半截连接。
      await drainBody(request)
      throw error
    }
  })

  registerRoute('/api/rfiles.upload.finish', ['POST'], 'buffered', async (request) => {
    const body = await readJsonBody(request)
    const uploadId = requireString(body.uploadId, 'uploadId')
    const meta = await store.meta(uploadId)
    const declaredSha256 = typeof body.sha256 === 'string' && body.sha256 !== '' ? body.sha256.toLowerCase() : undefined
    if (meta.mode === 'workspace') {
      const sessionId = typeof meta.sessionId === 'string' && meta.sessionId !== '' ? meta.sessionId : undefined
      const root = await workspaceRootFor(ctx, sessionId)
      const dir = typeof meta.dir === 'string' && meta.dir !== '' ? meta.dir : settings.uploadDir
      const dirAbs = await resolveInside(root, dir)
      const finished = await store.finish(uploadId, { sha256: declaredSha256, dirAbs })
      return okJson({
        ok: true,
        mode: 'workspace',
        path: relativeDisplayPath(root, finished.path),
        uploadId,
        name: finished.name,
        size: finished.size,
        mime: contentTypeFor(finished.name),
      })
    }
    const finished = await store.finish(uploadId, { sha256: declaredSha256 })
    return okJson({
      ok: true,
      mode: 'send',
      uploadId,
      name: meta.name,
      size: finished.size,
      mime: contentTypeFor(meta.name),
    })
  })

  registerRoute('/api/rfiles.upload.cancel', ['POST'], 'buffered', async (request) => {
    const body = await readJsonBody(request)
    const uploadId = requireString(body.uploadId, 'uploadId')
    await store.cancel(uploadId)
    return okJson({ ok: true })
  })

  // ── 发送给 Agent（复用官方 receipt + prompt 路径） ──────────

  registerRoute('/api/rfiles.send', ['POST'], 'buffered', async (request) => {
    const body = await readJsonBody(request)
    const sessionId = requireString(body.sessionId, 'sessionId')
    const uploadIds = Array.isArray(body.uploadIds) ? body.uploadIds : []
    if (uploadIds.length === 0) throw new CoreError('invalid-request', 'uploadIds 不能为空', 400)
    const text = typeof body.text === 'string' ? body.text.trim() : ''

    const staged = []
    for (const rawUploadId of uploadIds) {
      if (typeof rawUploadId !== 'string' || rawUploadId === '') {
        throw new CoreError('invalid-request', 'uploadIds 只能包含字符串', 400)
      }
      const meta = await store.meta(rawUploadId)
      if (meta.mode !== 'send') {
        throw new CoreError('invalid-mode', '该文件已存入工作区，不能作为附件发送', 400, { uploadId: rawUploadId })
      }
      if (meta.finished !== true) {
        throw new CoreError('incomplete', '文件尚未上传完成', 409, { uploadId: rawUploadId })
      }
      if (typeof meta.sessionId === 'string' && meta.sessionId !== sessionId) {
        throw new CoreError('session-mismatch', '该文件属于其它会话', 400, { uploadId: rawUploadId })
      }
      staged.push({ uploadId: rawUploadId, meta, dataPath: store.dataPath(rawUploadId) })
    }

    /** @type {Array<Record<string, unknown>>} */
    const content = []
    if (text !== '') content.push({ type: 'text', text })
    const sent = []
    try {
      for (const item of staged) {
        const mediaType = imageMediaTypeFor(item.meta.name, item.meta.size)
        if (mediaType !== null) {
          // 图片走官方图片准入：base64 + mediaType。
          const bytes = await readFile(item.dataPath)
          content.push({ type: 'image', data: bytes.toString('base64'), mediaType })
        } else {
          // 普通文件走官方 staged receipt。
          const uploaded = await ctx.fileUploads.uploadStream({
            sessionId,
            data: createReadStream(item.dataPath),
            name: item.meta.name,
          })
          content.push({ type: 'file', receiptId: uploaded.receiptId })
        }
        sent.push(item.meta.name)
      }

      const controller = new AbortController()
      // mode: 'queue' 与官方 composer 的默认 followup 等价（控制器只对 'steer' 分支）。
      await ctx.sessionController.prompt({
        sessionId,
        requestId: randomUUID(),
        content,
        mode: 'queue',
      }, controller.signal)
    } catch (error) {
      // 官方 RemoteError（session/attachment-invalid、MODEL_DOES_NOT_SUPPORT_IMAGES 等）
      // 的文案原样透传给客户端，只把 code/status 收敛成契约信封；CoreError 原样抛出。
      throw mapRemoteFailure(error)
    }

    // 发送成功后清理暂存区；清理失败不影响“已发送”的结论。
    for (const item of staged) {
      await cancelQuietly(store, item.uploadId)
    }
    return okJson({ ok: true, sent })
  })

  // ── 下载（单段 Range + 原生下载头） ─────────────────────────

  registerRoute('/api/rfiles.download', ['GET'], 'buffered', async (request) => {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('sessionId')
    const relative = url.searchParams.get('path')
    if (relative === null || relative === '') {
      throw new CoreError('invalid-request', 'path 不能为空', 400)
    }
    const root = await workspaceRootFor(ctx, sessionId)
    const absolute = await resolveInside(root, relative)
    const info = await stat(absolute)
    if (!info.isFile()) throw new CoreError('is-directory', '这是文件夹，不能直接下载', 400)

    const fileName = path.basename(absolute)
    const baseHeaders = {
      'content-type': contentTypeFor(fileName),
      'content-disposition': contentDisposition(fileName),
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'last-modified': new Date(info.mtimeMs).toUTCString(),
    }
    const range = parseSingleRange(request.headers.get('range'), info.size)
    if (range === RANGE_UNSATISFIABLE) {
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, 'content-range': `bytes */${info.size}` },
      })
    }
    if (range === null) {
      return new Response(Readable.toWeb(createReadStream(absolute)), {
        status: 200,
        headers: { ...baseHeaders, 'content-length': String(info.size) },
      })
    }
    const length = range.end - range.start + 1
    return new Response(Readable.toWeb(createReadStream(absolute, { start: range.start, end: range.end })), {
      status: 206,
      headers: {
        ...baseHeaders,
        'content-length': String(length),
        'content-range': `bytes ${range.start}-${range.end}/${info.size}`,
      },
    })
  })

  // ── 会话日志 ZIP（转发官方 /api/session.export，确保下载头） ──

  registerRoute('/api/rfiles.export', ['GET'], 'buffered', async (request) => {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('sessionId')
    if (sessionId === null || sessionId === '') {
      throw new CoreError('invalid-request', 'sessionId 不能为空', 400)
    }
    const port = ctx.webServer?.port
    if (typeof port !== 'number' || port <= 0) {
      throw new CoreError('web-server-unavailable', 'Web 服务器尚未就绪，请稍后重试', 503)
    }
    // 转发到本机 loopback 的官方 exact 路由，复用调用方已通过鉴权的凭据。
    const target = `http://127.0.0.1:${port}/api/session.export?sessionId=${encodeURIComponent(sessionId)}&includeDescendants=true`
    const headers = {
      'sec-fetch-site': 'same-origin',
      // 让上游不要压缩：Node fetch 会自动解压 gzip 响应，若同时透传上游
      // content-length 就会与实际字节数不一致，导致下载被截断。
      'accept-encoding': 'identity',
      accept: request.headers.get('accept') ?? 'application/zip',
    }
    const cookie = request.headers.get('cookie')
    if (typeof cookie === 'string' && cookie !== '') headers.cookie = cookie

    let upstream
    try {
      upstream = await fetch(target, { headers, redirect: 'manual', signal: request.signal })
    } catch (error) {
      throw new CoreError('export-failed', `会话日志导出失败：${error instanceof Error ? error.message : String(error)}`, 502)
    }
    const responseHeaders = new Headers()
    for (const headerName of ['content-type', 'content-length', 'etag', 'last-modified']) {
      const value = upstream.headers.get(headerName)
      if (value !== null) responseHeaders.set(headerName, value)
    }
    responseHeaders.set('cache-control', 'no-store')
    const disposition = upstream.headers.get('content-disposition')
    responseHeaders.set(
      'content-disposition',
      disposition ?? contentDisposition(`session-${sessionId.slice(0, 8)}.zip`),
    )
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
  })

  installWidget(ctx)
}

export default { name, inject, apply }

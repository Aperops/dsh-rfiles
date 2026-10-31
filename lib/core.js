/*
 * Copyright (c) 2026 dsh-rfiles contributors
 * SPDX-License-Identifier: GPL-3.0-only
 * See LICENSE for current terms and NOTICE for historical MIT permissions.
 */

/**
 * dsh-rfiles 纯逻辑核心。
 *
 * 这里只放不依赖 Cordis / ctx 的能力：工作区路径约束、HTTP Range 解析、
 * 下载响应头、文件名处理、内联脚本转义，以及分块上传暂存区（TransferStore）。
 * 全部可在 `node --test` 下直接单测，不需要启动 DSH。
 *
 * 暂存区结构：`<root>/<uploadId>/{meta.json,data.bin}`。
 * `data.bin` 的当前长度就是“已接收字节数”，因此进程崩溃/请求中断后，
 * 下一次 chunk 请求可以用 409 返回的 received 继续续传（不会重复写字节）。
 *
 * 所有对外失败统一抛 CoreError：携带稳定 code、建议的 HTTP status 与附加字段。
 */

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

/** 默认分块大小：8 MiB。 */
export const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024
/** 默认单文件上限：2 GiB。 */
export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
/** 默认暂存区总量上限：10 GiB。 */
export const DEFAULT_STAGING_BYTES = 10 * 1024 * 1024 * 1024
/** workspace 模式默认落点目录（相对工作区根）。 */
export const DEFAULT_UPLOAD_DIR = '.uploads'
/** 契约版本，host 与 client 对齐用。 */
export const PROTOCOL_VERSION = '1'

/** 统一错误类型：code 稳定、status 是建议 HTTP 状态码、extra 合并进 error 对象。 */
export class CoreError extends Error {
  /**
   * @param {string} code - 稳定错误码（客户端按它分支）。
   * @param {string} message - 给用户看的中文说明。
   * @param {number} [status] - 建议 HTTP 状态码。
   * @param {Record<string, unknown>} [extra] - 附加字段（如 received）。
   */
  constructor(code, message, status = 400, extra = {}) {
    super(message)
    this.name = 'CoreError'
    this.code = code
    this.status = status
    this.extra = extra
  }
}

/**
 * 把未知异常映射成 CoreError（只读判断，不修改原异常）。
 * @param {unknown} error
 * @returns {CoreError}
 */
export function toCoreError(error) {
  if (error instanceof CoreError) return error
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  if (code === 'ENOENT') return new CoreError('not-found', '文件或目录不存在', 404)
  if (code === 'EACCES' || code === 'EPERM') return new CoreError('permission-denied', '没有权限访问该路径', 403)
  if (code === 'ENOSPC') return new CoreError('no-space', '磁盘空间不足', 507)
  const message = error instanceof Error ? error.message : String(error)
  return new CoreError('internal', `内部错误：${message}`, 500)
}

// ───────────────────────────── 路径约束 ─────────────────────────────

/**
 * 校验“相对工作区的路径”：拒绝绝对路径、`..`、NUL、盘符形式。
 * 允许空字符串（代表工作区根）。
 * @param {unknown} relative
 * @returns {string}
 */
export function assertRelativePath(relative) {
  if (typeof relative !== 'string') throw new CoreError('invalid-path', '路径必须是字符串', 400)
  if (relative.includes('\0')) throw new CoreError('invalid-path', '路径不能包含 NUL 字符', 400)
  if (relative === '') return ''
  if (path.isAbsolute(relative) || /^[A-Za-z]:[\\/]/.test(relative)) {
    throw new CoreError('path-escape', '只接受相对工作区的路径', 403)
  }
  // 反斜杠也按分隔符处理，避免 Windows 风格路径绕过 `..` 检查。
  const segments = relative.split(/[\\/]+/)
  for (const segment of segments) {
    if (segment === '..') throw new CoreError('path-escape', '路径不允许包含 ".."', 403)
  }
  return relative
}

/**
 * 把相对路径解析成工作区内的绝对路径，并做符号链接逃逸校验。
 *
 * 校验顺序：
 * 1. 语法层：绝对路径 / `..` / NUL → 直接拒绝；
 * 2. 词法层：`path.resolve(root, rel)` 必须仍在 root 之下；
 * 3. 物理层：目标自身（或最深的已存在祖先）的 realpath 必须在 root 的 realpath 之下，
 *    因此工作区里指向外部的软链接无法被利用。
 *
 * @param {string} root - 工作区根目录（绝对路径）。
 * @param {string} relative - 相对路径，空串代表根。
 * @returns {Promise<string>} 工作区内的绝对路径（尾部可以尚不存在）。
 */
export async function resolveInside(root, relative) {
  if (typeof root !== 'string' || root === '' || !path.isAbsolute(root)) {
    throw new CoreError('invalid-root', '工作区根目录无效', 500)
  }
  assertRelativePath(relative)
  const rootAbs = path.resolve(root)
  const target = path.resolve(rootAbs, relative)
  if (target !== rootAbs && !target.startsWith(rootAbs + path.sep)) {
    throw new CoreError('path-escape', '路径超出工作区范围', 403)
  }
  let realRoot
  try {
    realRoot = await realpath(rootAbs)
  } catch (error) {
    const mapped = toCoreError(error)
    if (mapped.code === 'not-found') throw new CoreError('workspace-missing', '工作区目录不存在', 404)
    throw mapped
  }
  // 逐段 lstat：任何一个已存在的软链接都必须仍指向工作区内，
  // 悬空软链接（可能指向外部）同样拒绝——否则写入会穿透到工作区外。
  let cursor = rootAbs
  for (const segment of target.slice(rootAbs.length).split(path.sep).filter((item) => item !== '')) {
    cursor = path.join(cursor, segment)
    let info
    try {
      info = await lstat(cursor)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') break
      throw error
    }
    if (!info.isSymbolicLink()) continue
    let resolved
    try {
      resolved = await realpath(cursor)
    } catch {
      throw new CoreError('path-escape', '该路径经过失效的符号链接', 403)
    }
    if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) {
      throw new CoreError('path-escape', '该路径经符号链接指向工作区外', 403)
    }
  }
  return target
}

/**
 * 计算 absolute 相对 root 的、以 / 分隔的展示路径。
 * @param {string} root
 * @param {string} absolute
 * @returns {string}
 */
export function relativeDisplayPath(root, absolute) {
  const rel = path.relative(path.resolve(root), path.resolve(absolute))
  return rel === '' ? '' : rel.split(path.sep).join('/')
}

// ───────────────────────────── Range 解析 ─────────────────────────────

/** Range 解析结果：null 表示没有 Range（返回整份文件）。 */
export const RANGE_UNSATISFIABLE = 'unsatisfiable'

/**
 * 解析单个 `bytes=` Range。
 *
 * 只支持单段（多段在契约里按非法处理 → 416），支持：
 * - `bytes=start-end`（end 超出文件大小时截断到 size-1）
 * - `bytes=start-`（到文件末尾）
 * - `bytes=-suffix`（最后 suffix 字节）
 *
 * @param {string | null | undefined} headerValue - `request.headers.get('range')`。
 * @param {number} size - 文件总字节数。
 * @returns {null | 'unsatisfiable' | {start:number,end:number}}
 */
export function parseSingleRange(headerValue, size) {
  if (headerValue === undefined || headerValue === null) return null
  if (typeof headerValue !== 'string') return RANGE_UNSATISFIABLE
  if (!Number.isSafeInteger(size) || size < 0) return RANGE_UNSATISFIABLE
  const match = /^bytes=(.*)$/i.exec(headerValue.trim())
  if (match === null) return RANGE_UNSATISFIABLE
  const spec = match[1].trim()
  if (spec === '' || spec.includes(',')) return RANGE_UNSATISFIABLE
  const parts = /^(\d*)-(\d*)$/.exec(spec)
  if (parts === null) return RANGE_UNSATISFIABLE
  const first = parts[1]
  const last = parts[2]
  if (first === '' && last === '') return RANGE_UNSATISFIABLE
  if (size === 0) return RANGE_UNSATISFIABLE
  if (first === '') {
    const suffix = Number(last)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return RANGE_UNSATISFIABLE
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(first)
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return RANGE_UNSATISFIABLE
  if (last === '') return { start, end: size - 1 }
  const end = Number(last)
  if (!Number.isSafeInteger(end) || end < start) return RANGE_UNSATISFIABLE
  return { start, end: Math.min(end, size - 1) }
}

// ───────────────────────── 文件名 / 响应头 ─────────────────────────

/** 常见扩展名 → MIME 映射（不引第三方依赖，够用即可）。 */
const MIME_BY_EXTENSION = new Map(Object.entries({
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.sh': 'text/x-shellscript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.7z': 'application/x-7z-compressed',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
}))

/**
 * 按文件名猜 Content-Type。
 * @param {string} filename
 * @returns {string}
 */
export function contentTypeFor(filename) {
  if (typeof filename !== 'string') return 'application/octet-stream'
  const mime = MIME_BY_EXTENSION.get(path.extname(filename).toLowerCase())
  return mime ?? 'application/octet-stream'
}

/**
 * 把浏览器传来的原始文件名收敛成安全的单段文件名。
 *
 * - 永远只取最后一段（防伪造子路径）；
 * - 拒绝空名 / `.` / `..` / NUL / 控制字符；
 * - 超长名截断到 160 字节左右但保留扩展名。
 *
 * @param {unknown} rawName
 * @returns {string}
 */
export function sanitizeFileName(rawName) {
  if (typeof rawName !== 'string') throw new CoreError('invalid-name', '文件名必须是字符串', 400)
  const trimmed = rawName.trim()
  if (trimmed === '') throw new CoreError('invalid-name', '文件名不能为空', 400)
  const segments = trimmed.split(/[\\/]+/).filter((segment) => segment !== '')
  const base = segments.length === 0 ? '' : segments[segments.length - 1]
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '')
  if (cleaned === '' || cleaned === '.' || cleaned === '..') {
    throw new CoreError('invalid-name', '文件名无效', 400)
  }
  if (cleaned.length <= 160) return cleaned
  const extension = path.extname(cleaned).slice(0, 20)
  const stem = cleaned.slice(0, cleaned.length - path.extname(cleaned).length)
  return stem.slice(0, Math.max(1, 160 - extension.length)) + extension
}

/** RFC 5987 编码（filename* 用）。 */
function encodeRfc5987(value) {
  return encodeURIComponent(value).replace(/['()*]/g, (char) =>
    '%' + char.charCodeAt(0).toString(16).toUpperCase())
}

/**
 * 构造下载响应头：`attachment; filename="ascii 回退"; filename*=UTF-8''...`。
 * 同时把引号、反斜杠、换行等会破坏头部的字符替换掉，防响应头注入。
 * @param {string} filename
 * @returns {string}
 */
export function contentDisposition(filename) {
  const raw = typeof filename === 'string' && filename !== '' ? filename : 'download'
  const fallback = raw.replace(/[^\x20-\x7e]/g, '_').replace(/["\\\r\n]/g, '_')
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(raw)}`
}

/**
 * 把客户端脚本安全地内联进 `<script>`：源码里出现 `</script` 或 `<!--`
 * 会截断/篡改 HTML。这里做最小转义（对合法 JS 语义无影响：
 * 二者通常只出现在字符串或正则里，`\/` 与 `\!` 都是等价写法）。
 * @param {string} source
 * @returns {string}
 */
export function escapeInlineScript(source) {
  if (typeof source !== 'string') return ''
  return source
    .replace(/<\/script/gi, (match) => '<\\/' + match.slice(2))
    .replace(/<!--/g, '<\\!--')
}

/**
 * 在工作区内为 name 找一个不冲突的名字：重名依次加 ` (1)`、` (2)`……
 * @param {string} dirAbs - 已存在的目录绝对路径。
 * @param {string} name - 目标文件名。
 * @returns {Promise<string>}
 */
export async function uniqueNameIn(dirAbs, name) {
  const extension = path.extname(name)
  const stem = name.slice(0, name.length - extension.length)
  for (let index = 0; index < 10000; index += 1) {
    const candidate = index === 0 ? name : `${stem} (${index})${extension}`
    try {
      await stat(path.join(dirAbs, candidate))
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return candidate
      throw error
    }
  }
  throw new CoreError('name-conflict', '同名文件过多，无法分配新文件名', 409)
}

// ───────────────────────────── 分块存储 ─────────────────────────────

/** uploadId 的合法形状（randomUUID）。 */
const UPLOAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 把 Web ReadableStream（或任意异步可迭代对象）转成异步生成器。
 * 完全读完后释放 reader；调用方可以中途 return 让流被取消。
 * @param {ReadableStream<Uint8Array> | null | undefined} body
 * @returns {AsyncGenerator<Uint8Array>}
 */
export async function* bodyChunks(body) {
  if (body === null || body === undefined) return
  const reader = body.getReader()
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done === true) return
      yield next.value
    }
  } finally {
    reader.releaseLock()
  }
}

/** 读取文件长度；不存在时返回 0（暂存 data.bin 可能尚未创建）。 */
async function fileSizeOrZero(filePath) {
  try {
    const info = await stat(filePath)
    return info.size
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 0
    throw error
  }
}

/** 流式计算文件 sha256（十六进制小写）。 */
async function sha256File(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

/** 跨设备也能用的“移动”：先 rename，EXDEV 时退化为 copy + unlink。 */
async function moveFile(source, destination) {
  try {
    await rename(source, destination)
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EXDEV') throw error
    await copyFile(source, destination)
    await unlink(source)
  }
}

/**
 * 分块上传暂存区。
 *
 * 每个 upload 一个目录：`{meta.json, data.bin}`。写盘只追加在文件末尾，
 * 因此“已接收字节数”始终等于 data.bin 的长度，偏移校验是幂等的。
 * 同一 upload 的写操作通过内存锁串行化，避免并发 chunk 交叉写坏文件。
 */
export class TransferStore {
  /**
   * @param {object} options
   * @param {string} options.root - 暂存区根目录（绝对路径）。
   * @param {number} [options.maxFileBytes] - 单文件上限。
   * @param {number} [options.stagingBytes] - 暂存区总量上限。
   */
  constructor({ root, maxFileBytes = DEFAULT_MAX_FILE_BYTES, stagingBytes = DEFAULT_STAGING_BYTES }) {
    if (typeof root !== 'string' || root === '') throw new Error('TransferStore 需要 root')
    this.root = path.resolve(root)
    this.maxFileBytes = maxFileBytes
    this.stagingBytes = stagingBytes
    /** @type {Map<string, Promise<void>>} uploadId → 队尾 */
    this.locks = new Map()
  }

  /** 确保暂存区根目录存在。 */
  async ensureRoot() {
    await mkdir(this.root, { recursive: true })
  }

  /** uploadId → 目录绝对路径（含合法性校验）。 */
  dirOf(uploadId) {
    if (typeof uploadId !== 'string' || !UPLOAD_ID_PATTERN.test(uploadId)) {
      throw new CoreError('upload-not-found', '上传任务不存在或已过期', 404)
    }
    return path.join(this.root, uploadId.toLowerCase())
  }

  /** uploadId → data.bin 绝对路径。 */
  dataPath(uploadId) {
    return path.join(this.dirOf(uploadId), 'data.bin')
  }

  /** uploadId → meta.json 绝对路径。 */
  metaPath(uploadId) {
    return path.join(this.dirOf(uploadId), 'meta.json')
  }

  /** 串行化同一 upload 的写操作。 */
  async acquire(uploadId) {
    const key = String(uploadId).toLowerCase()
    const previous = this.locks.get(key) ?? Promise.resolve()
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const chained = previous.then(() => gate)
    this.locks.set(key, chained)
    await previous
    let released = false
    return () => {
      if (released) return
      released = true
      release()
      if (this.locks.get(key) === chained) this.locks.delete(key)
    }
  }

  /** 读取并校验 meta。 */
  async meta(uploadId) {
    const filePath = this.metaPath(uploadId)
    let text
    try {
      text = await readFile(filePath, 'utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new CoreError('upload-not-found', '上传任务不存在或已过期', 404)
      }
      throw error
    }
    let meta
    try {
      meta = JSON.parse(text)
    } catch {
      throw new CoreError('upload-corrupt', '上传任务的元数据已损坏', 500)
    }
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
      throw new CoreError('upload-corrupt', '上传任务的元数据已损坏', 500)
    }
    return meta
  }

  /** 原子写 meta（tmp + rename）。 */
  async writeMeta(uploadId, meta) {
    const filePath = this.metaPath(uploadId)
    const temporary = `${filePath}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(meta), 'utf8')
    await rename(temporary, filePath)
  }

  /**
   * 暂存区当前“占用”字节数：未完成的上传按声明大小预留，已完成的（send 模式
   * 等待发送）按实际落盘大小计。这样配额在 init 时就生效，避免只靠 data.bin
   * 长度被大量“只建了空文件”的上传绕过。
   */
  async totalStagedBytes() {
    let total = 0
    let entries
    try {
      entries = await readdir(this.root, { withFileTypes: true })
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 0
      throw error
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const directory = path.join(this.root, entry.name)
      let meta
      try {
        meta = JSON.parse(await readFile(path.join(directory, 'meta.json'), 'utf8'))
      } catch {
        meta = undefined
      }
      if (meta !== null && typeof meta === 'object' && Number.isSafeInteger(meta.size)) {
        total += meta.finished === true
          ? await fileSizeOrZero(path.join(directory, 'data.bin'))
          : meta.size
        continue
      }
      total += await fileSizeOrZero(path.join(directory, 'data.bin'))
    }
    return total
  }

  /**
   * 新建一个上传任务。
   * @param {object} input
   * @param {string} input.sessionId - 目标会话。
   * @param {'workspace'|'send'} input.mode
   * @param {string} input.name - 已 sanitize 的展示文件名。
   * @param {number} input.size - 声明总字节数。
   * @param {string} [input.dir] - workspace 模式落点目录（相对路径，已校验）。
   * @returns {Promise<{uploadId:string, offset:0, name:string}>}
   */
  async init({ sessionId, mode, name, size, dir }) {
    if (!Number.isSafeInteger(size) || size < 0) throw new CoreError('invalid-size', '文件大小无效', 400)
    if (size > this.maxFileBytes) {
      throw new CoreError('too-large', `文件超过单文件上限 ${this.maxFileBytes} 字节`, 413, { limit: this.maxFileBytes })
    }
    const staged = await this.totalStagedBytes()
    if (staged + size > this.stagingBytes) {
      throw new CoreError('staging-quota-exceeded', '暂存区空间不足，请完成或取消未结束的上传', 413, {
        limit: this.stagingBytes,
        staged,
      })
    }
    await this.ensureRoot()
    const uploadId = randomUUID()
    await mkdir(this.dirOf(uploadId), { recursive: true })
    await writeFile(this.dataPath(uploadId), Buffer.alloc(0))
    await this.writeMeta(uploadId, {
      version: 1,
      uploadId,
      sessionId,
      mode,
      name,
      size,
      dir: dir ?? null,
      createdAt: Date.now(),
      finished: false,
      sha256: null,
    })
    return { uploadId, offset: 0, name }
  }

  /**
   * 追加一块字节。
   *
   * @param {string} uploadId
   * @param {number} offset - 客户端声明的起始偏移，必须等于 data.bin 当前长度。
   * @param {AsyncIterable<Uint8Array> | null} chunks - 请求体。
   * @param {object} [options]
   * @param {number} [options.maxChunkBytes] - 单块上限。
   * @returns {Promise<{offset:number, received:number}>}
   */
  async chunk(uploadId, offset, chunks, { maxChunkBytes = DEFAULT_CHUNK_BYTES } = {}) {
    const release = await this.acquire(uploadId)
    try {
      const meta = await this.meta(uploadId)
      if (meta.finished === true) throw new CoreError('upload-finished', '该上传已完成，不能再追加数据', 409)
      const dataPath = this.dataPath(uploadId)
      const current = await fileSizeOrZero(dataPath)
      // data.bin 缺失时补一个空文件，保证 'r+' 能打开。
      try {
        await stat(dataPath)
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          await writeFile(dataPath, Buffer.alloc(0))
        } else {
          throw error
        }
      }
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new CoreError('invalid-offset', 'offset 必须是非负整数', 400, { received: current })
      }
      if (offset !== current) {
        throw new CoreError('offset-mismatch', `offset 与已接收字节不一致（已收到 ${current}）`, 409, { received: current })
      }
      if (chunks === null || chunks === undefined) return { offset, received: current }

      const handle = await open(dataPath, 'r+')
      let position = current
      let failed = false
      try {
        for await (const piece of chunks) {
          const buffer = Buffer.isBuffer(piece)
            ? piece
            : Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength)
          if (buffer.length === 0) continue
          if (position + buffer.length - current > maxChunkBytes) {
            throw new CoreError('chunk-too-large', `单块超过上限 ${maxChunkBytes} 字节`, 413, { limit: maxChunkBytes })
          }
          if (position + buffer.length > meta.size) {
            throw new CoreError('too-large', `数据超过声明的文件大小 ${meta.size} 字节`, 413, { limit: meta.size })
          }
          let written = 0
          while (written < buffer.length) {
            const result = await handle.write(buffer, written, buffer.length - written, position + written)
            if (result.bytesWritten <= 0) throw new CoreError('write-failed', '写入暂存文件失败', 500)
            written += result.bytesWritten
          }
          position += buffer.length
        }
      } catch (error) {
        failed = true
        throw error
      } finally {
        if (failed) {
          // 回滚到本次请求开始时的长度，保持“offset 幂等”：客户端可用 409 的 received 重试。
          try {
            await truncateFile(handle, current)
          } catch {
            // 回滚失败不掩盖原始错误；下一次 stat 仍会给出真实 received。
          }
        }
        await handle.close()
      }
      return { offset, received: position }
    } finally {
      release()
    }
  }

  /**
   * 结束上传：校验大小（与可选 sha256），workspace 模式原子移动进工作区，
   * send 模式保留暂存区等待 /api/rfiles.send。
   *
   * @param {string} uploadId
   * @param {object} [options]
   * @param {string} [options.sha256] - 客户端声明的 sha256（可选）。
   * @param {string} [options.dirAbs] - workspace 模式目标目录（绝对路径，调用方已做路径校验）。
   * @param {string} [options.name] - 落盘名（默认 meta.name，重名自动加 (n)）。
   * @returns {Promise<{meta:object, size:number, sha256:string, name?:string, path?:string}>}
   */
  async finish(uploadId, { sha256, dirAbs, name } = {}) {
    const release = await this.acquire(uploadId)
    try {
      const meta = await this.meta(uploadId)
      if (meta.finished === true) throw new CoreError('upload-finished', '该上传已完成', 409)
      const dataPath = this.dataPath(uploadId)
      const current = await fileSizeOrZero(dataPath)
      if (current !== meta.size) {
        if (current < meta.size) {
          throw new CoreError('incomplete', `还差 ${meta.size - current} 字节未上传`, 409, {
            received: current,
            expected: meta.size,
          })
        }
        throw new CoreError('too-large', '实际数据超过声明的文件大小', 413, { received: current, expected: meta.size })
      }
      const actual = await sha256File(dataPath)
      if (typeof sha256 === 'string' && sha256 !== '' && sha256.toLowerCase() !== actual) {
        await this.#remove(uploadId)
        throw new CoreError('hash-mismatch', '文件校验和不匹配，请重新上传', 400, { sha256: actual })
      }
      const result = { meta: { ...meta }, size: meta.size, sha256: actual }
      if (dirAbs !== undefined) {
        const directory = path.resolve(dirAbs)
        await mkdir(directory, { recursive: true })
        const finalName = await uniqueNameIn(directory, name ?? meta.name)
        const target = path.join(directory, finalName)
        await moveFile(dataPath, target)
        await rm(this.dirOf(uploadId), { recursive: true, force: true })
        result.name = finalName
        result.path = target
        return result
      }
      meta.finished = true
      meta.sha256 = actual
      meta.finishedAt = Date.now()
      await this.writeMeta(uploadId, meta)
      result.meta = meta
      return result
    } finally {
      release()
    }
  }

  /** 删除一个上传任务的全部暂存数据（幂等）。 */
  async cancel(uploadId) {
    const release = await this.acquire(uploadId)
    try {
      await this.#remove(uploadId)
    } finally {
      release()
    }
  }

  /** 不做锁的内部删除。 */
  async #remove(uploadId) {
    await rm(this.dirOf(uploadId), { recursive: true, force: true })
  }
}

/** 用已打开的句柄截断文件（保持 offset 幂等）。 */
async function truncateFile(handle, size) {
  await handle.truncate(size)
}

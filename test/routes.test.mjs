/**
 * Host 路由单测：用 mock ctx + 真实临时目录，直接调用 route.fetch(Request)。
 *
 * 覆盖：健康检查/配置/会话列表、列目录、分块上传（含 409 续传）、finish 校验、
 * workspace 落盘与重名、send（file/image 两种附件 + prompt 参数）、下载（200/206/416）、
 * 会话日志导出转发、index 注入行形状。
 * 运行：node --test test/
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'

/** 建一个临时目录。 */
async function makeTempDir(prefix = 'rfiles-routes-') {
  return await mkdtemp(path.join(os.tmpdir(), prefix))
}

/** 造一个“会话对象”形状（Session.header）。 */
function sessionOf(id, cwd, createdAt, title) {
  const header = { id, cwd, createdAt }
  if (title !== undefined) header.title = title
  return { header }
}

/**
 * 构造 mock 宿主上下文并安装插件。
 * @param {object} options
 */
function createHarness(options = {}) {
  const routes = new Map()
  const listeners = new Map()
  const records = { uploads: [], prompts: [] }
  const liveSessions = new Map(options.liveSessions ?? [])
  const persisted = new Map(options.persisted ?? [])
  const listFactory = options.sessions ?? (() => [])
  const ctx = {
    effect(callback) {
      return callback()
    },
    on(eventName, listener) {
      const bucket = listeners.get(eventName) ?? []
      bucket.push(listener)
      listeners.set(eventName, bucket)
      return () => undefined
    },
    get(serviceName) {
      if (serviceName === 'sessionPersistence') {
        return { stat: async (sessionId) => persisted.get(sessionId) }
      }
      return undefined
    },
    connection: {
      fetch: {
        register(route) {
          if (routes.has(route.path)) throw new Error(`重复注册路由 ${route.path}`)
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    },
    webServer: { port: options.port ?? 0, host: '127.0.0.1', protocol: 'http:' },
    sessions: {
      list: () => listFactory(),
      get: (sessionId) => liveSessions.get(sessionId),
    },
    sandboxPolicy: { workspaceRoot: options.workspaceRoot },
    fileUploads: {
      uploadStream: async (input) => {
        records.uploads.push({ sessionId: input.sessionId, name: input.name })
        return { receiptId: `receipt-${records.uploads.length}`, file: {} }
      },
    },
    sessionController: {
      prompt: async (request) => {
        records.prompts.push(request)
        return { accepted: true }
      },
    },
  }
  apply(ctx, {
    transferRoot: options.transferRoot,
    chunkBytes: options.chunkBytes ?? 16,
    maxFileBytes: options.maxFileBytes ?? 1024,
    stagingBytes: options.stagingBytes ?? 1 << 20,
  })
  return { ctx, routes, records, listeners, liveSessions }
}

/** 直接调用已注册路由的 fetch。 */
async function callRoute(routes, pathname, { method = 'GET', query, body, headers = {} } = {}) {
  const route = routes.get(pathname)
  assert.ok(route !== undefined, `未注册路由 ${pathname}`)
  const url = new URL(`http://127.0.0.1${pathname}`)
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value))
  const init = { method, headers: { ...headers } }
  if (body !== undefined) {
    if (typeof body === 'string' || body instanceof Uint8Array) {
      init.body = body
    } else {
      init.body = JSON.stringify(body)
      init.headers['content-type'] = 'application/json'
    }
  }
  return await route.fetch(new Request(url, init))
}

/** 解析 JSON 响应体。 */
async function jsonOf(response) {
  return JSON.parse(await response.text())
}

/** 走一遍 init → chunk → finish。 */
async function upload(routes, { sessionId, mode, name, content, dir }) {
  const initResponse = await callRoute(routes, '/api/rfiles.upload.init', {
    method: 'POST',
    body: { sessionId, mode, name, size: Buffer.byteLength(content), ...(dir === undefined ? {} : { dir }) },
  })
  const initBody = await jsonOf(initResponse)
  assert.equal(initResponse.status, 200)
  assert.equal(initBody.ok, true)
  const uploadId = initBody.uploadId
  const chunkResponse = await callRoute(routes, '/api/rfiles.upload.chunk', {
    method: 'PUT',
    query: { uploadId, offset: 0 },
    body: content,
  })
  assert.equal(chunkResponse.status, 200)
  const finishResponse = await callRoute(routes, '/api/rfiles.upload.finish', {
    method: 'POST',
    body: { uploadId },
  })
  return { uploadId, finishResponse, finishBody: await jsonOf(finishResponse) }
}

// ─────────────────────── 健康检查 / 配置 / 会话 ───────────────────────

test('health / config / sessions', async () => {
  const workspaceRoot = await makeTempDir('rfiles-ws-')
  const transferRoot = await makeTempDir()
  const sessions = [
    sessionOf('s-late', workspaceRoot, 300),
    sessionOf('s-early', workspaceRoot, 100, '早期会话'),
    { header: { id: 's-no-cwd', createdAt: 200 } },
    sessionOf('s-mid', workspaceRoot, 200),
  ]
  try {
    const harness = createHarness({ workspaceRoot, transferRoot, sessions: () => sessions })

    const health = await callRoute(harness.routes, '/api/rfiles.health')
    assert.equal(health.status, 200)
    assert.deepEqual(await jsonOf(health), { ok: true, version: '1', workspaceRoot })

    // 不带 sessionId：只回 limits
    const configOnly = await jsonOf(await callRoute(harness.routes, '/api/rfiles.config'))
    assert.equal(configOnly.ok, true)
    assert.equal(configOnly.workspaceRoot, undefined)
    assert.equal(configOnly.limits.chunkBytes, 16)
    assert.ok(configOnly.limits.maxFileBytes > 0)

    // 带 sessionId：补 workspaceRoot
    const live = sessionOf('s1', workspaceRoot, 1)
    harness.liveSessions.set('s1', live)
    const configWithSession = await jsonOf(await callRoute(harness.routes, '/api/rfiles.config', { query: { sessionId: 's1' } }))
    assert.equal(configWithSession.workspaceRoot, workspaceRoot)

    // 未知会话 → 404 session-not-found
    const missing = await callRoute(harness.routes, '/api/rfiles.config', { query: { sessionId: 'nope' } })
    assert.equal(missing.status, 404)
    assert.equal((await jsonOf(missing)).error.code, 'session-not-found')

    // sessions：过滤无 cwd 的，按 createdAt 升序，不泄露额外内部字段
    const sessionsResponse = await callRoute(harness.routes, '/api/rfiles.sessions')
    const sessionsBody = await jsonOf(sessionsResponse)
    assert.deepEqual(sessionsBody.sessions.map((item) => item.id), ['s-early', 's-mid', 's-late'])
    assert.equal(sessionsBody.sessions[0].title, '早期会话')
    assert.equal(sessionsBody.sessions[1].title, undefined)
    for (const item of sessionsBody.sessions) {
      assert.equal(item.cwd, workspaceRoot)
      assert.equal(item.createdAt, undefined)
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
    await rm(transferRoot, { recursive: true, force: true })
  }
})

test('冷会话从 sessionPersistence 解析工作区', async () => {
  const workspaceRoot = await makeTempDir('rfiles-ws-')
  const transferRoot = await makeTempDir()
  try {
    const harness = createHarness({
      workspaceRoot: '/definitely/not/used',
      transferRoot,
      persisted: [['cold-1', { header: { id: 'cold-1', cwd: workspaceRoot } }]],
    })
    const response = await callRoute(harness.routes, '/api/rfiles.config', { query: { sessionId: 'cold-1' } })
    const body = await jsonOf(response)
    assert.equal(body.workspaceRoot, workspaceRoot)
    // 列表也能工作（无 sessionId 时回落到 sandboxPolicy.workspaceRoot，这里是 /definitely/not/used，根不存在）
    const listMissingRoot = await callRoute(harness.routes, '/api/rfiles.list', { query: { sessionId: 'cold-1' } })
    assert.equal(listMissingRoot.status, 200)
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
    await rm(transferRoot, { recursive: true, force: true })
  }
})

// ───────────────────────────── 列目录 ─────────────────────────────

test('list：dir 优先、名称排序、字段完整、拒绝逃逸与特殊文件', async () => {
  const workspaceRoot = await makeTempDir('rfiles-ws-')
  const outside = await makeTempDir('rfiles-outside-')
  const transferRoot = await makeTempDir()
  try {
    await mkdir(path.join(workspaceRoot, 'sub'))
    await writeFile(path.join(workspaceRoot, 'b.txt'), 'hello')
    await writeFile(path.join(workspaceRoot, 'a.txt'), 'ab')
    await writeFile(path.join(outside, 'secret.txt'), 'secret')
    await symlink(outside, path.join(workspaceRoot, 'escape-link'))

    const harness = createHarness({ workspaceRoot, transferRoot, liveSessions: [['s1', sessionOf('s1', workspaceRoot, 1)]] })
    const response = await callRoute(harness.routes, '/api/rfiles.list', { query: { sessionId: 's1', path: '' } })
    assert.equal(response.status, 200)
    const body = await jsonOf(response)
    assert.equal(body.path, '')
    assert.deepEqual(body.entries.map((entry) => entry.name), ['sub', 'a.txt', 'b.txt'])
    assert.equal(body.entries[0].kind, 'dir')
    assert.equal(body.entries[0].size, 0)
    assert.equal(body.entries[1].kind, 'file')
    assert.equal(body.entries[1].size, 2)
    assert.equal(typeof body.entries[1].mtime, 'number')
    // 指向工作区外的软链接必须被隐藏
    assert.ok(!body.entries.some((entry) => entry.name === 'escape-link'))

    // 子目录（空）
    const sub = await jsonOf(await callRoute(harness.routes, '/api/rfiles.list', { query: { sessionId: 's1', path: 'sub' } }))
    assert.deepEqual(sub.entries, [])

    // 逃逸路径 → 403
    for (const bad of ['..', '../etc', '/etc', 'sub/../../escape', '..\\..\\x']) {
      const rejected = await callRoute(harness.routes, '/api/rfiles.list', { query: { sessionId: 's1', path: bad } })
      assert.equal(rejected.status, 403, `path=${bad}`)
      assert.equal((await jsonOf(rejected)).error.code, 'path-escape')
    }

    // 直接访问逃逸软链接也拒绝
    const linkDirect = await callRoute(harness.routes, '/api/rfiles.list', { query: { sessionId: 's1', path: 'escape-link' } })
    assert.equal(linkDirect.status, 403)

    // 文件当目录列出 → 400
    const notDir = await callRoute(harness.routes, '/api/rfiles.list', { query: { sessionId: 's1', path: 'a.txt' } })
    assert.equal(notDir.status, 400)
    assert.equal((await jsonOf(notDir)).error.code, 'not-a-directory')
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
    await rm(transferRoot, { recursive: true, force: true })
  }
})

// ───────────────────────────── 上传 ─────────────────────────────

test('upload.chunk 注册为 streaming，乱序返回 409 + received，续传后 finish 成功', async () => {
  const workspaceRoot = await makeTempDir('rfiles-ws-')
  const transferRoot = await makeTempDir()
  try {
    const harness = createHarness({ workspaceRoot, transferRoot, liveSessions: [['s1', sessionOf('s1', workspaceRoot, 1)]] })
    assert.equal(harness.routes.get('/api/rfiles.upload.chunk').requestBody, 'streaming')

    const initResponse = await callRoute(harness.routes, '/api/rfiles.upload.init', {
      method: 'POST',
      body: { sessionId: 's1', mode: 'workspace', name: 'hello.txt', size: 11 },
    })
    const { uploadId } = await jsonOf(initResponse)

    const first = await callRoute(harness.routes, '/api/rfiles.upload.chunk', {
      method: 'PUT', query: { uploadId, offset: 0 }, body: Buffer.from('hello '),
    })
    assert.deepEqual(await jsonOf(first), { ok: true, offset: 0, received: 6 })

    const outOfOrder = await callRoute(harness.routes, '/api/rfiles.upload.chunk', {
      method: 'PUT', query: { uploadId, offset: 0 }, body: Buffer.from('XX'),
    })
    assert.equal(outOfOrder.status, 409)
    const outOfOrderBody = await jsonOf(outOfOrder)
    assert.equal(outOfOrderBody.ok, false)
    assert.equal(outOfOrderBody.error.code, 'offset-mismatch')
    assert.equal(outOfOrderBody.error.received, 6)

    const second = await callRoute(harness.routes, '/api/rfiles.upload.chunk', {
      method: 'PUT', query: { uploadId, offset: 6 }, body: Buffer.from('world'),
    })
    assert.deepEqual(await jsonOf(second), { ok: true, offset: 6, received: 11 })

    const finishResponse = await callRoute(harness.routes, '/api/rfiles.upload.finish', { method: 'POST', body: { uploadId } })
    const finishBody = await jsonOf(finishResponse)
    assert.equal(finishResponse.status, 200)
    assert.equal(finishBody.ok, true)
    assert.equal(finishBody.mode, 'workspace')
    assert.equal(finishBody.path, '.uploads/hello.txt')
    assert.equal(finishBody.name, 'hello.txt')
    assert.equal(finishBody.size, 11)
    assert.match(finishBody.mime, /^text\/plain/)
    assert.equal(await readFile(path.join(workspaceRoot, '.uploads', 'hello.txt'), 'utf8'), 'hello world')
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
    await rm(transferRoot, { recursive: true, force: true })
  }
})

test('upload.finish：大小不足 409、sha256 不符 400、超出声明大小 413、单块上限 413', async () => {
  const workspaceRoot = await makeTempDir('rfiles-ws-')
  const transferRoot = await makeTempDir()
  try {
    const harness = createHarness({ workspaceRoot, transferRoot, liveSessions: [['s1', sessionOf('s1', workspaceRoot, 1)]] })
    const init = async (name, size) => {
      const response = await callRoute(harness.routes, '/api/rfiles.upload.init', {
        method: 'POST', body: { sessionId: 's1', mode: 'send', name, size },
      })
      return (await jsonOf(response)).uploadId
    }

    // 大小不足
    const shortId = await init('short.bin', 5)
    await callRoute(harness.routes, '/api/rfiles.upload.chunk', { method: 'PUT', query: { uploadId: shortId, offset: 0 }, body: Buffer.from('ab') })
    const short = await callRoute(harness.routes, '/api/rfiles.upload.finish', { method: 'POST', body: { uploadId: shortId } })
    assert.equal(short.status, 409)
    const shortBody = await jsonOf(short)
    assert.equal(shortBody.error.code, 'incomplete')
    assert.equal(shortBody.error.received, 2)
    assert.equal(shortBody.error.expected, 5)

    // sha256 不符
    const hashId = await init('hash.txt', 3)
    await callRoute(harness.routes, '/api/rfiles.upload.chunk', { method: 'PUT', query: { uploadId: hashId, offset: 0 }, body: Buffer.from('abc') })
    const badHash = await callRoute(harness.routes, '/api/rfiles.upload.finish', {
      method: 'POST', body: { uploadId: hashId, sha256: '0'.repeat(64) },
    })
    assert.equal(badHash.status, 400)
    assert.equal((await jsonOf(badHash)).error.code, 'hash-mismatch')
    // 校验失败后暂存被清空
    const gone = await callRoute(harness.routes, '/api/rfiles.upload.finish', { method: 'POST', body: { uploadId: hashId } })
    assert.equal(gone.status, 404)

    // 超出声明大小
    const overId = await init('over.bin', 2)
    const over = await callRoute(harness.routes, '/api/rfiles.upload.chunk', { method: 'PUT', query: { uploadId: overId, offset: 0 }, body: Buffer.from('abc') })
    assert.equal(over.status, 413)
    assert.equal((await jsonOf(over)).error.code, 'too-large')

    // 单块上限（chunkBytes = 16）
    const chunkId = await init('chunk.bin', 64)
    const bigChunk = await callRoute(harness.routes, '/api/rfiles.upload.chunk', {
      method: 'PUT', query: { uploadId: chunkId, offset: 0 }, body: Buffer.alloc(20, 1),
    })
    assert.equal(bigChunk.status, 413)
    assert.equal((await jsonOf(bigChunk)).error.code, 'chunk-too-large')

    // 非法 offset 字符串
    const badOffset = await callRoute(harness.routes, '/api/rfiles.upload.chunk', {
      method: 'PUT', query: { uploadId: chunkId, offset: 'x' }, body: Buffer.from('a'),
    })
    assert.equal(badOffset.status, 400)
    assert.equal((await jsonOf(badOffset)).error.code, 'invalid-offset')
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
    await rm(transferRoot, { recursive: true, force: true })
  }
})

test('upload.init：未知会话 404、非法 mode 400、逃逸目录 403；cancel 幂等', async () => {
  const workspaceRoot = await makeTempDir('rfiles-ws-')
  const transferRoot = await makeTempDir()
  try {
    const harness = createHarness({ workspaceRoot, transferRoot, liveSessions: [['s1', sessionOf('s1', workspaceRoot, 1)]] })
    const post = (body) => callRoute(harness.routes, '/api/rfiles.upload.init', { method: 'POST', body })

    assert.equal((await post({ sessionId: 'nope', mode: 'send', name: 'a.txt', size: 1 })).status, 404)
    assert.equal((await post({ sessionId: 's1', mode: 'other', name: 'a.txt', size: 1 })).status, 400)
    const escape = await post({ sessionId: 's1', mode: 'workspace', name: 'a.txt', size: 1, dir: '../outside' })
    assert.equal(escape.status, 403)
    assert.equal((await jsonOf(escape)).error.code, 'path-escape')

    const initResponse = await post({ sessionId: 's1', mode: 'send', name: 'cancel.txt', size: 4 })
    const { uploadId } = await jsonOf(initResponse)
    const cancel = await callRoute(harness.routes, '/api/rfiles.upload.cancel', { method: 'POST', body: { uploadId } })
    assert.deepEqual(await jsonOf(cancel), { ok: true })
    // 再次 cancel 也返回 ok（幂等）
    const cancelAgain = await callRoute(harness.routes, '/api/rfiles.upload.cancel', { method: 'POST', body: { uploadId } })
    assert.deepEqual(await jsonOf(cancelAgain), { ok: true })
    const finish = await callRoute(harness.routes, '/api/rfiles.upload.finish', { method: 'POST', body: { uploadId } })
    assert.equal(finish.status, 404)
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
    await rm(transferRoot, { recursive: true, force: true })
  }
})

test('workspace 重名自动加 (n)', async () => {
  const workspaceRoot = await makeTempDir('rfiles-ws-')
  const transferRoot = await makeTempDir()
  try {
    const harness = createHarness({ workspaceRoot, transferRoot, liveSessions: [['s1', sessionOf('s1', workspaceRoot, 1)]] })
    const first = await upload(harness.routes, { sessionId: 's1', mode: 'workspace', name: 'note.txt', content: 'one' })
    assert.equal(first.finishBody.path, '.uploads/note.txt')
    const second = await upload(harness.routes, { sessionId: 's1', mode: 'workspace', name: 'note.txt', content: 'two' })
    assert.equal(second.finishBody.path, '.uploads/note (1).txt')
    assert.equal(await readFile(path.join(workspaceRoot, '.uploads', 'note (1).txt'), 'utf8'), 'two')
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
    await rm(transferRoot, { recursive: true, force: true })
  }
})

// ───────────────────────────── 发送给 Agent ─────────────────────────────

test('send：普通文件走 receipt + prompt；暂存被清理', async () => {
  const workspaceRoot = await makeTempDir('rfiles-ws-')
  const transferRoot = await makeTempDir()
  try {
    const harness = createHarness({ workspaceRoot, transferRoot, liveSessions: [['s1', sessionOf('s1', workspaceRoot, 1)]] })
    const uploaded = await upload(harness.routes, { sessionId: 's1', mode: 'send', name: 'note.txt', content: 'hello' })
    assert.equal(uploaded.finishBody.mode, 'send')

    const sendResponse = await callRoute(harness.routes, '/api/rfiles.send', {
      method: 'POST',
      body: { sessionId: 's1', uploadIds: [uploaded.uploadId], text: '看一下这个文件' },
    })
    const sendBody = await jsonOf(sendResponse)
    assert.equal(sendResponse.status, 200)
    assert.deepEqual(sendBody, { ok: true, sent: ['note.txt'] })

    // 官方收据：uploadStream 收到 sessionId + name
    assert.equal(harness.records.uploads.length, 1)
    assert.equal(harness.records.uploads[0].sessionId, 's1')
    assert.equal(harness.records.uploads[0].name, 'note.txt')

    // prompt 参数形状
    assert.equal(harness.records.prompts.length, 1)
    const prompt = harness.records.prompts[0]
    assert.equal(prompt.sessionId, 's1')
    assert.equal(typeof prompt.requestId, 'string')
    assert.deepEqual(prompt.content, [
      { type: 'text', text: '看一下这个文件' },
      { type: 'file', receiptId: 'receipt-1' },
    ])
    assert.equal(prompt.mode, 'queue')

    // 发送成功后暂存清理
    const finishAgain = await callRoute(harness.routes, '/api/rfiles.upload.finish', {
      method: 'POST', body: { uploadId: uploaded.uploadId },
    })
    assert.equal(finishAgain.status, 404)
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
    await rm(transferRoot, { recursive: true, force: true })
  }
})

test('send：图片走 image 附件（base64 + mediaType），不产生 receipt', async () => {
  const workspaceRoot = await makeTempDir('rfiles-ws-')
  const transferRoot = await makeTempDir()
  try {
    const harness = createHarness({ workspaceRoot, transferRoot, liveSessions: [['s1', sessionOf('s1', workspaceRoot, 1)]] })
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const uploaded = await upload(harness.routes, { sessionId: 's1', mode: 'send', name: 'shot.PNG', content: pngBytes })
    const sendResponse = await callRoute(harness.routes, '/api/rfiles.send', {
      method: 'POST', body: { sessionId: 's1', uploadIds: [uploaded.uploadId] },
    })
    assert.equal(sendResponse.status, 200)
    assert.equal(harness.records.uploads.length, 0)
    const prompt = harness.records.prompts[0]
    assert.equal(prompt.content.length, 1)
    assert.equal(prompt.content[0].type, 'image')
    assert.equal(prompt.content[0].mediaType, 'image/png')
    assert.equal(prompt.content[0].data, pngBytes.toString('base64'))
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
    await rm(transferRoot, { recursive: true, force: true })
  }
})

test('send：workspace 模式/未知 uploadId 被拒绝；空 uploadIds 400', async () => {
  const workspaceRoot = await makeTempDir('rfiles-ws-')
  const transferRoot = await makeTempDir()
  try {
    const harness = createHarness({ workspaceRoot, transferRoot, liveSessions: [['s1', sessionOf('s1', workspaceRoot, 1)]] })
    const stored = await upload(harness.routes, { sessionId: 's1', mode: 'workspace', name: 'in-ws.txt', content: 'x' })

    // workspace 模式 finish 时已把文件移入工作区并从暂存区删除，
    // 因此该 uploadId 再次发送只会得到 404（暂存记录不存在）。
    const wrongMode = await callRoute(harness.routes, '/api/rfiles.send', {
      method: 'POST', body: { sessionId: 's1', uploadIds: [stored.uploadId] },
    })
    assert.equal(wrongMode.status, 404)
    assert.equal((await jsonOf(wrongMode)).error.code, 'upload-not-found')

    const unknown = await callRoute(harness.routes, '/api/rfiles.send', {
      method: 'POST', body: { sessionId: 's1', uploadIds: ['00000000-0000-4000-8000-000000000000'] },
    })
    assert.equal(unknown.status, 404)

    const empty = await callRoute(harness.routes, '/api/rfiles.send', { method: 'POST', body: { sessionId: 's1', uploadIds: [] } })
    assert.equal(empty.status, 400)
    assert.equal(harness.records.prompts.length, 0)
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
    await rm(transferRoot, { recursive: true, force: true })
  }
})

test('空文件：init 后直接 finish 也能落盘；下载返回 200/0 字节', async () => {
  const workspaceRoot = await makeTempDir('rfiles-ws-')
  const transferRoot = await makeTempDir()
  try {
    const harness = createHarness({ workspaceRoot, transferRoot, liveSessions: [['s1', sessionOf('s1', workspaceRoot, 1)]] })
    const initResponse = await callRoute(harness.routes, '/api/rfiles.upload.init', {
      method: 'POST', body: { sessionId: 's1', mode: 'workspace', name: 'empty.txt', size: 0 },
    })
    const { uploadId } = await jsonOf(initResponse)
    const finish = await callRoute(harness.routes, '/api/rfiles.upload.finish', { method: 'POST', body: { uploadId } })
    const finished = await jsonOf(finish)
    assert.equal(finish.status, 200)
    assert.equal(finished.path, '.uploads/empty.txt')
    assert.equal((await stat(path.join(workspaceRoot, '.uploads', 'empty.txt'))).size, 0)

    const download = await callRoute(harness.routes, '/api/rfiles.download', { query: { sessionId: 's1', path: '.uploads/empty.txt' } })
    assert.equal(download.status, 200)
    assert.equal(download.headers.get('content-length'), '0')
    assert.equal(await download.text(), '')
    // 空文件的 Range 一律 416
    const ranged = await callRoute(harness.routes, '/api/rfiles.download', {
      query: { sessionId: 's1', path: '.uploads/empty.txt' }, headers: { range: 'bytes=0-0' },
    })
    assert.equal(ranged.status, 416)
    assert.equal(ranged.headers.get('content-range'), 'bytes */0')
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
    await rm(transferRoot, { recursive: true, force: true })
  }
})

// ───────────────────────────── 下载 ─────────────────────────────

test('download：200 头完整；单段 Range 206；越界 416；逃逸 403', async () => {
  const workspaceRoot = await makeTempDir('rfiles-ws-')
  const transferRoot = await makeTempDir()
  try {
    const content = '0123456789abcdef'
    await writeFile(path.join(workspaceRoot, 'data.bin'), content)
    await mkdir(path.join(workspaceRoot, 'dir'))
    const harness = createHarness({ workspaceRoot, transferRoot, liveSessions: [['s1', sessionOf('s1', workspaceRoot, 1)]] })

    const full = await callRoute(harness.routes, '/api/rfiles.download', { query: { sessionId: 's1', path: 'data.bin' } })
    assert.equal(full.status, 200)
    assert.equal(full.headers.get('content-type'), 'application/octet-stream')
    assert.match(full.headers.get('content-disposition'), /^attachment; filename="data\.bin"/)
    assert.equal(full.headers.get('accept-ranges'), 'bytes')
    assert.equal(full.headers.get('content-length'), '16')
    assert.equal(await full.text(), content)

    const ranged = await callRoute(harness.routes, '/api/rfiles.download', {
      query: { sessionId: 's1', path: 'data.bin' }, headers: { range: 'bytes=4-7' },
    })
    assert.equal(ranged.status, 206)
    assert.equal(ranged.headers.get('content-range'), 'bytes 4-7/16')
    assert.equal(ranged.headers.get('content-length'), '4')
    assert.equal(await ranged.text(), '4567')

    const suffix = await callRoute(harness.routes, '/api/rfiles.download', {
      query: { sessionId: 's1', path: 'data.bin' }, headers: { range: 'bytes=-4' },
    })
    assert.equal(suffix.status, 206)
    assert.equal(suffix.headers.get('content-range'), 'bytes 12-15/16')
    assert.equal(await suffix.text(), 'cdef')

    const openEnded = await callRoute(harness.routes, '/api/rfiles.download', {
      query: { sessionId: 's1', path: 'data.bin' }, headers: { range: 'bytes=10-' },
    })
    assert.equal(openEnded.status, 206)
    assert.equal(await openEnded.text(), 'abcdef')

    const unsatisfiable = await callRoute(harness.routes, '/api/rfiles.download', {
      query: { sessionId: 's1', path: 'data.bin' }, headers: { range: 'bytes=99-' },
    })
    assert.equal(unsatisfiable.status, 416)
    assert.equal(unsatisfiable.headers.get('content-range'), 'bytes */16')

    const multi = await callRoute(harness.routes, '/api/rfiles.download', {
      query: { sessionId: 's1', path: 'data.bin' }, headers: { range: 'bytes=0-1,3-4' },
    })
    assert.equal(multi.status, 416)

    // 逃逸
    const escape = await callRoute(harness.routes, '/api/rfiles.download', { query: { sessionId: 's1', path: '../etc/passwd' } })
    assert.equal(escape.status, 403)
    // 目录
    const directory = await callRoute(harness.routes, '/api/rfiles.download', { query: { sessionId: 's1', path: 'dir' } })
    assert.equal(directory.status, 400)
    assert.equal((await jsonOf(directory)).error.code, 'is-directory')
    // 缺 path
    const noPath = await callRoute(harness.routes, '/api/rfiles.download', { query: { sessionId: 's1' } })
    assert.equal(noPath.status, 400)
    // 无 sessionId 时回落到 sandboxPolicy.workspaceRoot
    const fallback = await callRoute(harness.routes, '/api/rfiles.download', { query: { path: 'data.bin' } })
    assert.equal(fallback.status, 200)
    assert.equal(await fallback.text(), content)
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
    await rm(transferRoot, { recursive: true, force: true })
  }
})

// ───────────────────────────── 会话日志导出 ─────────────────────────────

test('export：转发官方 /api/session.export 并透传下载头', async () => {
  const workspaceRoot = await makeTempDir('rfiles-ws-')
  const transferRoot = await makeTempDir()
  const received = []
  const zipBytes = Buffer.from('PK\x03\x04fake-zip')
  const server = createServer((request, response) => {
    received.push({ url: request.url, cookie: request.headers.cookie, secFetchSite: request.headers['sec-fetch-site'] })
    response.writeHead(200, {
      'content-type': 'application/zip',
      'content-disposition': 'attachment; filename="dsh-session-test.zip"',
      'content-length': String(zipBytes.length),
    })
    response.end(zipBytes)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const harness = createHarness({ workspaceRoot, transferRoot, port })
    const response = await callRoute(harness.routes, '/api/rfiles.export', {
      query: { sessionId: 'session-1' },
      headers: { cookie: 'dsh_auth=example-cookie' },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/zip')
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="dsh-session-test.zip"')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), zipBytes)

    assert.equal(received.length, 1)
    assert.equal(received[0].url, '/api/session.export?sessionId=session-1&includeDescendants=true')
    assert.equal(received[0].cookie, 'dsh_auth=example-cookie')
    assert.equal(received[0].secFetchSite, 'same-origin')

    // 缺 sessionId → 400
    const missing = await callRoute(harness.routes, '/api/rfiles.export')
    assert.equal(missing.status, 400)
    assert.equal((await jsonOf(missing)).error.code, 'invalid-request')

    // webServer 未绑定端口 → 503
    const cold = createHarness({ workspaceRoot, transferRoot, port: 0 })
    const unavailable = await callRoute(cold.routes, '/api/rfiles.export', { query: { sessionId: 'session-1' } })
    assert.equal(unavailable.status, 503)
    assert.equal((await jsonOf(unavailable)).error.code, 'web-server-unavailable')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(workspaceRoot, { recursive: true, force: true })
    await rm(transferRoot, { recursive: true, force: true })
  }
})

// ───────────────────────────── index 注入 ─────────────────────────────

test('index 注入：global + script 两行，脚本已做 </script 转义', async () => {
  const workspaceRoot = await makeTempDir('rfiles-ws-')
  const transferRoot = await makeTempDir()
  try {
    const harness = createHarness({ workspaceRoot, transferRoot })
    const listeners = harness.listeners.get('webserver/index-inject') ?? []
    assert.equal(listeners.length, 1)

    const table = []
    listeners[0](table)
    assert.equal(table.length, 2)

    const globalRow = table.find((row) => row.kind === 'global')
    assert.deepEqual(globalRow, { kind: 'global', name: '__DSH_RFILES__', value: { version: '1' } })

    const scriptRow = table.find((row) => row.kind === 'script')
    assert.equal(scriptRow.placement, 'head')
    assert.equal(typeof scriptRow.text, 'string')
    // 用字符串查找而不是正则，避免本文件自身出现 </script 字面量。
    assert.equal(scriptRow.text.includes('</' + 'script'), false, '内联脚本不能包含裸 </script')
    assert.ok(!scriptRow.text.includes('<!--'), '内联脚本不能包含裸 <!--')

    // 全部契约路由都已注册
    const expectedPaths = [
      '/api/rfiles.health',
      '/api/rfiles.config',
      '/api/rfiles.sessions',
      '/api/rfiles.list',
      '/api/rfiles.upload.init',
      '/api/rfiles.upload.chunk',
      '/api/rfiles.upload.finish',
      '/api/rfiles.upload.cancel',
      '/api/rfiles.send',
      '/api/rfiles.download',
      '/api/rfiles.export',
    ]
    assert.deepEqual([...harness.routes.keys()].sort(), [...expectedPaths].sort())
    assert.deepEqual(harness.routes.get('/api/rfiles.upload.chunk').methods, ['PUT'])
    assert.deepEqual(harness.routes.get('/api/rfiles.download').methods, ['GET'])
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
    await rm(transferRoot, { recursive: true, force: true })
  }
})

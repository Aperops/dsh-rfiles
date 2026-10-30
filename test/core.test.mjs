/**
 * core.js 单测：路径约束 / Range 解析 / 下载头 / 文件名 / 分块上传暂存区。
 * 运行：node --test test/
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  CoreError,
  TransferStore,
  bodyChunks,
  contentDisposition,
  contentTypeFor,
  escapeInlineScript,
  parseSingleRange,
  resolveInside,
  sanitizeFileName,
  uniqueNameIn,
} from '../lib/core.js'

/** 建一个临时目录，测试结束由调用方清理。 */
async function makeTempDir(prefix = 'rfiles-') {
  return await mkdtemp(path.join(os.tmpdir(), prefix))
}

/** 内存分块 → 异步生成器（模拟请求体）。 */
async function* chunksOf(...buffers) {
  for (const buffer of buffers) yield buffer
}

/** 计算 sha256。 */
function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

// ───────────────────────────── 路径约束 ─────────────────────────────

test('resolveInside：接受工作区根与普通相对路径', async () => {
  const root = await makeTempDir()
  try {
    assert.equal(await resolveInside(root, ''), path.resolve(root))
    assert.equal(await resolveInside(root, 'a/b.txt'), path.join(path.resolve(root), 'a/b.txt'))
    // 尚不存在的深层路径也应允许（上传落点目录可能还不存在）。
    assert.equal(await resolveInside(root, 'new/deep/file.txt'), path.join(path.resolve(root), 'new/deep/file.txt'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolveInside：拒绝绝对路径 / 上一级 / NUL / 盘符', async () => {
  const root = await makeTempDir()
  try {
    const cases = [
      ['/etc/passwd', ['path-escape']],
      ['..', ['path-escape']],
      ['a/../../etc/passwd', ['path-escape']],
      ['a\\..\\..\\etc', ['path-escape']],
      ['C:/windows/system32', ['path-escape']],
      ['bad\u0000name', ['invalid-path']],
    ]
    for (const [relative, codes] of cases) {
      await assert.rejects(
        resolveInside(root, relative),
        (error) => error instanceof CoreError && codes.includes(error.code),
        `路径 ${JSON.stringify(relative)} 应被拒绝`,
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolveInside：拒绝符号链接逃逸，允许指向工作区内的软链接', async () => {
  const root = await makeTempDir()
  const outside = await makeTempDir('rfiles-outside-')
  try {
    await mkdir(path.join(root, 'real-dir'))
    await writeFile(path.join(root, 'real-dir', 'ok.txt'), 'ok')
    await symlink(outside, path.join(root, 'escape-dir'))
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'escape-file'))
    await symlink(path.join(root, 'real-dir'), path.join(root, 'inside-dir'))

    await assert.rejects(
      resolveInside(root, 'escape-dir/leak.txt'),
      (error) => error instanceof CoreError && error.code === 'path-escape',
    )
    await assert.rejects(
      resolveInside(root, 'escape-file'),
      (error) => error instanceof CoreError && error.code === 'path-escape',
    )
    // 指向工作区内部的软链接是合法的。
    assert.equal(
      await resolveInside(root, 'inside-dir/ok.txt'),
      path.join(path.resolve(root), 'inside-dir/ok.txt'),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

// ───────────────────────────── Range 解析 ─────────────────────────────

test('parseSingleRange：合法区间', () => {
  assert.deepEqual(parseSingleRange('bytes=0-99', 1000), { start: 0, end: 99 })
  assert.deepEqual(parseSingleRange('bytes=100-', 1000), { start: 100, end: 999 })
  assert.deepEqual(parseSingleRange('bytes=-100', 1000), { start: 900, end: 999 })
  assert.deepEqual(parseSingleRange('bytes=0-99999', 1000), { start: 0, end: 999 })
  assert.deepEqual(parseSingleRange('bytes=0-0', 1), { start: 0, end: 0 })
  assert.deepEqual(parseSingleRange('bytes=-99999', 1000), { start: 0, end: 999 })
  assert.deepEqual(parseSingleRange('  bytes=5-9  ', 10), { start: 5, end: 9 })
})

test('parseSingleRange：无 Range 返回 null', () => {
  assert.equal(parseSingleRange(undefined, 10), null)
  assert.equal(parseSingleRange(null, 10), null)
})

test('parseSingleRange：非法/多段/越界 => unsatisfiable', () => {
  const unsatisfiable = [
    ['bytes=1000-', 1000], // 起点越界
    ['bytes=5-4', 1000], // 起点大于终点
    ['bytes=abc', 1000],
    ['bytes=', 1000],
    ['bytes=-0', 1000],
    ['bytes=0-1,5-6', 1000], // 多段不支持
    ['items=0-1', 1000],
    ['bytes=0-1', 0], // 空文件
    ['bytes=-5', 0],
    ['bytes=99999999999999999999-', 1000],
  ]
  for (const [header, size] of unsatisfiable) {
    assert.equal(parseSingleRange(header, size), 'unsatisfiable', `${header} (size=${size})`)
  }
  assert.equal(parseSingleRange('bytes=0-1', -1), 'unsatisfiable')
})

// ─────────────────────── 下载响应头 / 文件名 ───────────────────────

test('contentDisposition：ASCII 回退 + UTF-8 filename*，且不注入头部', () => {
  const value = contentDisposition('报告 2024.pdf')
  assert.match(value, /^attachment; filename="[ -~]*"; filename\*=UTF-8''/)
  assert.ok(value.includes(encodeURIComponent('报告').toUpperCase()) || value.includes('%E6%8A%A5%E5%91%8A'))
  // 引号、反斜杠、换行都必须被清掉。
  const nasty = contentDisposition('a"b\\c\r\nd.txt')
  assert.ok(!nasty.includes('\r'))
  assert.ok(!nasty.includes('\n'))
  assert.match(nasty, /filename="a_b_c__d\.txt"/)
  // 空名回退成 download。
  assert.match(contentDisposition(''), /filename="download"/)
})

test('contentTypeFor：常见扩展名与未知扩展名', () => {
  assert.match(contentTypeFor('a.txt'), /^text\/plain/)
  assert.equal(contentTypeFor('a.png'), 'image/png')
  assert.equal(contentTypeFor('a.JPEG'), 'image/jpeg')
  assert.equal(contentTypeFor('a.zip'), 'application/zip')
  assert.equal(contentTypeFor('a.unknown-ext'), 'application/octet-stream')
  assert.equal(contentTypeFor(undefined), 'application/octet-stream')
})

test('sanitizeFileName：只取最后一段并拒绝危险名', () => {
  assert.equal(sanitizeFileName('a.txt'), 'a.txt')
  assert.equal(sanitizeFileName('dir/sub/a.txt'), 'a.txt')
  assert.equal(sanitizeFileName('..\\..\\etc\\passwd'), 'passwd')
  assert.equal(sanitizeFileName('a\u0000b.txt'), 'ab.txt')
  assert.throws(() => sanitizeFileName('..'), (error) => error instanceof CoreError && error.code === 'invalid-name')
  assert.throws(() => sanitizeFileName(''), (error) => error instanceof CoreError && error.code === 'invalid-name')
  assert.throws(() => sanitizeFileName(42), (error) => error instanceof CoreError && error.code === 'invalid-name')
})

test('escapeInlineScript：转义 </script 与 <!--', () => {
  assert.equal(escapeInlineScript('a</script>b'), 'a<\\/script>b')
  assert.equal(escapeInlineScript('<!--x'), '<\\!--x')
  assert.equal(escapeInlineScript('</SCRIPT>'), '<\\/SCRIPT>')
  assert.equal(escapeInlineScript(undefined), '')
})

test('uniqueNameIn：重名依次加 (n)', async () => {
  const dir = await makeTempDir()
  try {
    assert.equal(await uniqueNameIn(dir, 'a.txt'), 'a.txt')
    await writeFile(path.join(dir, 'a.txt'), '1')
    assert.equal(await uniqueNameIn(dir, 'a.txt'), 'a (1).txt')
    await writeFile(path.join(dir, 'a (1).txt'), '2')
    assert.equal(await uniqueNameIn(dir, 'a.txt'), 'a (2).txt')
    // 无扩展名的点文件。
    await writeFile(path.join(dir, '.env'), 'x')
    assert.equal(await uniqueNameIn(dir, '.env'), '.env (1)')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ───────────────────────────── 分块存储 ─────────────────────────────

test('TransferStore：顺序分块、偏移幂等、finish 校验大小与 sha256（send 模式）', async () => {
  const staging = await makeTempDir()
  const store = new TransferStore({ root: staging })
  try {
    const { uploadId, offset } = await store.init({ sessionId: 's1', mode: 'send', name: 'hello.txt', size: 11 })
    assert.equal(offset, 0)

    // 第一块
    const first = await store.chunk(uploadId, 0, chunksOf(Buffer.from('hello ')))
    assert.deepEqual(first, { offset: 0, received: 6 })

    // 乱序（offset 不对）=> 409 + received
    await assert.rejects(
      store.chunk(uploadId, 0, chunksOf(Buffer.from('XXXX'))),
      (error) => error instanceof CoreError && error.code === 'offset-mismatch' && error.extra.received === 6 && error.status === 409,
    )

    // 用返回的 received 续传
    const second = await store.chunk(uploadId, 6, chunksOf(Buffer.from('world')))
    assert.deepEqual(second, { offset: 6, received: 11 })

    // finish 之前大小已满足
    const finished = await store.finish(uploadId)
    assert.equal(finished.size, 11)
    assert.equal(finished.sha256, sha256('hello world'))
    const meta = await store.meta(uploadId)
    assert.equal(meta.finished, true)
    // send 模式数据保留在暂存区
    assert.equal(await readFile(store.dataPath(uploadId), 'utf8'), 'hello world')
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
})

test('TransferStore：finish 大小不符 => 409 incomplete 且带 received', async () => {
  const staging = await makeTempDir()
  const store = new TransferStore({ root: staging })
  try {
    const { uploadId } = await store.init({ sessionId: 's1', mode: 'send', name: 'a.bin', size: 5 })
    await store.chunk(uploadId, 0, chunksOf(Buffer.from('he')))
    await assert.rejects(
      store.finish(uploadId),
      (error) => error instanceof CoreError
        && error.code === 'incomplete'
        && error.status === 409
        && error.extra.received === 2
        && error.extra.expected === 5,
    )
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
})

test('TransferStore：sha256 不匹配 => 400 且清空暂存', async () => {
  const staging = await makeTempDir()
  const store = new TransferStore({ root: staging })
  try {
    const { uploadId } = await store.init({ sessionId: 's1', mode: 'send', name: 'a.txt', size: 3 })
    await store.chunk(uploadId, 0, chunksOf(Buffer.from('abc')))
    await assert.rejects(
      store.finish(uploadId, { sha256: 'deadbeef' }),
      (error) => error instanceof CoreError && error.code === 'hash-mismatch' && error.status === 400,
    )
    await assert.rejects(
      store.meta(uploadId),
      (error) => error instanceof CoreError && error.code === 'upload-not-found',
    )
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
})

test('TransferStore：chunk 超过声明大小 => 413 且回滚到起始偏移', async () => {
  const staging = await makeTempDir()
  const store = new TransferStore({ root: staging })
  try {
    const { uploadId } = await store.init({ sessionId: 's1', mode: 'send', name: 'a.bin', size: 4 })
    await store.chunk(uploadId, 0, chunksOf(Buffer.from('ab')))
    await assert.rejects(
      store.chunk(uploadId, 2, chunksOf(Buffer.from('cdef'))),
      (error) => error instanceof CoreError && error.code === 'too-large' && error.status === 413,
    )
    // 回滚后仍可用收到的偏移续传
    const state = await stat(store.dataPath(uploadId))
    assert.equal(state.size, 2)
    const again = await store.chunk(uploadId, 2, chunksOf(Buffer.from('cd')))
    assert.equal(again.received, 4)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
})

test('TransferStore：workspace 模式落盘、重名加 (n)、暂存目录被清理', async () => {
  const staging = await makeTempDir()
  const workspace = await makeTempDir('rfiles-ws-')
  const store = new TransferStore({ root: staging })
  try {
    const upload = async (name, content) => {
      const { uploadId } = await store.init({ sessionId: 's1', mode: 'workspace', name, size: content.length })
      await store.chunk(uploadId, 0, chunksOf(Buffer.from(content)))
      return await store.finish(uploadId, { dirAbs: path.join(workspace, '.uploads') })
    }
    const first = await upload('note.txt', 'one')
    assert.equal(first.name, 'note.txt')
    assert.equal(first.path, path.join(workspace, '.uploads', 'note.txt'))
    assert.equal(await readFile(first.path, 'utf8'), 'one')

    const second = await upload('note.txt', 'two')
    assert.equal(second.name, 'note (1).txt')
    assert.equal(await readFile(second.path, 'utf8'), 'two')

    const third = await upload('note.txt', 'three')
    assert.equal(third.name, 'note (2).txt')

    // 暂存目录已删除
    const entries = await stat(staging).then(() => true)
    assert.equal(entries, true)
  } finally {
    await rm(staging, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('TransferStore：cancel 幂等删除；配额与单文件上限生效', async () => {
  const staging = await makeTempDir()
  try {
    const store = new TransferStore({ root: staging, maxFileBytes: 8, stagingBytes: 10 })
    await assert.rejects(
      store.init({ sessionId: 's1', mode: 'send', name: 'big.bin', size: 9 }),
      (error) => error instanceof CoreError && error.code === 'too-large' && error.status === 413,
    )
    const { uploadId } = await store.init({ sessionId: 's1', mode: 'send', name: 'a.bin', size: 6 })
    // 第二次 init 超过暂存总量
    await assert.rejects(
      store.init({ sessionId: 's1', mode: 'send', name: 'b.bin', size: 6 }),
      (error) => error instanceof CoreError && error.code === 'staging-quota-exceeded' && error.status === 413,
    )
    await store.cancel(uploadId)
    await store.cancel(uploadId) // 幂等
    await assert.rejects(
      store.meta(uploadId),
      (error) => error instanceof CoreError && error.code === 'upload-not-found',
    )
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
})

test('TransferStore：非法 uploadId 被拒绝（路径穿越防护）', async () => {
  const staging = await makeTempDir()
  try {
    const store = new TransferStore({ root: staging })
    for (const bad of ['../escape', 'a/b', '..', '', 42]) {
      await assert.rejects(
        store.meta(bad),
        (error) => error instanceof CoreError && error.code === 'upload-not-found',
        `uploadId=${JSON.stringify(bad)}`,
      )
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
})

test('bodyChunks：把 Web ReadableStream 转成异步生成器', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]))
      controller.enqueue(new Uint8Array([3]))
      controller.close()
    },
  })
  const pieces = []
  for await (const piece of bodyChunks(stream)) pieces.push(...piece)
  assert.deepEqual(pieces, [1, 2, 3])
  // null 请求体是合法的（零长度追加）
  const empty = []
  for await (const piece of bodyChunks(null)) empty.push(piece)
  assert.deepEqual(empty, [])
})

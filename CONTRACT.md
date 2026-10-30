# dsh-rfiles 接口契约（v1）

> 定位：**伴生插件**（profile-local），不修改 `@linxin666/dsh-remote-web-ui`，不修改 DSH 核心。
> 目标：手机浏览器（以及远程电脑）能①把文件/图片发给 Agent，②把工作区/产出文件下载到本机。
> 原理：客户端 `fetch` 对 `/api/*` 的调用会被远程插件自动改写为 `/remote/api/*`（带配对凭据）；**锚点导航不会被改写**，所以下载链接在远程页必须显式加 `/remote` 前缀。

## 0. 包布局

```
packages/dsh-rfiles/
  package.json          # name: dsh-rfiles, private, type: module, main: lib/index.js
  lib/index.js          # Cordis 插件：name/inject/apply；注册路由 + 注入客户端脚本
  lib/core.js           # 可单测的纯逻辑：路径约束、Range 解析、分块存储、zip/tar 辅助
  lib/client.js         # 浏览器 IIFE 小部件源码（vanilla JS/CSS，无外部依赖）
  test/*.test.mjs       # node:test 单测（mock ctx，真实临时目录）
  scripts/mock-server.mjs  # 契约模拟服务器（客户端 UI 联调用）
  README.md
```

## 1. 宿主路由（全部注册在 `/api/rfiles.*`，由 Connection 的 exact Fetch route 提供鉴权）

所有响应：成功 `2xx`，失败 `{ ok:false, error:{ code, message } }` + 合适状态码（400/403/404/409/413/500）。

| 路由 | 方法 | body | 说明 |
|---|---|---|---|
| `/api/rfiles.health` | GET | – | `{ ok:true, version:"1", workspaceRoot }`（仅诊断） |
| `/api/rfiles.config?sessionId=` | GET | – | `{ ok:true, workspaceRoot, limits:{chunkBytes, maxFileBytes} }`；sessionId 缺省时只回 limits |
| `/api/rfiles.sessions` | GET | – | `{ ok:true, sessions:[{id, cwd, title?}] }`（`ctx.sessions.list()`，去掉无 cwd 的；按创建序，客户端默认取最后一个）；列表为空时 `sessions:[]` |
| `/api/rfiles.list?sessionId=&path=` | GET | – | `{ ok:true, path, entries:[{name, kind:"file"|"dir", size, mtime}] }`；path 相对 workspace，空=根；不递归，按 dir 优先/名称排序；最多 500 项 |
| `/api/rfiles.upload.init` | POST | JSON `{sessionId, mode:"workspace"|"send", dir?, name, size}` | `{ ok:true, uploadId, offset:0 }`；重名文件在 workspace 模式自动加 ` (n)` |
| `/api/rfiles.upload.chunk?uploadId=&offset=` | PUT | 原始字节（`application/octet-stream`） | `{ ok:true, offset, received }`；`offset` 必须等于当前 received，否则 409 `{ ok:false, error:{ code:"offset-mismatch", received } }`（客户端据此续传） |
| `/api/rfiles.upload.finish` | POST | JSON `{uploadId}` | `{ ok:true, mode, path? , uploadId, name, size, mime }`；workspace 模式已完成移动；send 模式文件仍在暂存区等待发送 |
| `/api/rfiles.upload.cancel` | POST | JSON `{uploadId}` | `{ ok:true }`；删除暂存 |
| `/api/rfiles.send` | POST | JSON `{sessionId, uploadIds:[...], text?}` | 把暂存文件作为**真实附件**发送给 Agent：`{ ok:true, sent:[names] }`。图片（png/jpeg/webp/gif 且 ≤20MB）走 image 附件；其余走 file 附件；随后触发一次 prompt。 |
| `/api/rfiles.download?sessionId=&path=` | GET | – | 文件字节。响应头：`Content-Type`、`Content-Length`、`Content-Disposition: attachment; filename*=UTF-8''...`、`Accept-Ranges: bytes`；支持单段 `Range: bytes=a-b` → `206` + `Content-Range`；非法 Range → `416`。路径相对 workspace，禁止逃逸。 |
| `/api/rfiles.export?sessionId=` | GET | – | 便捷下载：代理转发 `/api/session.export?sessionId=&includeDescendants=true` 的响应（也可客户端直接拼链接；本路由确保 Content-Disposition） |

### 1.1 鉴权与可见性

- 全部走 `ctx.connection.fetch.register`：桌面 owner 浏览器直接访问 `/api/...`；远程经 `/remote/api/...`（配对门 + 内层 owner 凭据）。**不额外造鉴权**。
- 路径约束：`resolveInside(workspaceRoot, relativePath)`，拒绝绝对路径、`..`、NUL、符号链接逃逸（`realpath` 校验）；只允许 workspace 内。
- 上传写盘：`<DSH_HOME>/rfile-transfers/<uploadId>/`（暂存）+ `<workspace>/<dir>/<name>`（workspace 模式最终落点，默认 dir 为 `.uploads`）。
- 配额：单文件默认 ≤ 2 GiB，分块默认 8 MiB，暂存总量 ≤ 10 GiB（可配置，超限 413）。

## 2. 发送给 Agent 的实现（宿主侧，复用官方收据机制）

```js
// 1) 暂存文件 -> 官方 staged receipt（自动处理冷会话恢复）
const { receiptId } = await ctx.fileUploads.uploadStream({ sessionId, data: fs.createReadStream(tmpPath), name })
// 2) 组 prompt content
content = [ { type:"text", text }, { type:"file", receiptId } ]           // 普通文件
content = [ { type:"text", text }, { type:"image", data: base64, mediaType } ] // 图片（≤20MB，走官方图片准入）
// 3) 提交（与官方 composer 同一条路径）
await ctx.sessionController.prompt({ sessionId, requestId: randomUUID(), content, mode:"queue" }, signal)
```

- 失败时把已暂存的 receipt 丢弃（不绑定 prompt 即自然失效）。
- `sessionController.prompt` 会把 receipt 换成 durable attachment 并 append `user/message`。
- 图片是否被接受取决于模型 `inputModalities`；不支持时透传官方错误文案。

## 3. 客户端小部件契约（注入到官方 index `/api` 同源页面）

- 注入方式：`webserver/index-inject` 追加 `{ kind:"script", placement:"head", text:<lib/client.js 内容> }`；脚本自执行，DOM 就绪后挂一个右下角浮动按钮（图标 + “文件”），点击打开底部抽屉/面板。注入时只烘入 `{ remote:<是否非回环离开>, version }`，**不注入 sessionId**（index 是所有会话共享的）。
- 远程判定：**运行时** `const remote = typeof window.__DSH_REMOTE_CHANNEL_BOOT__ !== "undefined"`（只有第三方配对通道的 boot 补丁会发布这个全局；loopback 与无该插件的部署都没有）。下载链接 `href = (remote ? "/remote" : "") + "/api/rfiles.download?..."`；其余请求一律 `fetch("/api/rfiles...")`（远程会被 boot patch 自动改写）。
- 上传：`input[type=file][multiple]` + 第二个 `input[capture=environment][accept=image/*]` 用于拍照；`File.slice` 按 8 MiB 顺序 PUT；进度按 chunk 累计；失败/刷新后按 `uploadId+offset` 续传（localStorage key = `${sessionId}:${name}:${size}:${lastModified}`）。
- 发送：输入框可填文字；默认“发送给 Agent”，可切换“只存入工作区”。
- 下载：面包屑 + 目录列表；文件行显示大小；点击用 `<a download>` 原生下载（远程带 `/remote` 前缀；无 cookie 场景降级 fetch+blob 保存）。顶部提供“下载会话日志 ZIP”。
- 会话选择：面板打开时请求 `GET /api/rfiles.sessions`，默认选中列表最后一个（最近创建）；提供下拉切换。列表为空时显示“请先在 GUI 里打开一个会话”。所有后续请求带选中的 `sessionId`。
- 样式：不依赖官方 class；`position:fixed; right:16px; bottom:calc(16px + env(safe-area-inset-bottom))`；z-index 2147483000；移动端抽屉全宽、≥44px 触控目标、16px 输入防缩放。

## 4. 单测 / 联调

- `node --test test/`：路径约束（含逃逸/符号链接）、Range 解析（合法/非法/开区间/超界）、分块存储（乱序 409、续传 offset、finish 后大小/哈希）、workspace 重名处理、下载响应头。
- `node scripts/mock-server.mjs --port 4399`：内存实现同一契约（上传/下载/list/send 返回假成功），供客户端在普通浏览器里联调（挂 `mock.html` 注入 client.js，localStorage 与 fetch 全部走 mock）。

## 5. 安装与验证（用户重启 DSH 后生效）

1. 把 `packages/dsh-rfiles` 复制/软链到 `~/.dsh/profiles/desktop/node_modules/dsh-rfiles`（先备份 `cordis.patch.yml`）。
2. 在 `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾追加：
   ```yaml
   - insert:
       - id: rfiles
         name: 'dsh-rfiles'
   ```
3. 重启 DSH 桌面端，打开任意会话，右下角出现「文件」按钮。
4. 验证脚本 `scripts/verify.sh`：用配对设备凭据 curl `/remote/api/rfiles.health`、上传/下载/Range 全链路检查。

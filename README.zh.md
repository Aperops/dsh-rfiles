# dsh-rfiles：DSH 远程文件传输伴生插件

> **一句话**：不改第三方远程插件、不改 DSH 核心，给手机 / 远程电脑上的 DSH Web GUI 补上「把文件发给 Agent」和「把工作区文件下载到本机」。
>
> 形态：DSH bundle 插件（Host 半区 + 注入的 vanilla JS 小部件），无构建步骤、无运行时依赖。
> 接口契约见 [CONTRACT.md](./CONTRACT.md)；英文文档见 [README.md](./README.md)。

---

## 1. 问题背景：远程页上的文件传输为什么是坏的

用户通过第三方插件 @linxin666/dsh-remote-web-ui 的**配对页**（/pair-app）从手机或另一台电脑访问
DSH Web GUI。该插件用一段解析期 boot 脚本把页面里的「程序化请求」改写到 /remote 前缀：

| 被改写的载体 | 是否改写 | 说明 |
| --- | --- | --- |
| fetch | ✅ | /api/*、/sidebar/*、/git/*、/pet/* → /remote/...，并附带设备凭据 |
| WebSocket / EventSource | ✅ | 精确白名单 |
| img / script / iframe 的 src | ✅ | 子资源 |
| **a[download] 锚点导航、window.open、location 跳转、form 提交、XHR** | ❌ | 下载正是这一类 |

由此产生三个用户可见的缺陷：

1. **官方上传失败 / 没有进度**：官方上传优先使用 Web Worker 里的 XHR（在通道外），只有靠官方预留的
   __DSH_FILE_UPLOAD__ 钩子才勉强接回通道；而钩子载体不接收 onProgress，所以大文件在手机上就是黑盒等待。
2. **没有下载入口**：手机适配层直接隐藏了 Session 头工具区（原注释：no space on phones）；电脑远程虽然看得到
   「下载 Session 日志」，但它是一次 <a download> 导航，URL 没有 /remote 前缀，被 DSH 的 /api 围栏挡掉，
   返回 401/403 纯文本——UI 却在点击后立刻提示「下载已开始」。
3. **Range 被代理丢弃**：代理的请求头白名单只放行 host/sec-fetch-site/content-type/content-length/accept/cookie，
   响应头只放行 content-type/content-length/content-disposition/cache-control/etag/last-modified；
   Range、If-Range、Content-Range、Accept-Ranges 全部丢弃。所以远程页做不到断点续传、视频拖动。

**本插件的思路（不碰上游、不碰核心）**：

- 上传：自己用 fetch + File.slice 分块 PUT（每块 8 MiB），进度自己算、按 offset 续传，绕开官方 Worker 载体；
  上传完成后由宿主侧调用官方 fileUploads 收据 + sessionController.prompt，把文件作为**真实附件**发给 Agent。
- 下载：自建 /api/rfiles.download exact 路由（Content-Length / Content-Disposition / 单段 Range），
  客户端用**原生 <a download>**；远程页给 href **显式加 /remote 前缀**。
  这一步是关键：**锚点不被改写是问题，也恰好是解法**——只要 URL 自带 /remote，配对 cookie 就足以通过
  远程门，内层再由插件用进程凭据回环取字节，Content-Disposition 被代理透传，浏览器就会正常落盘。
- 会话日志 ZIP：/api/rfiles.export 转发官方 /api/session.export（includeDescendants=true），并补上下载头。
- 鉴权：完全不新增。路由注册在 Connection 的 exact Fetch route 上，桌面直接走 owner 鉴权；远程必须
  先过 /remote 的配对门，再由代理用进程自己的 browser-auth cookie 回环请求 /api。

---

## 2. 能力一览

| 能力 | 说明 |
| --- | --- |
| 发送文件给 Agent | 多选任意类型文件；分块上传带进度；完成后可附一段文字，点「发送给 Agent」 |
| 拍照 / 相册 | 「拍照 / 相册」按钮（input accept=image/* capture=environment），图片 ≤ 20 MiB 走官方图片附件 |
| 只存入工作区 | 切换「只存入工作区」，文件落到 `<workspace>/.uploads/`（同名自动改名为 `name (n).ext`），不发给 Agent |
| 下载工作区文件 | 面包屑 + 目录列表（每层最多 500 项），点文件用浏览器原生下载；⤓ 按钮为 fetch+blob 兜底 |
| 下载会话日志 ZIP | 下载 tab 顶部「下载会话日志 ZIP」，含子会话与附件对象 |
| 进度 / 取消 / 续传 | 按块显示已传/总量；可取消；断网或刷新后 24 小时内重新选择同一文件可续传（localStorage 记录 uploadId+offset） |
| 会话切换 | 面板顶部下拉选择会话（只列**活跃**会话，默认选最新）；旁边「远程」徽标表示当前走 /remote 通道 |
| 桌面与远程通用 | 桌面直连时下载走 /api（原生 Range 206 可用）；远程自动加 /remote 前缀 |

大小与配额（默认，均可在配置里调）：

- 单文件 ≤ **2 GiB**，暂存区总量 ≤ **10 GiB**，单块 **8 MiB**；超限返回 413。
- 上传暂存目录：`$DSH_HOME/rfile-transfers/<uploadId>/{meta.json,data.bin}`（进程重启后可续传，不被 DSH 清理）。
- 会话日志 ZIP 走官方导出，可能较大；远程代理会以流式转发。

---

## 3. 文件与接口

包布局：

仓库根就是 npm 包根：

```
dsh-rfiles/
  package.json          # dsh.bundle.patch 指向 cordis.patch.yml；main: lib/index.js
  cordis.patch.yml      # bundle 层：insert id: rfiles 挂载行
  lib/index.js          # Cordis 插件：name/inject/apply；注册路由 + 注入客户端脚本
  lib/core.js           # 纯逻辑：路径约束、Range 解析、下载头、分块存储（可单测）
  lib/client.js         # 浏览器小部件（classic script，IIFE，无构建、无依赖）
  test/core.test.mjs    # node:test 单测
  test/routes.test.mjs  # 路由级单测
  scripts/mock-server.mjs  # 契约 mock（客户端 UI 联调）
  scripts/mock.html        # mock 页面（挂载 client.js）
  scripts/install.sh       # 源码目录安装脚本（profile-local，开发用）
  scripts/verify.sh        # 连通性验证脚本
  CONTRACT.md              # 接口契约（只读，不得擅改；不在 npm tarball 内）
  README.md / README.zh.md # 英文 / 中文文档
  LICENSE, assets/icon.png # MIT 许可与图标
```

Host 路由（全部是 /api/rfiles.* 的 Connection exact Fetch route；远程页等价路径为 /remote/api/rfiles.*）：

| 路由 | 方法 | 用途 |
| --- | --- | --- |
| /api/rfiles.health | GET | 诊断：`{ok, version, workspaceRoot}` |
| /api/rfiles.config?sessionId= | GET | 配额：`{ok, workspaceRoot, limits:{chunkBytes,maxFileBytes}}` |
| /api/rfiles.sessions | GET | 客户端会话下拉：只列**活跃**会话（id/cwd/title） |
| /api/rfiles.list?sessionId=&path= | GET | 列目录（不递归、dir 优先、≤500 项） |
| /api/rfiles.upload.init | POST | `{sessionId, mode:"workspace" 或 "send", name, size}` → uploadId/offset |
| /api/rfiles.upload.chunk?uploadId=&offset= | PUT | 原始字节；offset 必须等于已收字节，否则 409 `{received}` |
| /api/rfiles.upload.finish | POST | `{uploadId}`；workspace 模式原子移动到 `.uploads/`，send 模式保留暂存 |
| /api/rfiles.upload.cancel | POST | 删除暂存 |
| /api/rfiles.send | POST | `{sessionId, uploadIds, text?}` → 官方收据附件 + 触发 prompt |
| /api/rfiles.download?sessionId=&path= | GET | 文件字节；Content-Disposition + Accept-Ranges；单段 Range → 206/416 |
| /api/rfiles.export?sessionId= | GET | 转发官方会话日志 ZIP |

可选配置（写在 profile 的 `cordis.patch.yml` 里，按 id 覆盖 bundle 插入的挂载行）：

```yaml
- id: rfiles
  config:
    chunkBytes: 8388608          # 分块大小（默认 8 MiB）
    maxFileBytes: 2147483648     # 单文件上限（默认 2 GiB）
    stagingBytes: 10737418240    # 暂存总量上限（默认 10 GiB）
    uploadDir: .uploads          # workspace 模式默认落点
    transferRoot: ''             # 暂存根（默认 $DSH_HOME/rfile-transfers）
```

---

## 4. 安装

### 4.1 前置条件

- 已安装 DSH 桌面端，并至少启动过一次（存在 `$DSH_HOME/profiles/desktop`；DSH_HOME 默认 `~/.dsh`）。
- 远程访问场景需要 @linxin666/dsh-remote-web-ui 正常工作、设备已配对（本插件不依赖它，桌面直连也能用）。
- Node 由 DSH 自带，不需要额外安装依赖（插件只用 Node 内置模块）。

本包是 DSH **bundle**：`package.json` 声明 `dsh.bundle.patch` 并附带 `cordis.patch.yml`，
安装包即注册 profile 层（`insert` 一行 `id: rfiles`）。下面三种方式任选其一。

### 4.2 从 DSH Web GUI 安装（推荐）

1. 打开 **设置 → 插件**（Plugins 页面）；
2. 安装 `dsh-rfiles`，确认新 bundle 处于启用状态（安装 bundle 默认启用）；
3. 若页面提示需要重启，完全退出并重新打开 DSH；
4. 打开任意会话，页面右下角出现「文件」按钮即成功。

> 远程场景仍需 @linxin666/dsh-remote-web-ui 正常工作且设备已配对；桌面直连无需它。

### 4.3 用 CLI 安装

```bash
dsh plugin --profile web add dsh-rfiles

# 从 git 或本地 tarball（npm pack 产物）安装也可以：
dsh plugin --profile web add git+https://github.com/Aperops/dsh-rfiles.git
dsh plugin --profile web add /path/to/dsh-rfiles-0.1.0.tgz
```

装完检查两处：

1. profile 的 `package.json` 的 `dsh.profile.bundles` 里应有 `"dsh-rfiles"`；若没有（部分
   CLI 版本只装依赖、不改 bundle 列表），手动追加后重启 DSH：
   ```jsonc
   "dsh": {
     "profile": {
       "bundles": [
         "@deepseek-ai/dsh-base",
         "@deepseek-ai/dsh-web-app",
         "dsh-rfiles"
       ]
     }
   }
   ```
2. 组合树里应出现 `rfiles` 行：
   ```bash
   dsh --profile web --dump-config | grep -A2 rfiles
   ```

然后完全退出并重新打开 DSH（或重启 `dsh web`），打开任意会话确认右下角「文件」按钮。

### 4.4 从源码目录安装（开发用）

适合在本仓库里改代码、立即生效：

```bash
cd dsh-rfiles

# 1) 先看脚本会做什么（不改任何文件）
bash scripts/install.sh --dry-run

# 2) 真正安装：备份 cordis.patch.yml → 建软链 → 追加 insert 挂载行
bash scripts/install.sh

# 3) 完全退出并重新打开 DSH 桌面端（或重启 dsh web 服务）
#    注意：重启会中断正在运行的会话/任务，请挑空闲时间操作
```

脚本做什么、不做什么：

- ✅ 检查 profile 与插件源码；备份 `cordis.patch.yml` 为 `cordis.patch.yml.bak.<时间戳>`；
- ✅ 创建软链 `<profile>/node_modules/dsh-rfiles -> 本包目录`；在 patch 末尾幂等追加
  `insert: id: rfiles` 挂载行（与 bundle 层等价，但不需要 pnpm）；
- ❌ 不重启 DSH、不修改 patch 以外任何配置、不改 profile 的 package.json、不复制文件。
- 幂等：重复执行不会重复写行/重复备份；软链已存在且指向本包时直接跳过。
- 其他 profile：`bash scripts/install.sh --profile desktop`（或 `RFILES_PROFILE=...`）；
  DSH_HOME 不在默认位置时：`DSH_HOME=/path/to/.dsh bash scripts/install.sh`。

### 4.5 升级与卸载

- 升级（bundle 安装）：`dsh plugin --profile web add dsh-rfiles@latest`，然后重启 DSH。
- 升级（源码软链安装）：更新本仓库源码后**重启 DSH** 即生效。
- 卸载：在 **设置 → 插件** 里禁用并移除，或
  `dsh plugin --profile web remove dsh-rfiles`；再从 `dsh.profile.bundles` 删掉 `"dsh-rfiles"`，
  重启 DSH。源码软链安装则删除 profile `cordis.patch.yml` 里的 `id: rfiles` 行与
  `node_modules/dsh-rfiles` 软链。
- 可选清理：`rm -rf "$DSH_HOME/rfile-transfers"`（未完成的暂存）；工作区 `.uploads/` 里的文件不会被自动删除。

---

## 5. 手机 / 远程使用

### 5.1 打开与选会话

1. 用配对二维码在手机浏览器打开远程页（电脑远程同理）。
2. 页面右下角出现「文件」按钮（📁）。点开是底部抽屉。
3. 面板顶部下拉选择会话：只列出**当前活跃**的会话，默认选中最新一个；右侧「远程」徽标表示当前页面走
   /remote 通道。若显示「请先在 GUI 里打开一个会话」，先在电脑上打开任意会话，再点面板里的「刷新会话列表」。
4. 面板默认收起（点 📁 展开），z-index 置顶；若被全屏播放器或其它浮层遮挡，先退出全屏再打开。

### 5.2 把文件 / 图片发给 Agent

1. 「上传」tab 顶部选择方式：**发送给 Agent**（默认）或 **只存入工作区**。
2. 点「选择文件」可多选任意类型；点「拍照 / 相册」调起相机/相册（accept=image/*, capture=environment）。
3. 选完自动开始分块上传，显示「已传 x / y（百分比）」。失败可点重试；可「取消上传」。
   - 断网/刷新页面后，重新选择**同一个文件**（同名、同大小、同修改时间）会尝试从上次 offset 续传（24 小时内）。
4. 「发送给 Agent」方式：上传完成后出现输入框（可留空）+「发送给 Agent」按钮。发送后文件会作为真实附件
   进入当前会话（普通文件走官方收据附件；png/jpeg/webp/gif 且 ≤20 MiB 走图片附件），并触发一次 prompt。
5. 「只存入工作区」方式：上传完成即落盘到 `<workspace>/.uploads/`，不触发 prompt；之后可在「下载」tab 里看到它。

注意：单文件 > 2 GiB 或暂存区超 10 GiB 会被拒绝（413）；图片 >20 MiB 会按普通文件附件发送。

### 5.3 把文件下载到手机

1. 「下载」tab：默认列出工作区根目录（文件夹优先），顶部是面包屑。
2. 点文件夹进入；点文件行主链接 → 浏览器**原生下载**（远程页链接已自动带 /remote 前缀）。
3. 若点了没反应、被浏览器拦截，或设备处于「无 cookie 配对」模式：点该行右侧「⤓」按钮，
   它用 fetch 取字节 + Blob 保存（fetch 会被 boot patch 改写并带设备凭据，所以无 cookie 也能用）。
4. 顶部「下载会话日志 ZIP」：下载当前会话日志（含子会话与附件对象）。
   同理由原生链接下载；无 cookie 设备请用旁边的「通过请求保存」。
5. 只列工作区内路径；不支持目录打包下载（会话日志 ZIP 例外）、不支持删除/重命名/新建目录。

iOS Safari 提示：部分类型会先在新标签预览，可用分享面板「存储到文件」；大文件下载时请保持页面在前台。

---

## 6. 数据流（为什么这样能绕开上游缺陷）

```
【上传】手机浏览器
  fetch PUT /api/rfiles.upload.chunk?uploadId=...&offset=...
    └─ 第三方 boot patch 改写 → /remote/api/rfiles.upload.chunk   [配对门：cookie 或 x-dsh-remote-device]
         └─ 代理用进程自己的 browser-auth cookie 回环 127.0.0.1:<port>
              └─ Connection exact Fetch route → TransferStore 顺序写 data.bin（offset 幂等，409 续传）
  POST /api/rfiles.send
    └─（同上）→ 宿主 ctx.fileUploads.uploadStream() 铸 receipt → ctx.sessionController.prompt(mode:"queue")
         → 与官方 composer 完全同一条路径，Agent 收到真实附件

【下载】手机浏览器
  <a download href="/remote/api/rfiles.download?sessionId=...&path=...">
    └─ 锚点导航不会被 boot patch 改写，但 URL 自带 /remote → 配对门接受 cookie
         └─ 代理回环（进程凭据）→ 插件路由返回 200/206 + Content-Length + Content-Disposition
              └─ 代理把 Content-Disposition 透传给浏览器 → 原生下载落盘
```

几个关键事实：

- **Range 只在桌面直连时完整可用**（插件路由支持 206/416）。远程代理会丢弃 Range 相关头，
  所以手机上不支持断点续传/拖动；**上传续传不受影响**，因为续传靠的是分块 offset，不是 HTTP Range。
- 远程代理会原样透传 **Content-Disposition / Content-Length / Content-Type / ETag / Last-Modified**，
  这是原生下载能工作的原因。
- 远程判定不用 hostname，而是检查第三方 boot 补丁发布的 `window.__DSH_REMOTE_CHANNEL_BOOT__`；
  LAN 直连（没走配对通道）不会被误判成远程，下载仍走 /api。

---

## 7. 验证

### 7.1 连通性脚本

安装并重启 DSH 后，在宿主机执行（需要 `curl` 与 `node`，Node 由 DSH 自带）：

```bash
bash scripts/verify.sh                    # 端口默认 61298
bash scripts/verify.sh --port 61299
bash scripts/verify.sh --session <id>     # 指定会话（默认自动发现最新的会话目录）
bash scripts/verify.sh --device <id>      # 指定配对设备（默认取设备文件第一个，不打印 id）
bash scripts/verify.sh --require-range    # Range 未直通时按 FAIL 处理
bash scripts/verify.sh --skip-tests       # 跳过单测
bash scripts/verify.sh --keep             # 保留测试上传的文件（默认删除）
```

它用已配对设备的凭据（`x-dsh-remote-device` 头）模拟远程请求，走真实 /remote 代理链路，共 7 步：

1. `GET /remote/api/rfiles.health` → 200 且 `ok:true`（403 = 配对失效；404 = 插件未加载）；
2. `node --test test/*.test.mjs` 单测（Range/分块/路径约束等纯逻辑）；
3. 生成 1 MiB 随机文件，init → 两段 512 KiB chunk → finish（校验 offset 回执与落盘 size）；
4. `GET /remote/api/rfiles.list` → 刚上传的文件在列表中且大小正确；
5. `GET /remote/api/rfiles.download` → 字节数与 sha256 全部吻合（并检查 attachment 头）；
6. `Range: bytes=100-199` → 期望 206 + `Content-Range: bytes 100-199/1048576`。
   **注意**：经 /remote 代理时 Range 会被丢弃，实际收到 200 全量，脚本默认把这项标为 SKIP 并说明原因；
   用 `--require-range` 可强制它 FAIL。Range 逻辑由第 2 步单测覆盖。
7. `GET /remote/api/rfiles.export?sessionId=...` → 200 + `application/zip` + PK 魔数。

任何真正的断言失败会打印 `FAIL ...` 并以非 0 退出；SKIP/WARN 不影响退出码。脚本只做本地 loopback 请求，
不修改服务、不重启 DSH；默认会自动删除第 3 步上传的测试文件。设备 id 只在内存中使用，不会打印。

### 7.2 单测与语法检查

```bash
cd dsh-rfiles
node --check lib/index.js && node --check lib/core.js && node --check lib/client.js
node --test test/                      # 等价：node --test test/*.test.mjs
```

> 目录形式与显式文件两种写法都可用：`node --test test/`（依赖 test/index.js 目录入口）或
> `node --test test/*.test.mjs`（不依赖入口文件，最大兼容）。某些 Node 版本下目录形式可能报
> `Error: Cannot find module '.../test'`，此时用后者即可。

### 7.3 已验证 / 未验证

已在开发机（macOS，DSH 0.2.1-rc.3/rc.5，remote-web-ui 0.4.8/0.4.12）验证：

- **隔离实例端到端**：独立 `DSH_HOME` 的 web profile + remote-web-ui 0.4.12 + 本插件，
  经真实 `/remote` 配对通道跑通 health / 12 MiB 分块上传（含重复 offset 409）/ list / 下载 sha256
  / 会话日志 ZIP；直连 `/api` 另测 206+Content-Range、开区间 206、越界 416；共 26 PASS / 0 FAIL。
- **包安装**：`dsh plugin add <tarball>` 后 bundle 层生效、`/api/rfiles.health` 200；详见仓库根
  `RELEASE-CHECKLIST.md`。
- **通道能承载下载**：带配对设备头 `GET /remote/api/session.export?sessionId=...&includeDescendants=true`
  实测返回 `200 + content-type: application/zip + content-disposition: attachment`。
- **install.sh**：在隔离的临时 DSH_HOME 下验证 `--dry-run`、首次安装、幂等重跑、`--force` 重指软链、
  非法参数拒绝；`bash -n` 通过。
- **verify.sh**：对契约 mock 服务器与本地桩服务器全链路通过（含 206+Content-Range 分支、代理丢 Range 时
  SKIP、`--require-range` 时 FAIL、非 0 退出）；`bash -n` 通过。
- **单元测试**：`node --test test/*.test.mjs` 全绿（33 项）。

尚未验证（需要真机确认）：

- 真实手机浏览器上的上传/拍照/进度/续传/下载/会话日志 ZIP。
- iOS Safari 的下载与预览行为；公网隧道下大文件的耗时与失败模式。
- 真实桌面 profile 上的日常使用回归（隔离实例已通过，未在用户正在运行的实例上重启验证）。

---

## 8. 排障

| 现象 | 排查与处理 |
| --- | --- |
| 右下角没有「文件」按钮 | ① 是否**完全重启**了 DSH（patch 只在启动时读取）；② 硬刷新页面（注入发生在 index 渲染时）；③ 检查 profile `package.json` 的 `dsh.profile.bundles` 是否含 `dsh-rfiles`（源码软链安装则看 `cordis.patch.yml` 的 `id: rfiles` 行）、`node_modules/dsh-rfiles` 是否存在；④ DevTools Console 搜 `__DSH_RFILES__` / 看是否有 `[dsh-rfiles]` 报错；⑤ DSH 启动日志里插件加载失败（inject 的 webServer/connection/sessions/sessionPersistence/sandboxPolicy/fileUploads/sessionController 任一缺失都会不加载）。 |
| 面板显示「请先在 GUI 里打开一个会话」 | 会话下拉只列**活跃**会话（`/api/rfiles.sessions` 来自 ctx.sessions.list()）。先在电脑上打开一个会话，再点「刷新会话列表」。冷会话不会出现在下拉里（但 verify.sh 可用 --session 指定）。 |
| 上传 401 / 403 | 配对失效或未带设备凭据：重新扫码配对；确认面板右上出现「远程」徽标；DevTools Network 看请求是否为 `/remote/api/rfiles.*`（若仍是 `/api/...` 说明第三方 boot patch 未生效，远程下不可用）。 |
| 下载 401 / 403（含会话日志 ZIP） | 原生下载链接只能靠**配对 cookie** 鉴权（锚点导航带不了 x-dsh-remote-device 头）。无 cookie 配对设备请用「⤓ / 通过请求保存」；或重新配对。 |
| 点文件没有下载反应 | 浏览器拦截了下载/需要授权；改用「⤓」；iOS 可能先预览再「存储到文件」。 |
| 上传卡住 / 失败 | 看进度与 Network 里的 chunk 请求：409 offset-mismatch 是正常续传（客户端会自动按 received 续）；413 是超出配额；隧道断流后重新进入面板重试即可续传。 |
| 413 / 磁盘不足 | 单文件 >2 GiB、暂存 >10 GiB 或磁盘满。可在 cordis.patch.yml 的 config 调大 chunkBytes/maxFileBytes/stagingBytes，或清理 `$DSH_HOME/rfile-transfers`。 |
| 下载/视频拖动不支持续传 | 这是上游代理丢弃 Range 的已知限制（开发工作区维护了 issue 草稿，尚未提交）；桌面直连 /api 才支持 206。 |
| verify.sh 报 404 | 插件未加载或未重启；先确认按钮出现再跑。 |
| verify.sh 报 403 | 配对设备过期；在电脑上重新扫码配对，或 `--device` 指定另一个设备 id。 |
| 端口不是 61298 | `bash scripts/verify.sh --port <port>`；端口见 DSH 启动日志/GUI URL。 |

---

## 9. 安全边界

- **不新增鉴权**：所有路由都是 Connection 的 exact Fetch route。桌面 owner 浏览器直接访问；远程请求必须先过
  /remote 的配对门（cookie 或 `x-dsh-remote-device`），再由代理用**进程自己的** browser-auth cookie 回环请求
  /api。非 owner Peer 访问 exact route 仍是 403。
- **路径约束**：列目录/下载/上传落点都限制在会话 workspace 内；拒绝绝对路径、`..`、NUL、盘符与符号链接逃逸
  （realpath 校验）。不能读写 workspace 之外的文件。
- **暂存目录**：`$DSH_HOME/rfile-transfers/<uploadId>/`，只存当前上传的字节与元数据，不复制会话/附件数据。
- **最小能力面**：只提供列目录、下载、上传、发送；没有删除/重命名/新建目录/执行等操作。
- **设备凭据**：install.sh / verify.sh 都不会把设备 id 打印到输出；README 与代码不含任何用户私有路径、主机名、凭据。

---

## 10. 已知限制

- 远程页 **不支持 HTTP Range**（上游代理丢弃 Range/Content-Range/Accept-Ranges），下载为全量、不能断点续传；
  上传续传可用（按分块 offset）。
- 「下载」tab 只能浏览 workspace 内路径；不提供目录打包下载（会话日志 ZIP 除外）。
- 会话下拉只列活跃会话（冷会话需通过脚本/接口指定 id）。
- 通过 Cloudflare 等隧道访问时，上传是 8 MiB 分块请求（可绕开单请求体积限制），但总时长/流量仍受隧道限制；
  Quick Tunnel 不保证可用性。
- present 卡片的「在宿主打开」对手机没有意义；请在「下载」tab 里浏览 workspace 产出文件。
- 第三方 @linxin666/dsh-remote-web-ui 若未来改变通道行为（boot 全局名、头白名单、/remote 语义），
  本插件需要重新回归；请在升级该插件后跑一次 verify.sh。
- 未在 iOS Safari、Android 各家浏览器上做完整真机矩阵（见 §7.3）。

---

## 11. 开发与联调

无需 DSH 即可联调客户端 UI：

```bash
cd dsh-rfiles
node scripts/mock-server.mjs --port 4399
# 浏览器打开 http://127.0.0.1:4399/mock.html
# 远程前缀模式：http://127.0.0.1:4399/mock.html?remote=1（下载链接会带 /remote）
```

- 小部件是 classic script（IIFE），由 Host 通过 `webserver/index-inject` 注入到官方 index 的 `<head>`；
  调试接口：`window.__DSH_RFILES_UI__`（open/close/refresh/state）。
- 纯逻辑集中在 lib/core.js（路径约束、Range、下载头、TransferStore），可直接单测。
- 接口以 [CONTRACT.md](./CONTRACT.md) 为准；改动需同时更新 README 与 test/。

---

## 12. 文件清单

| 文件 | 作用 | npm tarball |
| --- | --- | --- |
| package.json | 包元数据；`dsh.bundle.patch` 指向 bundle 层 | ✅ |
| cordis.patch.yml | bundle 层：`insert: id: rfiles` | ✅ |
| lib/index.js | Cordis 插件：注册 /api/rfiles.* 路由、注入客户端脚本 | ✅ |
| lib/core.js | 纯逻辑（路径/Range/下载头/分块存储） | ✅ |
| lib/client.js | 浏览器小部件（vanilla JS，Shadow DOM，移动端抽屉） | ✅ |
| README.md / README.zh.md | 英文 / 中文文档 | ✅ |
| LICENSE、assets/icon.png、assets/icon.svg | MIT 许可与仓库图标 | ✅ |
| test/core.test.mjs、test/routes.test.mjs | node:test 单测 | ❌ 仅源码仓库 |
| scripts/install.sh | 源码目录安全安装（备份 patch、幂等追加、软链、--dry-run/--force） | ❌ 仅源码仓库 |
| scripts/verify.sh | 远程通道全链路验证（health/上传/list/下载/Range/导出） | ❌ 仅源码仓库 |
| scripts/mock-server.mjs、scripts/mock.html | 契约 mock 与联调页面 | ❌ 仅源码仓库 |
| CONTRACT.md | 接口契约（唯一事实来源） | ❌ 仅源码仓库 |

`files` 白名单只发布运行所需文件；测试、脚本与契约文档留在 GitHub 仓库，供开发和验证使用。
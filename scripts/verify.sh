#!/usr/bin/env bash
# dsh-rfiles 连通性验证脚本（在运行 DSH 的宿主机上执行）
#
# 用「已配对设备的凭据」模拟远程页面的请求，走真实的 /remote 代理链路：
#   GET    /remote/api/rfiles.health
#   POST   /remote/api/rfiles.upload.init        （1 MiB 随机文件）
#   PUT    /remote/api/rfiles.upload.chunk       （两段，各 512 KiB）
#   POST   /remote/api/rfiles.upload.finish
#   GET    /remote/api/rfiles.list
#   GET    /remote/api/rfiles.download           （校验大小 + sha256）
#   GET    /remote/api/rfiles.download + Range   （206 + Content-Range）
#   GET    /remote/api/rfiles.export             （application/zip）
#
# 用法：
#   bash scripts/verify.sh                       # 端口默认 61298
#   bash scripts/verify.sh --port 61299
#   bash scripts/verify.sh --session <id>        # 指定用于上传/导出的会话
#   bash scripts/verify.sh --device <id>         # 指定配对设备（默认取设备文件第一个）
#   bash scripts/verify.sh --require-range       # Range 未直通时按 FAIL 处理
#   bash scripts/verify.sh --skip-tests          # 跳过 node --test 单测
#   bash scripts/verify.sh --keep                # 保留测试上传的文件（默认删除）
#
# 说明（重要）：
#   - 脚本读取 ~/.dsh/remote-web-ui-devices.json 里的设备 id，但不会打印它。
#   - /remote 代理白名单会丢弃 Range/If-Range/Content-Range/Accept-Ranges，
#     所以经代理无法真的断言 206（收到的会是 200 全量）。默认把这项标为
#     SKIP 并说明原因；--require-range 可把它变成 FAIL。Range 逻辑本身由
#     node --test test/*.test.mjs（本脚本第 2 步）覆盖。
#   - 脚本只做本地 loopback 请求，不修改服务、不重启 DSH；测试上传的文件
#     默认会从工作区删除（--keep 可保留）。
#   - 默认端口 61298；DSH_HOME 默认 ~/.dsh（可用环境变量覆盖）。
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
PKG_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"

if [ -z "$DSH_HOME" ]; then
  DSH_HOME="$HOME/.dsh"
fi

PROFILE_NAME=desktop
PORT=61298
DEVICE=""
SESSION=""
REQUIRE_RANGE=0
RUN_TESTS=1
KEEP=0

TMP=""
WSROOT=""
REL=""
OWNED_UPLOAD=0

usage() {
  sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'
}

die() {
  printf 'verify: %s\n' "$*" >&2
  exit 2
}

fail() {
  printf 'FAIL  %s\n' "$*" >&2
  exit 1
}

pass() { printf 'PASS  %s\n' "$*"; }
info() { printf 'INFO  %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*"; }
skip() { printf 'SKIP  %s\n' "$*"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --port)
      [ "$#" -ge 2 ] || die "--port 需要端口号"
      PORT="$2"; shift ;;
    --device)
      [ "$#" -ge 2 ] || die "--device 需要设备 id"
      DEVICE="$2"; shift ;;
    --session)
      [ "$#" -ge 2 ] || die "--session 需要会话 id"
      SESSION="$2"; shift ;;
    --require-range) REQUIRE_RANGE=1 ;;
    --skip-tests) RUN_TESTS=0 ;;
    --keep) KEEP=1 ;;
    --profile)
      [ "$#" -ge 2 ] || die "--profile 需要 profile 名称"
      PROFILE_NAME="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1（用 --help 查看用法）" ;;
  esac
  shift
done

case "$PORT" in
  ''|*[!0-9]*) die "非法端口：$PORT" ;;
esac

BASE="http://127.0.0.1:$PORT"

cleanup() {
  if [ -n "$TMP" ] && [ -d "$TMP" ]; then
    rm -rf "$TMP"
  fi
}

# ── 0. 前置检查 ────────────────────────────────────────────────────────────
command -v curl >/dev/null 2>&1 || die "需要 curl"
command -v node >/dev/null 2>&1 || die "需要 node（解析 JSON/计算 sha256/发现会话）"

[ -d "$DSH_HOME" ] || die "找不到 DSH_HOME：$DSH_HOME"
DEV_FILE="$DSH_HOME/remote-web-ui-devices.json"
[ -f "$DEV_FILE" ] || die "找不到配对设备文件：${DEV_FILE}（先完成手机/远程电脑配对）"

if [ -z "$DEVICE" ]; then
  DEVICE="$(node -e '
    const fs = require("fs");
    let doc = {};
    try { doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (e) { process.exit(0); }
    const keys = Object.keys(doc || {});
    if (keys.length > 0) process.stdout.write(keys[0]);
  ' "$DEV_FILE")"
fi
[ -n "$DEVICE" ] || die "设备文件里没有可用设备：${DEV_FILE}（请重新配对）"
info "配对设备：已读取（id 已隐去）；端口 $PORT"

if [ -z "$SESSION" ]; then
  SESSION="$(node -e '
    const fs = require("fs");
    const path = require("path");
    const root = process.argv[1];
    let projects = [];
    try { projects = fs.readdirSync(root); } catch (e) { process.exit(0); }
    let best = null;
    for (const p of projects) {
      const dir = path.join(root, p);
      let st;
      try { st = fs.statSync(dir); } catch (e) { continue; }
      if (!st.isDirectory()) continue;
      let ents = [];
      try { ents = fs.readdirSync(dir); } catch (e) { continue; }
      for (const ent of ents) {
        const sd = path.join(dir, ent);
        let sst;
        try { sst = fs.statSync(sd); } catch (e) { continue; }
        if (!sst.isDirectory()) continue;
        let files = [];
        try { files = fs.readdirSync(sd); } catch (e) { continue; }
        const log = files.find(function (f) { return f.startsWith("session.v") && f.indexOf(".jsonl") !== -1; });
        if (!log) continue;
        let mt;
        try { mt = fs.statSync(path.join(sd, log)).mtimeMs; } catch (e) { continue; }
        if (best === null || mt > best.mt) best = { mt: mt, id: ent };
      }
    }
    if (best !== null) process.stdout.write(best.id);
  ' "$DSH_HOME/sessions")"
fi
if [ -z "$SESSION" ]; then
  warn "未自动发现会话 id（可用 --session 指定）；上传与导出步骤可能失败"
else
  SESSION_SHOWN="$(node -e 'const s = process.argv[1]; process.stdout.write(s.length > 12 ? s.slice(0, 8) + "…" : s)' "$SESSION")"
  info "使用会话：$SESSION_SHOWN"
fi

TMP="$(mktemp -d)"
trap cleanup EXIT
BODY="$TMP/body"
HDR="$TMP/hdr"

# ── HTTP 小工具 ────────────────────────────────────────────────────────────
CODE=""
req() {
  local method="$1" url="$2"
  shift 2
  : > "$BODY"
  : > "$HDR"
  CODE="$(curl -sS --max-time 300 --connect-timeout 5 -X "$method" \
    -H "x-dsh-remote-device: $DEVICE" -D "$HDR" -o "$BODY" -w '%{http_code}' "$@" "$url")" \
    || fail "curl 请求失败：$method $url"
}

hval() {
  tr -d '\r' < "$HDR" | awk -v key="$1" 'tolower($0) ~ ("^" tolower(key) ":") { sub(/^[^:]*:[[:space:]]*/, ""); print; exit }'
}

json() {
  node -e '
    const fs = require("fs");
    let v;
    try { v = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (e) { process.exit(3); }
    for (const k of process.argv.slice(2)) v = (v === null || v === undefined) ? undefined : v[k];
    if (v === undefined || v === null) process.stdout.write("");
    else if (typeof v === "object") process.stdout.write(JSON.stringify(v));
    else process.stdout.write(String(v));
  ' "$BODY" "$@"
}

snippet() { head -c 300 "$BODY" | tr '\n' ' '; }

# ── 1. health ──────────────────────────────────────────────────────────────
printf '\n== 1/7 health ==\n'
req GET "$BASE/remote/api/rfiles.health"
if [ "$CODE" = "403" ]; then
  fail "health 403：配对设备无效或已过期，请重新扫码配对"
elif [ "$CODE" = "404" ]; then
  fail "health 404：插件路由未注册 —— 确认已执行 install.sh 并重启了 DSH"
elif [ "$CODE" != "200" ]; then
  fail "health HTTP ${CODE}：$(snippet)"
fi
[ "$(json ok)" = "true" ] || fail "health 响应 ok != true：$(snippet)"
WSROOT="$(json workspaceRoot)"
[ -n "$WSROOT" ] || fail "health 响应缺少 workspaceRoot"
pass "health ok（workspaceRoot=${WSROOT}）"

# ── 2. 单测（Range/分块逻辑的本体验证） ────────────────────────────────────
printf '\n== 2/7 单测 ==\n'
if [ "$RUN_TESTS" -eq 0 ]; then
  skip "已用 --skip-tests 跳过"
elif ! compgen -G "$PKG_DIR/test/*.test.mjs" >/dev/null 2>&1; then
  skip "未找到 test/*.test.mjs（测试源码未安装？）"
else
  # 显式展开到测试文件（不依赖 test/index.js 入口）；等价写法 node --test 'test/*.test.mjs'。
  # 目录形式 node --test test/ 也可用，但部分 Node 版本会报 MODULE_NOT_FOUND。
  if ( cd "$PKG_DIR" && node --test test/*.test.mjs > "$TMP/test.log" 2>&1 ); then
    pass "node --test test/*.test.mjs 全绿"
  else
    tail -n 40 "$TMP/test.log" || true
    fail "node --test test/*.test.mjs 失败（见上方输出）"
  fi
fi

# ── 3. 分块上传 1 MiB ──────────────────────────────────────────────────────
printf '\n== 3/7 分块上传 ==\n'
SIZE=1048576
PART=524288
NAME="rfiles-verify-$(date +%s).bin"
node -e '
  const fs = require("fs");
  const crypto = require("crypto");
  const buf = crypto.randomBytes(1048576);
  fs.writeFileSync(process.argv[1], buf);
  fs.writeFileSync(process.argv[2], buf.subarray(0, 524288));
  fs.writeFileSync(process.argv[3], buf.subarray(524288));
  fs.writeFileSync(process.argv[4], crypto.createHash("sha256").update(buf).digest("hex"));
' "$TMP/blob.bin" "$TMP/part1.bin" "$TMP/part2.bin" "$TMP/sha256.txt"
WANT_SHA="$(cat "$TMP/sha256.txt")"

INIT_JSON="$(node -e '
  process.stdout.write(JSON.stringify({
    sessionId: process.argv[1],
    mode: "workspace",
    name: process.argv[2],
    size: Number(process.argv[3])
  }));
' "$SESSION" "$NAME" "$SIZE")"

req POST "$BASE/remote/api/rfiles.upload.init" \
  -H 'content-type: application/json' --data-binary "$INIT_JSON"
if [ "$CODE" = "403" ]; then fail "upload.init 403：配对凭据无效/已过期"; fi
[ "$CODE" = "200" ] || fail "upload.init HTTP ${CODE}：$(snippet)"
[ "$(json ok)" = "true" ] || fail "upload.init 失败：$(snippet)"
UPLOAD_ID="$(json uploadId)"
[ -n "$UPLOAD_ID" ] || fail "upload.init 未返回 uploadId：$(snippet)"
pass "upload.init ok（uploadId 已获取）"

req PUT "$BASE/remote/api/rfiles.upload.chunk?uploadId=$UPLOAD_ID&offset=0" \
  -H 'content-type: application/octet-stream' --data-binary "@$TMP/part1.bin"
[ "$CODE" = "200" ] || fail "chunk#1 HTTP ${CODE}：$(snippet)"
[ "$(json ok)" = "true" ] || fail "chunk#1 失败：$(snippet)"
OFF1="$(json offset)"
REC1="$(json received)"
if [ "$OFF1" != "$PART" ] && [ "$REC1" != "$PART" ]; then
  fail "chunk#1 回执异常（期望 524288）：offset=$OFF1 received=$REC1"
fi
pass "chunk#1 ok（512 KiB）"

req PUT "$BASE/remote/api/rfiles.upload.chunk?uploadId=$UPLOAD_ID&offset=$PART" \
  -H 'content-type: application/octet-stream' --data-binary "@$TMP/part2.bin"
[ "$CODE" = "200" ] || fail "chunk#2 HTTP ${CODE}：$(snippet)"
[ "$(json ok)" = "true" ] || fail "chunk#2 失败：$(snippet)"
OFF2="$(json offset)"
REC2="$(json received)"
if [ "$OFF2" != "$SIZE" ] && [ "$REC2" != "$SIZE" ]; then
  fail "chunk#2 回执异常（期望 1048576）：offset=$OFF2 received=$REC2"
fi
pass "chunk#2 ok（累计 1 MiB）"

FINISH_JSON="$(node -e 'process.stdout.write(JSON.stringify({uploadId: process.argv[1]}))' "$UPLOAD_ID")"
req POST "$BASE/remote/api/rfiles.upload.finish" \
  -H 'content-type: application/json' --data-binary "$FINISH_JSON"
[ "$CODE" = "200" ] || fail "upload.finish HTTP ${CODE}：$(snippet)"
[ "$(json ok)" = "true" ] || fail "upload.finish 失败：$(snippet)"
MODE="$(json mode)"
REL="$(json path)"
GOT_SIZE="$(json size)"
[ "$MODE" = "workspace" ] || fail "finish mode=${MODE}（期望 workspace）"
[ -n "$REL" ] || fail "finish 未返回落盘路径：$(snippet)"
[ "$GOT_SIZE" = "$SIZE" ] || fail "finish size=${GOT_SIZE}（期望 ${SIZE}）"
OWNED_UPLOAD=1
pass "upload.finish ok（${REL}）"

# ── 4. list ────────────────────────────────────────────────────────────────
printf '\n== 4/7 list ==\n'
LIST_DIR="$(dirname "$REL")"
if [ "$LIST_DIR" = "." ]; then LIST_DIR=""; fi
ENC_LIST="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$LIST_DIR")"
ENC_SESSION="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$SESSION")"
req GET "$BASE/remote/api/rfiles.list?sessionId=$ENC_SESSION&path=$ENC_LIST"
[ "$CODE" = "200" ] || fail "list HTTP ${CODE}：$(snippet)"
[ "$(json ok)" = "true" ] || fail "list 失败：$(snippet)"
if ! node -e '
  const fs = require("fs");
  const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const name = process.argv[2];
  const size = Number(process.argv[3]);
  const entries = Array.isArray(doc.entries) ? doc.entries : [];
  const hit = entries.find(function (e) { return e && e.name === name; });
  if (!hit) { console.error("list 中找不到 " + name); process.exit(1); }
  if (Number(hit.size) !== size) { console.error("list size=" + hit.size + " != " + size); process.exit(1); }
' "$BODY" "$NAME" "$SIZE"; then
  fail "list 结果不正确（见上方输出）"
fi
pass "list ok（包含 ${NAME}，size=${SIZE}）"

# ── 5. download（大小 + sha256） ───────────────────────────────────────────
printf '\n== 5/7 download ==\n'
ENC_REL="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$REL")"
req GET "$BASE/remote/api/rfiles.download?sessionId=$ENC_SESSION&path=$ENC_REL"
[ "$CODE" = "200" ] || fail "download HTTP ${CODE}：$(snippet)"
DL_BYTES="$(node -e 'process.stdout.write(String(require("fs").statSync(process.argv[1]).size))' "$BODY")"
[ "$DL_BYTES" = "$SIZE" ] || fail "download 字节数 $DL_BYTES != $SIZE"
DL_SHA="$(node -e '
  const fs = require("fs");
  const crypto = require("crypto");
  process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"));
' "$BODY")"
[ "$DL_SHA" = "$WANT_SHA" ] || fail "download sha256 不匹配（$DL_SHA != ${WANT_SHA}）"
CD="$(hval content-disposition)"
case "$CD" in
  *attachment*) pass "download ok（大小与 sha256 一致；attachment 头存在）" ;;
  *) warn "download 内容正确，但缺少 Content-Disposition: attachment（${CD}）" ;;
esac
CL="$(hval content-length)"
if [ -n "$CL" ] && [ "$CL" != "$SIZE" ]; then
  fail "download Content-Length $CL != $SIZE"
fi

# ── 6. Range ───────────────────────────────────────────────────────────────
printf '\n== 6/7 Range ==\n'
req GET "$BASE/remote/api/rfiles.download?sessionId=$ENC_SESSION&path=$ENC_REL" \
  -H 'Range: bytes=100-199'
if [ "$CODE" = "206" ]; then
  CR="$(hval content-range)"
  PART_BYTES="$(node -e 'process.stdout.write(String(require("fs").statSync(process.argv[1]).size))' "$BODY")"
  [ "$PART_BYTES" = "100" ] || fail "Range 206 但响应体 $PART_BYTES 字节（期望 100）"
  case "$CR" in
    "bytes 100-199/$SIZE") pass "Range ok（206 + Content-Range: ${CR}）" ;;
    *) fail "Range 206 但 Content-Range 异常：$CR" ;;
  esac
elif [ "$CODE" = "200" ]; then
  if [ "$REQUIRE_RANGE" -eq 1 ]; then
    fail "Range 未生效：代理层丢弃了 Range/Content-Range/Accept-Ranges（见 docs/upstream-issue-draft.md）"
  fi
  skip "Range 经 /remote 代理不可测：代理白名单丢弃 Range 与 Content-Range（已知通道限制），服务端返回 200 全量。用 --require-range 可强制 FAIL；Range 逻辑由第 2 步单测覆盖。"
else
  fail "Range HTTP ${CODE}：$(snippet)"
fi

# ── 7. 会话日志 ZIP ────────────────────────────────────────────────────────
printf '\n== 7/7 会话日志 ZIP ==\n'
if [ -z "$SESSION" ]; then
  skip "无会话 id，跳过 export（用 --session 指定后重试）"
else
  req GET "$BASE/remote/api/rfiles.export?sessionId=$ENC_SESSION"
  [ "$CODE" = "200" ] || fail "export HTTP ${CODE}：$(snippet)"
  CT="$(hval content-type)"
  case "$CT" in
    application/zip*) pass "export ok（Content-Type: ${CT}）" ;;
    *) fail "export Content-Type=${CT}（期望 application/zip）" ;;
  esac
  if ! node -e '
    const fs = require("fs");
    const b = fs.readFileSync(process.argv[1]);
    if (b.length < 4 || b[0] !== 0x50 || b[1] !== 0x4b) {
      console.error("不是 ZIP（缺少 PK 魔数）");
      process.exit(1);
    }
  ' "$BODY"; then
    fail "export 响应不是 ZIP 文件"
  fi
fi

# ── 完成 ───────────────────────────────────────────────────────────────────
printf '\n'
if [ "$OWNED_UPLOAD" -eq 1 ] && [ "$KEEP" -eq 0 ] && [ -n "$WSROOT" ] && [ -n "$REL" ]; then
  node -e '
    const fs = require("fs");
    const path = require("path");
    const root = path.resolve(process.argv[1]);
    const abs = path.resolve(root, process.argv[2]);
    const inside = abs === root || abs.startsWith(root + path.sep);
    if (!inside) { console.error("拒绝清理工作区外的路径"); process.exit(0); }
    try { fs.unlinkSync(abs); console.log("已清理测试文件：" + process.argv[2]); }
    catch (e) { console.error("清理失败：" + e.message); }
  ' "$WSROOT" "$REL" || true
fi

printf 'verify: 完成（FAIL 会立即退出并返回非 0；SKIP/WARN 不影响退出码）\n'
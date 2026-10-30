#!/usr/bin/env bash
# dsh-rfiles 安装脚本（profile-local 伴生插件，不改 DSH 核心、不改第三方插件）
#
# 只做三件事：
#   1. 检查目标 DSH profile、插件源码和必要文件；
#   2. 把 <profile>/node_modules/dsh-rfiles 软链到本包（默认软链，不复制）；
#   3. 在 <profile>/cordis.patch.yml 末尾追加一条 insert 挂载行（先备份）。
#
# 不会重启 DSH、不会改动 ~/.dsh 下其它文件。
#
# 用法：
#   bash scripts/install.sh                 # 安装 / 刷新软链
#   bash scripts/install.sh --dry-run       # 只打印将要执行的动作
#   bash scripts/install.sh --profile desktop
#   bash scripts/install.sh --force         # 软链已存在但指向别处时强制重指
#
# 说明：
#   - 目标 profile 默认 desktop（可用 --profile 或 RFILES_PROFILE 覆盖）；
#   - DSH_HOME 默认 ~/.dsh（可用环境变量覆盖）；
#   - 幂等：重复运行不会重复写入 patch 行，也不会重复备份；
#   - 安装后需要完全退出并重新打开 DSH 才会加载插件。
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_NAME="${RFILES_PROFILE:-desktop}"
DRY_RUN=0
FORCE=0

usage() {
  sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'
}

die() { printf 'install: %s\n' "$*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --profile)
      [ "$#" -ge 2 ] || die "--profile 需要一个 profile 名称"
      PROFILE_NAME="$2"; shift ;;
    --force) FORCE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1（用 --help 查看用法）" ;;
  esac
  shift
done

case "$PROFILE_NAME" in
  */*|.*|"") die "非法 profile 名称：$PROFILE_NAME" ;;
esac

PROFILE_DIR="$DSH_HOME/profiles/$PROFILE_NAME"
PATCH="$PROFILE_DIR/cordis.patch.yml"
MODULES_DIR="$PROFILE_DIR/node_modules"
TARGET="$MODULES_DIR/dsh-rfiles"

# ── 1. 前置检查 ────────────────────────────────────────────────────────────
[ -d "$PROFILE_DIR" ] || die "找不到 DSH profile：${PROFILE_DIR}（先确认 DSH 已安装并运行过）"
[ -f "$PATCH" ] || die "找不到挂载配置：${PATCH}（不在预期位置？请用 --profile 指定）"
[ -d "$MODULES_DIR" ] || die "找不到 profile 的 node_modules：$MODULES_DIR"
[ -f "$PKG_DIR/package.json" ] || die "缺少插件清单：$PKG_DIR/package.json"
[ -f "$PKG_DIR/lib/index.js" ] || die "缺少插件入口：$PKG_DIR/lib/index.js（源码尚未生成？）"
grep -Eq '"name"[[:space:]]*:[[:space:]]*"dsh-rfiles"' "$PKG_DIR/package.json" \
  || die "package.json 中的 name 不是 dsh-rfiles：$PKG_DIR/package.json"

if [ ! -f "$MODULES_DIR/@linxin666/dsh-remote-web-ui/package.json" ]; then
  printf 'install: 提醒：未检测到 @linxin666/dsh-remote-web-ui；本插件不依赖它，但远程访问场景需要它。\n' >&2
fi

printf 'install: 插件源码  %s\n' "$PKG_DIR"
printf 'install: 目标 profile %s\n' "$PROFILE_DIR"

# ── 2. 建立 / 更新 node_modules 软链 ───────────────────────────────────────
link_state="missing"
current=""
if [ -L "$TARGET" ]; then
  current="$(readlink "$TARGET" || true)"
  # 兼容相对软链：统一折算成绝对路径再比较
  if [ -n "$current" ]; then
    case "$current" in
      /*) ;;
      *) current="$MODULES_DIR/$current" ;;
    esac
  fi
  if [ "$current" = "$PKG_DIR" ]; then
    link_state="ok"
  else
    link_state="other"
  fi
elif [ -e "$TARGET" ]; then
  link_state="notlink"
fi

case "$link_state" in
  ok)
    printf 'link: 已存在且指向本包，跳过  %s\n' "$TARGET" ;;
  other)
    if [ "$FORCE" -eq 1 ]; then
      if [ "$DRY_RUN" -eq 1 ]; then
        printf '[dry-run] 重新软链 %s -> %s\n' "$TARGET" "$PKG_DIR"
      else
        ln -sfn "$PKG_DIR" "$TARGET"
        printf 'link: 已重指  %s -> %s\n' "$TARGET" "$PKG_DIR"
      fi
    else
      printf 'install: 警告：%s 已存在且指向别处（%s），未改动。确认后可用 --force 重指。\n' \
        "$TARGET" "${current:-<dangling>}" >&2
    fi ;;
  notlink)
    printf 'install: 警告：%s 已存在但不是软链（可能是旧副本），未改动。\n' "$TARGET" >&2
    printf '         如需改用软链：先自行移走该目录，再重跑本脚本。\n' >&2 ;;
  missing)
    if [ "$DRY_RUN" -eq 1 ]; then
      printf '[dry-run] 软链 %s -> %s\n' "$TARGET" "$PKG_DIR"
    else
      ln -s "$PKG_DIR" "$TARGET"
      printf 'link: 已创建  %s -> %s\n' "$TARGET" "$PKG_DIR"
    fi ;;
esac

# ── 3. 追加 cordis.patch.yml 挂载行（幂等） ────────────────────────────────
# 匹配已有 "- id: rfiles"（允许两侧空格与可选引号），匹配则视为已安装。
RFILES_ROW_RE='^[[:space:]]*-[[:space:]]*id:[[:space:]]*["'\'']?rfiles["'\'']?[[:space:]]*$'

if grep -Eq "$RFILES_ROW_RE" "$PATCH"; then
  printf 'patch: 已存在 id: rfiles 行，跳过  %s\n' "$PATCH"
else
  stamp="$(date +%Y%m%d%H%M%S)"
  backup="$PATCH.bak.$stamp"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] 备份 %s -> %s\n' "$PATCH" "$backup"
    printf '[dry-run] 追加 insert 块（id: rfiles / name: dsh-rfiles）\n'
  else
    cp -p "$PATCH" "$backup"
    printf 'patch: 已备份  %s\n' "$backup"
    # 保证文件以换行结尾后再追加，避免破坏上一条的块结构
    printf '\n' >> "$PATCH"
    cat >> "$PATCH" <<'YAML'
# >>> dsh-rfiles >>>
# 远程文件传输伴生插件：手机/远程电脑通过右下角「文件」按钮上传、下载、导出会话日志。
# 卸载：删除本注释块，并移除 profile/node_modules/dsh-rfiles 软链后重启 DSH。
- insert:
    - id: rfiles
      name: 'dsh-rfiles'
# <<< dsh-rfiles <<<
YAML
    printf 'patch: 已追加挂载行  %s\n' "$PATCH"
  fi
fi

# ── 4. 完成提示 ────────────────────────────────────────────────────────────
printf '\n'
if [ "$DRY_RUN" -eq 1 ]; then
  printf 'install: dry-run 结束，未改动任何文件。\n'
  exit 0
fi
printf '安装完成。插件尚未加载，请执行：\n'
printf '  1) 完全退出并重新打开 DSH 桌面端（或重启 dsh web 服务）；\n'
printf '  2) 打开任意会话，页面右下角应出现「文件」按钮；\n'
printf '  3) 运行连通性验证：bash "%s/scripts/verify.sh"\n' "$PKG_DIR"
printf '\n如需回滚：用同名 .bak.<时间戳> 备份覆盖 cordis.patch.yml，\n'
printf '并删除软链 %s 后重启 DSH。\n' "$TARGET"
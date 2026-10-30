# dsh-rfiles 0.1.0 — release checklist

Status: **ready to publish**. The local tarball was validated end to end on
2026-10-30 against DSH 0.2.1-rc.5 on macOS. Nothing was published to npm and no
GitHub repository was created by this task.

## Artifact

| Field | Value |
| --- | --- |
| Package | `dsh-rfiles` |
| Version | `0.1.0` |
| Tarball | `dsh-rfiles-0.1.0.tgz` (52.6 kB, 10 files) |
| SHA-256 | `2674bf1ad7a9c68180d7e29ed5c653ec7330a7626b36a66d2ca385b1e9332fc0` |
| License | MIT (2026, Aperops/dsh-rfiles contributors) |
| Bundle patch | `cordis.patch.yml` → `insert: [{ id: rfiles, name: dsh-rfiles }]` |
| Runtime deps | none (Node built-ins only) |

The tarball is intentionally **not committed** (`*.tgz` is in `.gitignore`);
attach it to the GitHub release instead.

## 1. Build

```bash
cd packages/dsh-rfiles
npm pack
shasum -a 256 dsh-rfiles-0.1.0.tgz
```

Expected: `npm notice total files: 10` and `dsh-rfiles-0.1.0.tgz`.

Tarball contents (verified with `tar tzf`):

```text
package/LICENSE
package/README.md
package/README.zh.md
package/assets/icon.png
package/assets/icon.svg
package/cordis.patch.yml
package/lib/client.js
package/lib/core.js
package/lib/index.js
package/package.json
```

## 2. Install into an isolated profile (verified)

Use an isolated `DSH_HOME` so the real desktop profile is untouched.

```bash
export DSH_HOME=/tmp/dshpub
mkdir -p "$DSH_HOME"
DSH="/Volumes/AMac/software/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"

"$DSH" --profile web --dump-config          # creates profiles/web from the template
"$DSH" plugin --profile web add "$PWD/dsh-rfiles-0.1.0.tgz"
```

Expected package-manager output includes:

```text
dependencies:
+ dsh-rfiles 0.1.0
Done
```

`profiles/web/package.json` then contains:

```jsonc
"dependencies": { "dsh-rfiles": "file:/…/dsh-rfiles-0.1.0.tgz" },
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "dsh-rfiles"
] } }
```

`dsh plugin add` reconciles bundles in 0.2.1-rc.5: the installed package's
`dsh.bundle.patch` is added to `dsh.profile.bundles` automatically.

Bundle row in the composed tree:

```bash
"$DSH" --profile web --dump-config | grep -A2 'id: rfiles'
```

```text
# == dsh-rfiles
- id: rfiles
  name: dsh-rfiles
```

> The profile's own `cordis.patch.yml` stays `[]`. The `id: rfiles` row comes
> from the package-local bundle patch; adding a second insert to the profile
> patch would duplicate the id. Do not edit the profile patch file.

## 3. Runtime smoke test over LAN (verified)

```bash
export DSH_HOME=/tmp/dshpub
"$DSH" web --host 10.33.51.203 --no-open --port 3192 > /tmp/dshpub/server.log 2>&1 &
```

Expected startup log (token is one-time; redact it in reports):

```text
dsh web: listening on 10.33.51.203 over plain HTTP; restrict this port to a trusted proxy or network
dsh web: http://10.33.51.203:3192/?token=<redacted>
```

Exchange the cookie on the **exact authority printed in the log**, then call
health on that same authority:

```bash
URL=$(grep -o 'http://[^ ]*token=[A-Za-z0-9_-]*' /tmp/dshpub/server.log | head -1)
curl -sS -c /tmp/dshpub/jar -b /tmp/dshpub/jar -L "$URL" \
  -o /tmp/dshpub/index.html -w '%{http_code}\n'                       # 200
curl -sS -b /tmp/dshpub/jar -D /tmp/dshpub/health.hdr \
  -o /tmp/dshpub/health.json -w '%{http_code}\n' \
  'http://10.33.51.203:3192/api/rfiles.health'                       # 200
cat /tmp/dshpub/health.json
```

Expected body:

```json
{"ok":true,"version":"1","workspaceRoot":"/Volumes/AMac/vibe/remote"}
```

Also verified in the same run:

| Check | Expected | Actual |
| --- | --- | --- |
| `GET /api/rfiles.sessions` | 200 `{"ok":true,"sessions":[]}` (no active session) | 200, empty list |
| served `index.html` | contains `__DSH_RFILES__` widget injection | 2 markers |
| `--dump-config` | `- id: rfiles` from the bundle layer | present |
| startup log | no `[dsh-rfiles]` / plugin errors | none |

> Pitfall found during validation: the auth cookie is scoped to the authority
> that issued the token. Exchanging the token on `127.0.0.1` and then calling
> `10.33.51.203` (or the reverse) returns `401` / "authentication required".
> Always use the exact URL from that server's startup log.

## 4. Automated checks

```bash
cd packages/dsh-rfiles
node --check lib/index.js
node --check lib/core.js
node --check lib/client.js
node --test test/*.test.mjs        # 33 tests, 33 pass
bash -n scripts/install.sh
bash -n scripts/verify.sh
```

Remote-channel regression (source checkout, paired device required):

```bash
bash scripts/verify.sh --port <dsh-web-port>
```

This covers `/remote/api/rfiles.health`, chunked upload, listing, download with
SHA-256 comparison, Range behavior (SKIP through the proxy), and session-log ZIP
export.

## 5. Security boundaries

- No new authentication: routes are Connection exact Fetch routes; remote
  requests still pass the `/remote` pairing gate, non-owner peers get 403.
- Workspace confinement: absolute paths, `..`, NUL, and symlink escapes are
  rejected (realpath check).
- Staging under `$DSH_HOME/rfile-transfers/<uploadId>/`; no conversation data
  is copied.
- Capability surface: list, download, upload, send. No delete/rename/mkdir/
  terminal/exec.
- Scripts and docs do not print device ids or credentials.

## 6. Known limitations

- **Range over the remote channel**: the third-party proxy drops `Range`,
  `Content-Range`, and `Accept-Ranges`, so remote downloads are whole-file
  `200` only and media seeking is unavailable. Direct `/api` supports single
  range `206`. Upload resume is unaffected (chunk offsets, not HTTP ranges).
- **Workspace only**: the download tab cannot browse outside the session
  workspace. No directory ZIP; the session-log ZIP is the only archive.
- **Active sessions only**: the picker lists sessions from
  `ctx.sessions.list()`; cold sessions require an explicit id through the API.
- **Quotas**: 2 GiB per file, 10 GiB staging, 8 MiB per chunk by default; 413
  when exceeded. All configurable.
- **Cookie-less devices**: native download links need the pairing cookie;
  header-only devices must use the `⤓` fetch+Blob fallback, which is
  memory-bound.
- **iOS/Android**: no full real-device matrix; iOS Safari may preview some file
  types before "Save to Files".
- **Remote-plugin coupling**: changes to @linxin666/dsh-remote-web-ui boot
  globals, header allowlist, or `/remote` semantics require a new
  `scripts/verify.sh` run.
- **Profiles**: web/desktop only (the plugin requires `webServer`,
  `connection`, `sessions`, and related services); not a headless/TUI plugin.
- **Compatibility metadata**: DSH 0.2.1-rc.5's hard gate reads a top-level
  `engines.dsh` (or `@deepseek-ai/dsh*` peer ranges). This package declares
  `>=0.2.1-rc.3` under `dsh.engines.dsh` as required by the publish spec, so
  rc.5 treats it as metadata rather than a hard block. Add a top-level
  `"engines": { "dsh": ">=0.2.1-rc.3" }` before publishing if hard gating is
  wanted.

## 7. Publish checklist

- [x] `package.json`: name/version/description/license/keywords/repository/
      homepage; `main` and `scripts` preserved
- [x] `dsh.engines.dsh = >=0.2.1-rc.3`, `dsh.bundle.patch`; no `dsh.client`
- [x] `files`: lib, cordis.patch.yml, README.md, README.zh.md, LICENSE, assets
- [x] repository-root `cordis.patch.yml` with the single `rfiles` insert
- [x] MIT `LICENSE` (2026, Aperops/dsh-rfiles contributors)
- [x] English `README.md` and Chinese `README.zh.md` (background, features,
      install, usage, security, limitations, verification, uninstall)
- [x] `assets/icon.png` 180×180 PNG (dark rounded tile, folder + up/down arrows)
      and `assets/icon.svg`
- [x] `.gitignore` (`node_modules/`, `*.tgz`, `.DS_Store`, logs, backups)
- [x] unit tests 33/33 and syntax checks
- [x] `npm pack` (10 files) and SHA-256 recorded
- [x] isolated `dsh plugin add` + bundle layer + LAN `:3192` health 200
- [x] cleanup: test server stopped, `/tmp/dshpub` and temp homes removed,
      summary kept at `/tmp/dshpub-summary.txt`
- [ ] create/push GitHub repo `Aperops/dsh-rfiles` (out of scope here)
- [ ] tag `v0.1.0`, attach `dsh-rfiles-0.1.0.tgz` to the release
- [ ] optional: `npm publish --access public`
- [ ] submit to the awesome-dsh-plugin registry
- [ ] real-device matrix (iOS Safari, Android Chrome) and tunnel test
- [ ] re-run `scripts/verify.sh` after each @linxin666/dsh-remote-web-ui upgrade

## 8. Uninstall

```bash
# Web profile
dsh plugin --profile web remove dsh-rfiles

# Desktop (fully quit DSH first)
dsh plugin --profile desktop remove dsh-rfiles
```

Remove `"dsh-rfiles"` from `dsh.profile.bundles` if it is still present, then
restart DSH. Optional cleanup: `rm -rf "$DSH_HOME/rfile-transfers"`; files
already written to `<workspace>/.uploads/` are not removed.

## 9. Validation record

- Date: 2026-10-30 (Asia/Shanghai)
- DSH: `0.2.1-rc.5` (CLI at
  `/Volumes/AMac/software/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`)
- `DSH_HOME`: `/tmp/rfiles-final` (removed after the run)
- Tarball SHA-256: `2674bf1ad7a9c68180d7e29ed5c653ec7330a7626b36a66d2ca385b1e9332fc0`
- Server: `dsh web --host 10.33.51.203 --no-open --port 3192`
- Result: cookie exchange 200; `/api/rfiles.health` 200
  `{"ok":true,"version":"1","workspaceRoot":"/Volumes/AMac/vibe/remote"}`;
  `/api/rfiles.sessions` 200; widget markers 2; no plugin startup errors.
- Cleanup: `:3192` listener gone; `/tmp/rfiles-final` removed;
  `/tmp/dshpub-summary.txt` retained.

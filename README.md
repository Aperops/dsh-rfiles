# dsh-rfiles

A Host-side plugin for the DSH Web GUI that adds two things the paired remote
page cannot do on its own: **send files to the Agent** and **download files
from the workspace**.

It works on top of [@linxin666/dsh-remote-web-ui](https://www.npmjs.com/package/@linxin666/dsh-remote-web-ui)
(the plugin that turns a phone or another computer into a paired DSH client)
and does not modify DSH core or that plugin.

- Chunked, resumable uploads with progress (a file can be a photo, a document,
  or any binary the Agent should receive).
- Uploaded files are delivered to the session as real attachments, through the
  same receipt/prompt path the built-in composer uses.
- A workspace browser with native downloads, plus one-click session-log ZIP
  export.
- Everything is served through the plugin's own exact Fetch routes, so the
  remote page's `/remote` pairing gate keeps working unchanged.

中文文档：[README.zh.md](./README.zh.md)

---

## Why this exists

A paired remote page reaches the Host through the `/remote` prefix. The remote
plugin patches **programmatic** requests (`fetch`, WebSocket, EventSource, and
sub-resource `src` attributes) so they carry the device credential, but it does
not patch **navigation**: `<a download>`, `window.open`, `location` and form
submissions leave the page without the prefix. DSH's `/api` browser-trust fence
then rejects them.

That produces three visible problems on a phone or a second computer:

1. **Downloads fail.** The built-in "download session log" entry is an anchor
   navigation whose URL has no `/remote` prefix, so it is refused by the fence.
2. **Uploads are opaque.** The built-in uploader prefers an XHR inside a Web
   Worker, which is outside the channel; large files give no reliable progress.
3. **No ranges.** The remote proxy forwards only a small header allowlist and
   drops `Range`, `If-Range`, `Content-Range` and `Accept-Ranges`, so HTTP
   resume and media seeking are unavailable over the remote channel.

This plugin sidesteps all three without touching either side:

- uploads are plain `fetch` requests with `File.slice` and an idempotent
  byte offset, so progress and resume are computed locally and do not depend on
  the built-in uploader;
- downloads are served by this plugin's own routes; the widget links to them
  with an explicit `/remote` prefix. Anchor navigation is not rewritten by the
  remote plugin, which is exactly what makes a prefixed URL work;
- `Content-Disposition`, `Content-Length`, `Content-Type`, `ETag` and
  `Last-Modified` are on the proxy's response allowlist, so the browser saves
  the file normally.

## Features

| Feature | Detail |
| --- | --- |
| Send files to the Agent | Multi-select any file type; chunked upload with progress; optional text; delivered as a real attachment and a queued prompt |
| Camera / photo library | `accept="image/*" capture="environment"`; images up to 20 MiB use the official image attachment shape |
| Save to workspace only | Upload without prompting; files land in `<workspace>/.uploads/` (collisions renamed `name (n).ext`) |
| Download workspace files | Breadcrumb navigation and directory listing (up to 500 entries per level); native browser download |
| Session-log ZIP | Streams the official `/api/session.export` (with descendant sessions) and adds the download headers |
| Progress, cancel, resume | Per-chunk progress, cancel, and resume within 24 h after a disconnect or page reload |
| Session picker | Lists active sessions, selects the newest by default; a "remote" badge shows whether the `/remote` channel is in use |
| Desktop and remote | Desktop connections use `/api` (HTTP Range works); remote pages use the `/remote` prefix automatically |

Defaults, all configurable: 8 MiB per chunk, 2 GiB per file, 10 GiB of staging
space. Staging lives in `$DSH_HOME/rfile-transfers/<uploadId>/` and survives a
Host restart, so interrupted uploads can continue.

## Requirements

- DSH `>=0.2.1-rc.3` (the plugin declares this in `dsh.engines.dsh`).
- Node.js 22.19 or newer; DSH ships a compatible runtime, so no extra install
  is needed.
- Optional: [@linxin666/dsh-remote-web-ui](https://www.npmjs.com/package/@linxin666/dsh-remote-web-ui)
  for the paired-remote use case. The plugin also works on a plain desktop
  connection.

## Install

The package is a DSH **bundle**: its `package.json` declares
`dsh.bundle.patch` and it ships `cordis.patch.yml`, which inserts the single
plugin row. Installing it therefore also registers the profile layer.

### From the DSH Web GUI (recommended)

Open **Settings → Plugins** (the Plugins page), then install from the
repository URL, the release tarball URL, or the local directory when working
from a source checkout. Once the package is published to npm, the name
`dsh-rfiles` works there too. Make sure the new bundle is enabled; installing a
bundle enables it by default. Restart DSH if the page asks you to.

### With the CLI

The package is distributed as a prebuilt GitHub Release tarball (there is no
install-time build):

```bash
dsh plugin --profile web add \
  https://github.com/Aperops/dsh-rfiles/releases/download/v0.1.0/dsh-rfiles-0.1.0.tgz
```

From source, or from a local tarball:

```bash
dsh plugin --profile web add git+https://github.com/Aperops/dsh-rfiles.git
dsh plugin --profile web add /path/to/dsh-rfiles-0.1.0.tgz
```

Installing a bundle also registers its layer, so the profile's
`dsh.profile.bundles` list gains `dsh-rfiles` automatically; no manual patch
edit is needed. If you maintain the profile by hand, add `"dsh-rfiles"` to
`dsh.profile.bundles` in `$DSH_HOME/profiles/web/package.json` and restart DSH.

Confirm the composed tree contains the `rfiles` row:

```bash
dsh --profile web --dump-config | grep -A2 rfiles
```

> Once the package is published to npm, `dsh plugin --profile web add dsh-rfiles`
> works as well. The release tarball above is the supported path today.

### Confirm it loaded

Open any session; a **Files** button appears in the lower-right corner of the
page. Host-side check (needs a browser-auth cookie for the `/api` fence):

```bash
curl -s http://127.0.0.1:61298/api/rfiles.health
# {"ok":true,"version":"1","workspaceRoot":"..."}
```

If the button is missing, see [Troubleshooting](#troubleshooting) below.

## Usage

Open the **Files** button. The panel has two tabs.

### Upload / send to the Agent

1. Pick **Send to Agent** (default) or **Save to workspace**.
2. Choose files, or use **Camera / library** to take a photo.
3. Upload starts automatically, in 8 MiB chunks, with a progress bar. Failed or
   interrupted uploads can be retried; choosing the same file again within 24 h
   resumes from the last acknowledged offset.
4. In **Send to Agent** mode, add optional text and press **Send to Agent**. The
   file arrives as a real attachment (images up to 20 MiB as image content) and
   a prompt is queued on the selected session.
5. In **Save to workspace** mode the file is written to
   `<workspace>/.uploads/` and no prompt is sent.

### Download

1. The **Download** tab starts at the workspace root; folders come first.
2. Click a file to save it with the browser's native download. Links on a remote
   page already carry the `/remote` prefix.
3. If a browser blocks the navigation or the device is paired without cookies
   (header-only credential), use the **⤓** button on the row: it fetches the
   bytes and saves a Blob instead (fetch is rewritten by the remote channel and
   carries the device credential).
4. **Download session log ZIP** exports the current session, including
   descendant sessions and attachment objects.

Only paths inside the session workspace are listed or served. There is no
delete, rename, mkdir, or directory zip.

## Configuration

All limits have defaults; override them in the profile's
`cordis.patch.yml` (this is the profile's user layer, applied after the bundle
layer):

```yaml
- id: rfiles
  config:
    chunkBytes: 8388608        # bytes per chunk (default 8 MiB)
    maxFileBytes: 2147483648   # per-file limit (default 2 GiB)
    stagingBytes: 10737418240  # total staging limit (default 10 GiB)
    uploadDir: .uploads        # workspace-mode destination
    transferRoot: ''           # staging root; empty = $DSH_HOME/rfile-transfers
```

## Security model

- **No new authentication.** Every route is a Connection exact Fetch route.
  A desktop owner browser is authorized by the normal browser credential; a
  remote request must first pass the `/remote` pairing gate (device cookie or
  `x-dsh-remote-device`), after which the proxy calls `/api` with its own
  process credential. Non-owner peers still receive 403.
- **Workspace confinement.** Listing, downloading and upload destinations are
  resolved inside the session workspace; absolute paths, `..`, NUL bytes and
  symlink escapes are rejected (realpath check).
- **Staging only.** `$DSH_HOME/rfile-transfers/<uploadId>/` holds the bytes and
  metadata of in-flight uploads only.
- **Minimal surface.** List, download, upload, send. No delete, rename, mkdir,
  terminal, or code execution.
- Scripts and documentation never print device ids or credentials.

## Known limitations

- **HTTP Range does not work through the remote proxy** (it drops `Range` and
  related headers), so remote downloads are full-body transfers and video
  seeking is unavailable. Desktop `/api` connections support single-range 206
  responses. Upload resume is unaffected because it uses chunk offsets, not
  HTTP ranges.
- Only the workspace tree is browseable; there is no directory archive
  (the session-log ZIP is the exception).
- The session picker lists active sessions only; cold sessions need an
  explicit id through the API.
- Through Cloudflare tunnels, uploads are 8 MiB requests (which avoids a
  single-request body cap) but total time and traffic are still limited by the
  tunnel; Quick Tunnel availability is not guaranteed.
- `present`-card "open on host" actions are meaningless on a phone; browse the
  workspace in the **Download** tab instead.
- If @linxin666/dsh-remote-web-ui changes its channel behavior (boot global
  name, header allowlist, `/remote` semantics), this plugin needs a regression
  run. Re-run `scripts/verify.sh` after upgrading it.
- iOS Safari and Android browsers have not been tested as a full device matrix;
  see the verification notes in the source checkout.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No **Files** button | Fully restart DSH (patches are read at boot); hard-refresh the page (the widget is injected into the index head); check that the profile manifest lists the `dsh-rfiles` bundle and that `node_modules/dsh-rfiles` exists; search the console for `__DSH_RFILES__` / `[dsh-rfiles]`; a missing required service in `inject` prevents the plugin from mounting. |
| Panel says "open a session first" | The picker lists active sessions only. Open a session in the GUI, then press refresh in the panel. |
| Upload 401/403 | Pairing expired or the device credential is missing: re-pair. Confirm requests go to `/remote/api/rfiles.*`; if they still go to `/api/...` the remote boot patch did not run. |
| Download 401/403 (including session-log ZIP) | An anchor navigation can only authenticate with the pairing cookie. Devices paired without cookies must use the **⤓** button. |
| Clicking a file does nothing | The browser blocked the download; use **⤓**; on iOS a preview may appear first ("Save to Files"). |
| Upload stalls | Inspect the chunk requests: `409 offset-mismatch` is the normal resume signal (the client continues from `received`); `413` means a quota; a dropped tunnel can be resumed by reopening the panel. |
| `/api/rfiles.health` returns 404 | The plugin is not mounted or DSH was not restarted. |
| Port is not 61298 | The DSH Web URL in the startup log shows the format/port you should use. |

## Verification

From a source checkout (scripts are not part of the npm tarball):

```bash
cd dsh-rfiles

# unit tests: path confinement, ranges, chunk store, routes
node --test test/

# syntax
node --check lib/index.js && node --check lib/core.js && node --check lib/client.js

# live connectivity check against the running Host through the real remote channel
bash scripts/verify.sh                 # port defaults to 61298
bash scripts/verify.sh --port 61299 --require-range
```

`verify.sh` uses a paired device credential (never printed) and checks health,
a chunked upload, listing, a download with sha256 comparison, a Range request,
and session-log export. Remote Range is reported as SKIP because the proxy
drops the header; pass `--require-range` to turn that into a failure.

## Uninstall

1. In **Settings → Plugins**, disable and remove `dsh-rfiles`, or run
   `dsh plugin --profile web remove dsh-rfiles`.
2. Remove `"dsh-rfiles"` from `dsh.profile.bundles` if it is still listed.
3. Restart DSH.
4. Optional cleanup: `rm -rf "$DSH_HOME/rfile-transfers"` (stale staging) and
   the workspace `.uploads/` directory (not removed automatically).

## Development

The package is plain ESM with no build step and no runtime dependencies.

```bash
cd dsh-rfiles
node --test test/                       # 33 tests
node scripts/mock-server.mjs --port 4399
# open http://127.0.0.1:4399/mock.html
# remote-prefix mode: http://127.0.0.1:4399/mock.html?remote=1
```

- `lib/index.js` — Cordis plugin: routes, config, widget injection.
- `lib/core.js` — pure logic: path confinement, Range parsing, download
  headers, chunk store.
- `lib/client.js` — the browser widget (classic IIFE, Shadow DOM, mobile
  drawer); injected by the Host into the index head.
- `CONTRACT.md` — the HTTP contract (repo only; keep it in sync with tests).
- `scripts/install.sh` — profile-local install from a source checkout
  (symlink + patch row), with `--dry-run`.
- `scripts/verify.sh`, `scripts/mock-server.mjs` — verification tools.

## License

MIT

# dsh-rfiles

A host-side DSH bundle plugin that adds a **文件** (Files) panel to the Web GUI:
upload files from a phone or computer, send them to the Agent, save them in the
session workspace, and download workspace files or a session-log ZIP.

中文文档：[README.md](./README.md)

## Why this exists

The motivating need was **missing upload and download entry points in the paired
remote UI**.
`dsh-rfiles` supplies those entry points and a file-transfer workflow alongside
[@linxin666/dsh-remote-web-ui](https://www.npmjs.com/package/@linxin666/dsh-remote-web-ui).
It does not modify DSH core or the remote plugin, and also works on a local
desktop connection without that plugin.

Remote UI capabilities and transport behavior vary by version. This README does
not claim that native uploads or downloads fail in every upstream version, or
that a historical proxy header allowlist still applies today.

## Features

| Feature | What it does |
| --- | --- |
| Send to Agent | Select multiple files, upload with per-chunk progress, then send real attachments and optional text as a queued prompt to the selected session |
| Save to workspace | Save under `<workspace>/.uploads/` by default, without sending a prompt; duplicate names become `name (n).ext` |
| Camera / library | Open the device image picker or camera where supported; PNG, JPEG, WebP and GIF files up to 20 MiB use image attachments; other files use file receipts |
| Workspace downloads | Browse folders and breadcrumbs, up to 500 entries per directory; download a file with the browser, with a fetch/Blob fallback |
| Session-log ZIP | Export the selected session, descendant sessions and attachment objects through DSH's session export API; this is not a ZIP of the workspace |
| Interrupted uploads | Resume from the host's acknowledged byte offset when the browser record and host staging data are still available |

The panel lists active sessions and initially selects the newest one. **Check
its session selector before uploading, sending or downloading**; it need not
match the conversation currently visible behind the panel.

## Requirements and installation

For `dsh-rfiles` **0.1.0**, `package.json` declares DSH `>=0.2.1-rc.3` and
Node.js `>=22.19.0`. The repository's release verification records DSH
`0.2.1-rc.5` on macOS on 2026-10-30; that is not a compatibility guarantee for
every later version or mobile browser.

Install on the **DSH host**, in the profile serving your Web GUI. For the paired
remote workflow, install and configure `@linxin666/dsh-remote-web-ui` separately
and pair your device first. Local desktop use does not require it.

In **Settings → Plugins**, install `dsh-rfiles` from npm and ensure the bundle
is enabled. Or use the CLI (replace `web` if you use another profile):

```bash
dsh plugin --profile web add dsh-rfiles
```

Alternatives, with no build step:

```bash
# Published release tarball
dsh plugin --profile web add \
  https://github.com/Aperops/dsh-rfiles/releases/download/v0.1.0/dsh-rfiles-0.1.0.tgz

# Source repository, or a local tarball
dsh plugin --profile web add git+https://github.com/Aperops/dsh-rfiles.git
dsh plugin --profile web add /path/to/dsh-rfiles-0.1.0.tgz
```

The bundle's `cordis.patch.yml` registers the `rfiles` plugin row. Bundle
installation registers its profile layer; no manual patch edit is normally
needed. Restart DSH after installation and refresh the local or paired remote
page. Open a session, then click **文件** (Files) in the lower-right corner. The panel
labels in 0.1.0 are Chinese; the steps below include their exact text.

## Usage

### Upload and send to the Agent

1. Open **文件 → 上传** (Upload), check the session selector, and choose
   **发送给 Agent** (Send to Agent, the default).
2. Choose one or more files, or use **拍照 / 相册** (Camera / library).
   Selection starts the upload automatically.
3. Wait for the upload to finish. At this point the files are staged on the
   host; **they have not yet been sent to the Agent**.
4. Add optional text and click **发送给 Agent**. The plugin submits the
   attachments and a queued prompt to the selected session. Image processing
   still depends on the selected model's capabilities.

### Save without sending a prompt

1. Choose **只存入工作区** (Save to workspace) **before** selecting files.
2. After upload completion, check the saved path shown for each file. The default
   destination is `<workspace>/.uploads/`; duplicate names are renamed.
3. No attachment or prompt is sent. You can later refer to the saved path in a
   conversation. To send it through the attachment workflow, select the file
   again in **发送给 Agent** mode; switching modes does not convert completed uploads.

### Resume an interrupted upload

Use **重试** (Retry), or reopen the panel and select the same file again in the
same browser/site, session and upload mode. Resume records use the file's name,
size and last-modified time and expire 24 hours after their last update. The
host staging data must still exist; clearing browser storage, changing the file
or losing staging data can require a fresh upload. Host restart alone does not
erase the on-disk staging data.

Progress advances when a chunk is acknowledged, not continuously within each
chunk. **取消上传** cancels the queue and attempts to delete the current upload's
staging data; it is not a pause button. Upload resume uses byte offsets and does
not depend on HTTP Range download support.

### Download files or a session-log ZIP

1. Open **下载** (Download) and confirm the selected session.
2. Browse the workspace and click a file for a native browser download. Remote
   download links explicitly include `/remote`.
3. If navigation is blocked or pairing uses a header credential without a
   cookie, click **⤓** on the file row to save through fetch. This fallback
   buffers the entire response as a Blob, so prefer native downloads for large files.
4. Use **下载会话日志 ZIP** for a session export. Its **通过请求保存** button is
   the corresponding fetch fallback. A browser may show a preview first; use
   its save action to keep the file locally.

Only the selected session's workspace is browsable. There is no delete,
rename, directory creation or arbitrary directory ZIP feature.

## Limits and configuration

Defaults: **8 MiB per chunk, 2 GiB per file, 10 GiB staging budget**. Staging
is stored at `$DSH_HOME/rfile-transfers/<uploadId>/`. Completed files waiting
to be sent also occupy staging space. A 24-hour browser resume record is not
a promise that host staging will be automatically deleted after 24 hours.

Optional overrides in the profile's user `cordis.patch.yml` layer:

```yaml
- id: rfiles
  config:
    chunkBytes: 8388608
    maxFileBytes: 2147483648
    stagingBytes: 10737418240
    uploadDir: .uploads
    transferRoot: '' # default: $DSH_HOME/rfile-transfers
```

In 0.1.0 the widget caps its chunk size at 64 MiB. Tunnel limits, browser
memory and host disk space still apply; chunking does not guarantee tunnel
availability or unlimited transfer time.

The plugin's download route supports single HTTP byte ranges. End-to-end remote
Range support depends on the installed proxy and tunnel. The 2026-10-30 release
notes recorded a whole-file response / Range SKIP with that tested setup; they
do not establish the behavior of current upstream releases. Check the actual
response status and `Content-Range` after upgrades. No remote download-resume
or media-seeking guarantee is made here.

## Authentication and troubleshooting

The plugin uses DSH's existing connection authorization. Remote requests must
pass the pairing gate; it adds no separate login. Paths are confined to the
session workspace, including checks against traversal and symlink escapes.

| Symptom | Check |
| --- | --- |
| No **文件** (Files) button | Confirm the bundle is enabled in the serving profile, restart DSH and hard-refresh; inspect startup/browser errors for `dsh-rfiles` |
| No session in the panel | Open a session in the GUI, then refresh the panel's session list |
| Upload 401/403 | Check pairing and whether remote requests reach `/remote/api/rfiles.*`; re-pair if needed |
| Native download 401/403 or no response | Use **⤓** for files or **通过请求保存** for ZIP; navigation cannot attach a header-only pairing credential |
| Upload error | `409 offset-mismatch` lets the client reconcile the acknowledged offset; `413` indicates a size or quota limit; retry after restoring connectivity |
| Image rejected | Check the model's image support; only the image formats and size described above use image attachments |

## If upstream makes this plugin unnecessary

This is a supplement to missing upstream capabilities and entry points. If DSH
or `dsh-remote-web-ui` later provides the workflows you need natively, you may
no longer need `dsh-rfiles`. There is no promised date or upstream commitment
implied here, and this does not mean the plugin is already unnecessary.

After upgrading, verify native upload/send, workspace-only saving, file
download and session export as applicable on your actual devices and paired
connection. Include large files and interrupted uploads if you rely on them.
Once native behavior meets your needs, disable the plugin and check the native
flow again before removing it.

### Safe disable / uninstall

1. Finish pending uploads and send queued attachments you want to keep. Confirm
   saved workspace files and any required local downloads before disabling.
2. In **Settings → Plugins**, disable `dsh-rfiles` to evaluate the native flow.
   To uninstall, remove it there or run `dsh plugin --profile web remove dsh-rfiles`.
3. If a manually maintained profile still lists it in `dsh.profile.bundles`,
   remove that entry. Restart DSH and refresh the page.
4. Treat user data separately from plugin removal. `.uploads/` contains saved
   workspace files, not just temporary data; preserve or back it up. Only clean
   the configured transfer staging directory after inspecting it and confirming
   no unfinished or unsent upload is needed. No workspace deletion is required.

## Development and verification

Plain ESM, no build step or runtime dependencies. From a source checkout:

```bash
node --test test/
node --check lib/index.js
node --check lib/core.js
node --check lib/client.js
node scripts/mock-server.mjs --port 4399
# Open http://127.0.0.1:4399/mock.html (or append ?remote=1)
```

The mock UI and unit tests are not a real-device compatibility matrix.
`scripts/verify.sh` is a separate **live integration check**: it uses paired
credentials and creates a test upload on a running host, then checks listing,
download hash, Range and ZIP export. It is not read-only. A 200 response to its
Range request is reported as SKIP; `--require-range` makes that a failure. The
script's historical proxy explanation is not proof of the cause on a new setup.

See [CONTRACT.md](./CONTRACT.md) for API details and
[RELEASE-CHECKLIST.md](./RELEASE-CHECKLIST.md) for historical release evidence.
`lib/index.js` registers routes and injects `lib/client.js`; `lib/core.js`
implements paths, ranges and staging. Development scripts are not included in
the npm tarball.

## License

This revision is licensed under the **GNU General Public License, version 3
only (GPL-3.0-only)**. See [LICENSE](./LICENSE) for the full terms and
[NOTICE](./NOTICE) for attribution and the historical MIT notice.

Commercial use and private modification are allowed. When distributing modified
versions, you must license them under GPLv3 and provide recipients with the
Corresponding Source as required by the license. Private modifications do not
have to be published on the internet. The full license governs the distribution
requirements.

This change applies to this revision and subsequent releases based on it.
Earlier copies obtained under MIT, including the published **v0.1.0**, retain
their MIT permissions. Those grants are not retroactively withdrawn, and old
tags and published packages are not being replaced. The repository version has
not been bumped; this license change is not a republication of v0.1.0.

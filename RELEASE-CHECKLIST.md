# dsh-rfiles release checklist

## Verified 2026-10-30

- [x] `npm pack` produces `dsh-rfiles-0.1.0.tgz` (10 files, ~52 KB).
- [x] Isolated bundle install works end to end (not a manual symlink):
  ```sh
  DSH_HOME=/tmp/dshpub dsh --profile web --dump-config   # creates the profile
  DSH_HOME=/tmp/dshpub dsh plugin --profile web add ./dsh-rfiles-0.1.0.tgz
  # profile package.json gains `dsh-rfiles` in dependencies AND dsh.profile.bundles
  DSH_HOME=/tmp/dshpub dsh web --host 127.0.0.1 --no-open --port 3193
  # token exchange, then:
  GET /api/rfiles.health   -> 200 {ok:true,version:"1"}
  GET /api/rfiles.sessions -> 200 {ok:true,sessions:[]}
  served index contains __DSH_RFILES__ (client widget injected)
  ```
- [x] Unit tests: `node --test test/` -> 33/33 pass.
- [x] Live instance (0.2.1-rc.3 + remote-web-ui 0.4.8): `/remote/api/rfiles.health` 200,
  chunked upload -> download sha256 match, `/remote/api/rfiles.export` 200 application/zip,
  `/pair-app` HTML contains the injected widget.

## Publish steps (maintainer)

1. `git push` main, tag `v0.1.0`, attach `dsh-rfiles-0.1.0.tgz` to the GitHub release.
2. (Optional, recommended by the registry) publish to npm: `npm publish --access public`.
   Without npm, the registry entry uses the `tarball:` field pointing at the release asset.
3. Open one PR to `awesome-dsh-plugin/awesome-dsh-plugin` adding
   `data/plugins/Aperops__dsh-rfiles.yml` (repo must be at least one day old).

## Known limits

- Through the third-party `/remote` proxy, `Range`/`Content-Range`/`Accept-Ranges` are dropped:
  remote downloads are whole-file 200 only; resume works on the direct `/api` origin.
- Cookie-less paired devices fall back to fetch+blob saving (memory-bound).
- Defaults: max file 2 GiB, staging 10 GiB.

## Uninstall

- Desktop profile: remove the `dsh-rfiles` bundle via the app's plugin manager (or the
  `dsh plugin --profile desktop remove dsh-rfiles` route where available), then restart.
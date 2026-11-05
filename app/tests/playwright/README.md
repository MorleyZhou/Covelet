# Real extension browser tests

From `app/`:

```sh
npm ci
npx playwright install chromium
npm run build:unpacked
npm run test:e2e
```

`npm run test:e2e:smoke` checks only extension loading and native Chrome APIs.
`npm run test:e2e -- --headed` shows the test-owned browser; `--grep` selects cases.
`npm run test:e2e:report` opens the saved report.

The fixture loads the existing `dist/extension/` directory using Playwright's
official Chromium channel and a fresh persistent profile for each test. It checks
the service worker's real runtime manifest and ID before opening the real
`chrome-extension://…/newtab.html`. It does not load the web demo, mock `chrome`,
add manifest permissions, connect to personal Chrome/Edge profiles, or change the
extension version. Temporary profiles are closed and removed after the test.

## In-place upgrades from 0.2.2

From `app/`, after `npm run build:unpacked`:

```sh
npm run test:upgrade
```

This downloads the original public `v0.2.2` ZIP with `gh`, pins its SHA-256,
and verifies every extracted file and the exact file set. `gh` must be
available; CI provides its read-only GitHub token. The test first creates
synthetic data through that release's UI, shuts its browser down, replaces
only the program in the same absolute directory, and reopens the entire same
profile with the current build. Runtime versions and the unchanged native
extension ID are checked. The nonextractable IndexedDB device key and original
encrypted records are retained, not copied into a new installation.
Chrome's native CDP `Extensions.loadUnpacked` installer applies the replacement;
relaunching with changed files alone can retain the old Service Worker cache.
The suite verifies that the executing new background has removed the legacy
clock-alarm listener. It never uninstalls the extension or clears its storage.

To test the already published 0.3.0 package as a separate control:

```powershell
node tests/upgrade/prepare-packages.mjs --release
$env:COVELET_UPGRADE_TARGET = 'release'
npx playwright test --config tests/playwright-upgrade.config.mjs
Remove-Item Env:COVELET_UPGRADE_TARGET
```

The published control also has a pinned ZIP digest; a changed release asset
must be inspected before changing that pin. No historical ZIP or production
manifest is modified. Reports are in `output/playwright/covelet/upgrade/`.
The published control uses `output/playwright/covelet/upgrade-release/`.
Original and replacement-phase traces are retained on failure. All profiles,
passwords and HTTPS responses are synthetic; no local QA credentials are read.

The suite covers seed retirement and recovery, edited/private content, notes,
image bytes, old clock data, genuine pending ciphertext, whole-group conflicts,
offline operation, and an aborted real IndexedDB migration transaction.
Read-only inspection decrypts records with the original nonextractable key;
Blob content is compared by bytes or SHA-256. Only the migration marker's
transaction is deliberately aborted. Offline mode rejects even allowed
fixture responses and checks both `navigator.onLine` and a failed HTTPS probe.
These tests prove application-data compatibility; they do not certify store
signatures, store delivery, or real cloud service availability.

Only the legacy-reminder case pregrants the old declared optional notification
permission by moving it to required permissions in its temporary old copy.
The pinned archive, extracted cache and new production manifest stay unchanged.
This lets the old UI create a real countdown alarm through native Chrome APIs;
it does not validate the native permission bubble or OS notification delivery.
All other upgrade cases run the unmodified historical manifest. The browser's
unsafe-extension-debugging flag is confined to these synthetic QA profiles and
only enables its native CDP installer.

The network fixture accepts only the exact Bing wallpaper/search routes and a
dedicated WebDAV path under the already granted Bing origin. Every other HTTP(S)
request is blocked and fails the test. WebDAV stores encrypted bytes in memory.
The two-profile conflict case uses the production setup, encryption, storage,
sync, version-choice and CAS code; it does not replace the sync engine.

The suite also exercises full-backup image bytes and note recovery, cancelled
and stale restores, invalid-file preview replacement, consecutive add/edit
focus, folder rename Escape, real pointer grouping/layout, keyboard save and
two-tab edit protection. UI image fixtures enter through the supported backup
file picker; they never write application storage directly.

Reports, screenshots, request summaries and failure traces are saved under
`output/playwright/covelet/` at the repository root, outside tracked source.
Screenshots use only generated fixture data. The separate browser-test workflow
runs this suite on pull requests; it does not deploy, release or submit stores.

This is a simulated-network integration test, **not** a true-cloud pass. It does
not establish real WebDAV TLS behavior, a storage provider's quota/rate limits,
browser permission-prompt acceptance, native Chrome/Edge differences, or an OS
IME candidate window. The composition cases check the actual extension input
with composition events and real keyboard Enter. Real service credentials and
permission dialogs require separate acceptance testing.

The setup follows the [official Playwright extension guide](https://playwright.dev/docs/chrome-extensions).

## Separate live suite

Current user scope is **GitHub only**. `tests/live/live-session.mjs` has an explicit
provider allowlist; R2/GitLab/OSS are not contacted even if an old local entry is
enabled. Deterministic protocol/unit tests still cover all adapters.

From `app/`, with the ignored local QA configuration prepared:

```powershell
$env:COVELET_QA_CONFIG = (Resolve-Path ../output/playwright/covelet/live-config.local.json).Path
npx playwright test --config tests/playwright-live.config.mjs
```

The live suite uses a temporary build copy with only the exact storage origin
pre-granted; it does not validate the native permission prompt. It uses two
isolated Chromium profiles, not physical machines. Credentials stay out of
traces, screenshots and automatic ARIA failure snapshots. Do not override the
live reporter/recording settings. Recheck Playwright's snapshot guard on upgrades.
Locator assertion failures are rethrown as redacted plain errors so their
matcher-attached form snapshots cannot reach the runner. `npm run test:live-privacy`
checks both plaintext and password fields with fake values and a deliberately
failed text assertion; it cannot load the real QA configuration and runs in CI.

The closeout case uploads two decodable PNGs larger than 256 KiB and a note,
compares persisted image bytes after true-cloud transfer, edits offline and
retries, then discards a real successful chunk-write response. After browser
restart it verifies an exact ciphertext read, unchanged image/note content and
no second write at that object. Both unchanged-sync and conflict-choice cases
remain separately covered. GitHub's test branch and local profiles are removed.

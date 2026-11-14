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

For the 0.6 command palette, structured search and note-workflow batches, run
`npx playwright test --config tests/playwright-batch.config.mjs` after rebuilding
the unpacked extension. These cases cover the real palette, query conditions,
saved filters, privacy, editor/IME event ownership, explicit engine keywords and
all eight languages at 390×540. The note cases compare exported records before
and after transient search, verify far-down matches against every clipping
ancestor, and cover append, cancellation, stale targets and size limits. Reports
and screenshots go to `output/playwright/covelet/0.6-batches/` at the repository
root; `COVELET_QA_BATCH=0.5.4` adds a separate batch subdirectory. This configuration
does not replace the complete regression suite.

`widget-pins.spec.mjs` covers independent pins on different desktops, live note
and smart-list changes, missing targets, deletion/restoration, unconfigured list
selection and privacy changes from another tab. Its recovery fixture creates an
explicit note-ID collision through supported backup pickers and watches the
referenced card for transient exposure of the unrelated record. Template
reference redaction remains unit-tested; there is no active template-sharing UI.

`reading-filters.spec.mjs` imports synthetic reading/tag combinations through the
complete-backup picker, then checks real bulk tag/date actions, stale cross-tab
selections, all/any/excluded tag matching, complete-backup round trips, local
midnight date changes, pinned-list updates and already-locked tag visibility.
The bulk and saved-view controls are exercised in all eight languages at 390×540.

The note-capture cases grant only `https://capture.example/*` in a temporary test
copy and intercept that page and its exact icon probes. The actual browser
selection is read by `chrome.scripting` while the popup runs in an inactive tab.
This verifies the real capture path, not a native toolbar gesture or activeTab
permission prompt. The production manifest remains unchanged.

On Windows, `COVELET_NATIVE_BROWSER=chrome` or `edge` selects the installed native
browser through isolated profiles and CDP extension loading. The default remains
bundled Chromium. `COVELET_QA_BATCH=0.5.4-chrome` or `0.5.4-edge` keeps native reports
separate; the actual browser version is recorded as a test annotation.

The fixture loads the existing `dist/extension/` directory using Playwright's
official Chromium channel and a fresh persistent profile for each test. It checks
the service worker's real runtime manifest and ID before opening the real
`chrome-extension://…/newtab.html`. It does not load the web demo, mock `chrome`,
add manifest permissions, connect to personal Chrome/Edge profiles, or change the
extension version. Temporary profiles are closed and removed after the test.

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
browser permission-prompt acceptance or an OS IME candidate window. Bundled
Chromium runs alone do not establish native Chrome/Edge behavior; the optional
native runs above record that separately. The composition cases check the actual extension input
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

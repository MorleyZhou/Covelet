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

The network fixture accepts only the exact Bing wallpaper/search routes and a
dedicated WebDAV path under the already granted Bing origin. Every other HTTP(S)
request is blocked and fails the test. WebDAV stores encrypted bytes in memory.
The two-profile conflict case uses the production setup, encryption, storage,
sync, version-choice and CAS code; it does not replace the sync engine.

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

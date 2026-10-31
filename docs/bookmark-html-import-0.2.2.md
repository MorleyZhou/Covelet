# 0.2.2: local bookmark HTML import

Entry: **Settings → Data → Import URLs and bookmark HTML → Import bookmark HTML file**
(简体中文：**设置 → 数据 → 导入网址与书签 HTML → 导入书签 HTML 文件**).
The selectable preview shows destinations, rejected addresses and duplicate counts before confirmation.

## How to import

1. In Chrome or Edge, open the bookmark/favorites manager and choose Export bookmarks/favorites. In Firefox, open Library → Import and Backup → Export Bookmarks to HTML. Save the HTML file locally.
2. Open the entry above, choose the file, and review the folders, selected links, invalid addresses and skipped duplicates.
3. Leave **保留本地 / keep local** enabled, choose the destination and confirm. The summary reports added and skipped links; Undo reverses this import.

## Behavior

- Reads the picked file with `File.text()` and parses its UTF-8 Netscape HTML in a detached inert template. No markup is inserted into the page. HTML entities and internationalized URLs are preserved through the existing URL validator.
- Supports Chrome Bookmarks bar, Firefox Bookmarks Toolbar / Other Bookmarks (including `DD` folder descriptions), and Edge Favorites bar / Other favorites. Nested folders become named paths such as `Bookmarks bar / 开发 / 参考`, matching Covelet's existing single-level desktop folder model. Empty source folders are omitted.
- Conflict default is **保留本地 / keep local**: `prepareImport` retains `skipDuplicates = true`. Normalized URLs are compared across the entire desktop and the selected batch. Existing IDs, names, artwork, positions and other metadata stay intact. Duplicate-only folders are not created. Disabling the checkbox appends duplicate copies; it never overwrites an existing entry.
- Preview and completion both report skipped duplicates. Invalid / unsupported URLs (including `javascript:`, `data:`, browser-internal URLs and credential-bearing URLs) remain in the rejected-address list and never become desktop links.
- New sites use name-derived letter icons. The bookmark apply call passes `hydrateIcons: false` to the existing import commit helper, bypassing its native-favicon / HTTP image acquisition. Backup and desktop-template icon handling is unchanged.
- Reuses revision-checked `saveState` and the existing encrypted local IndexedDB store, desktop placement, hidden-folder guards and Undo. No new persistence namespace, account, upload endpoint, permission or analytics dependency.
- Bounded to 5 MiB of file / UTF-8 content, 2,000 source folders + valid links, 2,000 invalid links, the existing 2,000 stored entries, and 64 structural traversal levels. Deep nesting and malformed / empty / unrelated files get localized errors. Rejecting a replacement file clears the prior preview so it cannot be imported accidentally.
- New UI and error strings have explicit en, zh-CN (source), zh-TW, ja, ko, de, fr and ru coverage. Marketing availability changes are limited to `migrate.bookmarks` in the eight `site/i18n/*.json` files; the reachable application entry ships in this same change.

## Current candidate verification

See [0.2.2 evidence](verification/0.2.2/README.md): 473 unit tests pass; the unpacked-extension import checks retain 0 HTTP(S) and 0 native-favicon requests during import. Current package and manifest are **0.2.2**.

## Prior implementation evidence (before 0.2.2)

These counts describe the original import change, not acceptance of the current candidate.

### Fixtures and automated verification

`app/tests/fixtures/bookmarks/{chrome,firefox,edge}.html` are synthetic, sanitized representations of browser Netscape exports, not private user exports or claims of a live browser export session. They retain the Netscape doctype, charset META, export timestamps, toolbar flags, nested DL/DT/H3/A structure and browser-specific attributes. Firefox includes smart bookmarks, IDNs and descriptions; Chrome includes cross-folder duplicates and encoded query parameters; Edge includes nested favorites and a nondefault HTTP port. The original `bookmarks.html` acceptance fixture remains covered.

From `app/`:

```sh
npm test
npm run build:unpacked
npm run check:extension
npm run test:bookmarks
```

- `npm test`: **468 passed, 0 failed**, including 13 bookmark tests for all three fixtures, bad/empty/oversize files, URL rejection, limits, explicit DT end tags, safe literal titles, duplicate preservation/selection, local save/reload and eight-language coverage. jsdom 26.1.0 is a pinned development-only HTML5 DOM dependency; production parsing still uses the browser DOM.
- `build:unpacked`: production unpacked extension built against unchanged packaged WASM, without release ZIP creation.
- `check:extension`: static package checks passed; package / manifest version remains **0.2.1**.
- `test:bookmarks`: real isolated unpacked Chromium extension with actual `DOM.setFileInputFiles` file selection, no local application server and no real accounts. Imports **11 valid sites**, checks all three browser previews, rejected files and unsafe URLs, duplicate default/counts, failed replacement, desktop folder/link visibility, stable local IDs/content after reload, zh-CN/English errors, and desktop/narrow modal geometry. Runtime exceptions fail the run. The fixture profile is removed afterward. Use `COVELET_CHROMIUM=/path/to/chrome` if needed (default `/opt/ungoogled-chromium/chrome`). Evidence regenerates under ignored `app/output/0.2.2-bookmarks/` as screenshots and `results.json`.

## Zero-outbound verification

Static review follows `readBookmarkFile → parseBookmarks → prepareImport → commitImportedNavigation(..., { hydrateIcons: false }) → saveState`. The reader, parser and plan use no fetch/XHR, file upload, image-source binding, homepage recognition or permission request. `saveState` only validates and commits the local encrypted envelope under the existing revision lock. The generic import helper's image preparation is explicitly disabled for bookmark/URL imports.

The unit round-trip installs throwing `fetch`/XHR spies, includes script/image/iframe/stylesheet markup, and asserts no calls. The Chromium harness intercepts **every HTTP(S) request** before navigation and records `Network.requestWillBeSent`, including image requests; it also records native `/_favicon/` lookups. From opening Settings through file reads, previews, confirmation and desktop rendering, it asserts **0 HTTP(S) requests and 0 native-favicon requests**. Reload also performs no requests to imported sites or their image hosts. The existing initial Bing wallpaper request is separately reported and intercepted (503); it precedes the measured import interval and no network response reaches the app. There are **0 Covelet business requests**. This does not claim the entire extension is always network-free: existing wallpaper and separately enabled user-storage synchronization retain their existing behavior.

## Scope and limits

Draft only: no merge, release, tag or store submission. The current package version is 0.2.2. No WeTab / Infinity / Arc importer, tool-pack restoration, tabs / readingList work, Covelet server/account, OAuth relay or analytics. Chromium runtime acceptance and synthetic Chrome/Firefox/Edge export-format coverage are verified; live Firefox/Edge extension installations and real personal export collections were not exercised.

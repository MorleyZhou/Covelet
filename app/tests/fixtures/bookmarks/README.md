# Netscape export fixtures

These UTF-8 fixtures are synthetic and contain no personal browser data. They mirror browser export structures rather than asserting they were generated from installed browsers during this change.

- `chrome.html`: Chrome-style export header, Bookmarks bar flag, Other bookmarks, nested folders, timestamps, ignored inline ICON data, entities and a root duplicate.
- `firefox.html`: Firefox-style Bookmarks Menu, Toolbar and unfiled flags, ICON_URI/TAGS metadata, link and folder DD descriptions, IDN/Chinese URL, unsupported `place:` smart bookmark.
- `edge.html`: Edge-style Favorites bar and Other favorites, nested folders, timestamps, ignored ICON metadata, HTTP URL with nondefault port/query/fragment.
- `actions.mjs`: isolated unpacked Chromium acceptance actions using these local files and generated invalid/hostile files. All HTTP(S) is intercepted by the harness.

Run `cd app && npm test` for parser/model coverage. After `npm run build:unpacked`, run `npm run test:bookmarks` for the real file-picker, desktop, persistence and zero-outbound checks. See `docs/bookmark-html-import-0.2.2.md` from the repository root for behavior and verification details.

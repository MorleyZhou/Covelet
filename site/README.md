# Covelet marketing site

Static HTML/CSS/JS for the existing Cloudflare Pages project `covelet`:
https://covelet.future-element.com/ (also https://covelet.pages.dev/).
Publish `site/` directly with no build command. Keep the existing hosting,
domains and website analytics configuration. The source contains no analytics SDK;
the existing Pages configuration supplies website-only Cloudflare Web Analytics.

One Chinese HTML shell + `i18n/{locale}.json` + a working language selector.
Default: `zh-CN`; share another language with `?lang=en`. Locale codes match the
extension exactly: `zh-CN`, `en`, `zh-TW`, `ja`, `ko`, `de`, `fr`, `ru`.
UI labels, metadata, privacy boundaries and install links are localized too.
The page sets no cookies or browser storage. Chinese HTML works without JavaScript.
`index.html` is the complete Chinese fallback; keep it aligned with `zh-CN.json`.

The retained design uses white, black borders, hard shadows, large radii and
`#B9FF66`. Both SVG assets remain unchanged. Copy puts everyday navigation,
search and notes before data storage, optional sync and backup. Keep setup steps,
connection-test limits and export exclusions in the extension's contextual help.
The page retains the overall sync Beta label, explains local/remote version choice,
and discloses unencrypted backups and hidden content.

For updates, check all eight dictionaries against the HTML bindings, preserve
the Chrome/Edge destination URLs, and verify desktop/narrow layouts and language
switching before publication. Website publishing does not release the extension,
change its version, submit a store build, or authorize DNS changes.

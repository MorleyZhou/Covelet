# Covelet marketing site

Static HTML/CSS/JS for the existing Cloudflare Pages project `covelet`:
https://covelet.future-element.com/ (also https://covelet.pages.dev/).
Publish `site/` directly with no build command. Keep the existing hosting,
domains and website analytics configuration. The source contains no analytics SDK;
the existing Pages configuration supplies website-only Cloudflare Web Analytics.

`index.html` is the Simplified Chinese homepage and the template for the other
seven languages. Edit the template and `i18n/{locale}.json`, then run
`node scripts/render-site-locales.mjs` from the repository root to update the
checked-in locale pages and sitemap. `node scripts/render-site-locales.mjs --check`
verifies that the generated files are current. Keep the template copy aligned with
`zh-CN.json` and use `data-i18n` on text-only elements. The site and extension use
the same locale codes (`zh-CN`, `en`, `zh-TW`, `ja`, `ko`, `de`, `fr`, `ru`).

Every locale has a static URL, such as `/en/` or `/zh-tw/`, with its own translated
HTML and metadata. The language selector navigates to these pages. Old links such
as `/?lang=en` still work in browsers with JavaScript, retaining other query
parameters and fragments when they open `/en/`. The site sets no cookies or browser
storage.

The [privacy policy](https://covelet.future-element.com/privacy/) is available in
Chinese and English without JavaScript. Keep `privacy/index.html` aligned with
the [extension privacy policy](../docs/隐私说明.md). The path-specific rules in
`_headers` prevent scripts from running on the policy page.

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

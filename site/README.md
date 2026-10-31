# Covelet marketing site

Pure static HTML/CSS/JS; no backend, analytics, SDKs, or user-data processing.
Cloudflare Pages can publish `site/` directly with no build command. No deployment
or DNS changes are included. Preview: `python3 -m http.server 8080 --directory site`.

One Chinese HTML shell + `i18n/{locale}.json` + a working language selector.
Default: `zh-CN`; share another language with `?lang=en`. Locale codes match the
extension exactly: `zh-CN`, `en`, `zh-TW`, `ja`, `ko`, `de`, `fr`, `ru`.
All eight use the approved `/workspace/covelet-site-copy-i18n.md` pack.
UI labels are localized too. No cookies or browser storage; Chinese works without JS.
The explicit Chinese meta-title lock takes precedence over the pack's brand prefix.

Design: `/workspace/covelet-site-mock/index.html` (= `direction-c.html`) and
`brand-direction-c-brutal.md`. White, black borders, hard shadows, large radii,
`#B9FF66`; only the two referenced SVG assets are copied unchanged.
Chrome and Edge links, WebDAV/Beta messaging, three setup steps, connection
verification, and whole-record conflict choice follow the approved pack.

**Draft only. Do not merge — waiting exec.**

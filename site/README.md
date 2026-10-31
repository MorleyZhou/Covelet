# Covelet marketing site

Buildless static HTML, CSS, JavaScript, and local SVGs. Cloudflare Pages can
publish this `site/` folder as its output directory with no build command.
No deployment, Cloudflare settings, or DNS changes are part of this draft.

Preview from the repository root:

```sh
python3 -m http.server 8080 --directory site
```

Open `http://localhost:8080/` or `http://localhost:8080/?lang=en`.

## Copy and languages

- Approved copy: `/workspace/covelet-site-copy-zh-en-2026-10-31.md`.
- Only **zh-CN and en are final** and appear in the working language selector.
  The extension's other locales (`zh-TW`, `ja`, `ko`, `de`, `fr`, `ru`) are omitted
  until their copy is approved. There are no placeholder translations.
- Locale values and JSON filenames use the extension's exact hyphen codes from
  `app/src/i18n/index.js`. The shell defaults to `zh-CN`; `?lang=en` selects English.
  Unsupported values fall back to `zh-CN`.
- `index.html` contains complete Chinese fallback content. `site.js` applies
  `i18n/*.json` with `textContent` and updates the title, description, accessible
  labels, store links, and HTML language. Language selection is stored only in
  the URL. No cookies or browser storage are used.
- Keep approved copy verbatim. The explicit Chinese title lock overrides the
  copy pack's branded meta title: both H1 and meta title are exactly
  `可验证、不会变质的私人起始页`. The subtitle is exactly
  `无账号 · 本地加密 · 数据只在你自己的存储里`.

## Design and scope

Adapted from the read-only `/workspace/covelet-site-mock/index.html`
(`direction-c.html`) and `brand-direction-c-brutal.md`: white, thick black borders,
large radii, hard shadows, and one neon accent, `#B9FF66`. Only the referenced
`covelet-mark-brutal.svg` and `hero-illustration.svg` are copied, unchanged.

This is a static product introduction with both Chrome and Edge store links.
It has no account flow, forms, backend, analytics, PostHog, or third-party SDKs,
and does not handle extension data. WebDAV (Nutstore / Nextcloud) is the real
cloud path; R2, OSS, GitHub, and GitLab remain Beta. The three-step setup, saved
versus verified distinction, and whole-record conflict choice follow the copy
pack. Extension code is outside this change.

Draft only. **Do not merge — waiting exec.**

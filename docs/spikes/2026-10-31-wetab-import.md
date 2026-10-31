# WeTab import spike — 0.3 P1-B

**Date:** 2026-10-31 · **Conclusion: Defer-to-0.4**

Timebox: ≤3 person-days of investigation per source. This is a public-source desk spike; no vendor login, installation, private backup, cloud API probing or importer implementation. Findings below distinguish public claims from validated formats.

## Obtainable data and evidence

- **Official product:** WeTab at `wetab.link`, Chrome extension ID `aikflfpejipbpjdlfabpgclhblkpaafo`. The developer's listing describes website shortcuts, widgets, notes, todos, appearance settings and account-based backup/sync. It does **not** specify a portable export schema or supported external API. The observed listing is version 2.2.50, updated 2026-10-15. [Developer store listing](https://chromewebstore.google.com/detail/wetab-%E6%96%B0%E6%A0%87%E7%AD%BE%E9%A1%B5/aikflfpejipbpjdlfabpgclhblkpaafo).
- **Export lead, unverified:** A first-hand public user question calls WeTab's export format “data.” No file was inspected; the extension, encoding, fields, folder coverage and version compatibility remain unconfirmed. This is community testimony, not an official interchange contract or a validated reverse-engineered parser. [Public export question, post 76](https://linux.do/t/topic/1247462?page=4).
- The [official landing page](https://www.wetab.link/) describes the product but yielded no export specification in this investigation. Its `/zh/` link timed out; the [developer-linked support portal](https://support.qq.com/product/422565) was inaccessible to the research tool. These access failures leave gaps; they do not establish that local export is unavailable.

## Permissions, login and proprietary barriers

The listing explicitly associates backup/sync across devices with a WeTab account. Whether **local export** requires login or a paid tier remains unknown. The backup container, schema stability and availability of icon bytes are also unknown; no public schema/decoder was established. Do not infer Infinity compatibility from shared branding/contact details. Research stopped at public pages; no login, paid feature, extension storage or private endpoint was accessed.

A future Covelet route should accept a user-selected local export only, needing no vendor credentials, cross-extension access or new host permission. That is a proposed boundary, not an observed WeTab capability.

## Mapping gaps to Covelet

Baseline `b0483d9`: `app/src/lib/model.js` and `app/src/lib/import-plan.js` support HTTP(S) sites and single-level folders across desktop screens; the import plan carries names, URLs and folder labels. The final state is capped at 2,000 entries, including existing widgets; existing intake is capped at 5 MiB.

| Source concept | Proposed mapping / unresolved loss |
| --- | --- |
| Website shortcut | Name + HTTP(S) URL → site; actual export keys unknown. |
| Categories, pages, folders | Verify their representation first. Flatten deeper paths into distinct folder labels; preserve source order where observable. Source categories are not Covelet group tabs. |
| Icons and layout | No promise of asset or grid fidelity; start with local letter icons and Covelet placement. |
| Widgets, notes, todos, settings | Outside sites/folders scope; report omitted counts when identifiable. A widget must not become a guessed URL. |

## Cost, decision and reopening gate

**If Go later: roughly 4–6 engineering person-days**, assuming readable local exports: 1 day to confirm schema, 1–2 for extraction/mapping, 1–2 for validation/preview and 1 for documentation/acceptance. This implementation estimate is separate from the investigation cap; opaque/encrypted formats invalidate it.

Defer direct WeTab intake to 0.4. Reopen only with a public specification or redistributable, sanitized export examples covering root sites, folders/categories, widgets and exporter version. Verify decoding, export access requirements and URL retention before scheduling implementation; stop further format investigation at three person-days. Existing generic HTML/URL intake remains usable only if the user already has those formats—no WeTab conversion is claimed here.

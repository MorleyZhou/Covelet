# Infinity import spike — 0.3 P1-B

**Date:** 2026-10-31 · **Conclusion: Go**

Timebox: ≤3 person-days of investigation per source. Public-source desk research and static code inspection only; no vendor login, extension installation, private backup or importer implementation. Go covers a bounded local-file adapter for the observed schema, subject to the acceptance gate below.

## Obtainable data and evidence

- **Official product:** Infinity's [site](https://www.infinitytab.com/zh/) documents shortcuts, icon folders, notes/todos and cloud backup. The [developer store listing](https://chromewebstore.google.com/detail/infinity-new-tab/dbfmnekepjoapopniengjbcpnbljalfg?hl=en) identifies the standard Chrome extension, version 11.0.43, updated 2026-08-25. Neither source supplies a versioned export schema.
- **Community reverse-engineering:** [Infinity2Chrome's README](https://github.com/extrastu/Infinity2Chrome/blob/57f4c05226ce6d39c4721b8ce3fa1bd88dd2db83/README.md) describes user-exported `.infinity`/`.json` backups and bookmark HTML output. Its [parser/exporter source](https://github.com/extrastu/Infinity2Chrome/blob/57f4c05226ce6d39c4721b8ce3fa1bd88dd2db83/components/sites-viewer.tsx) reads text with `JSON.parse`, expects `data.site.sites` as page arrays, and extracts names, target URLs and folder membership. The inspected revision dates to December 2025; this is evidence of one supported shape, not proof of current 11.x or Pro/Edge compatibility.

| Observed field | Meaning for a possible adapter |
| --- | --- |
| `version`, `browserEnv`, `editionEnv`, `extVersion`, `backupType`, `time` | Available envelope metadata; record for compatibility diagnostics, not authentication. |
| `data.site.sites[][]` | Pages containing site/app/folder records, with `name` and URL in `target`. |
| Folder IDs beginning `folderId-`, `parentId`, `children[]` | Both referenced children and embedded child arrays are handled by the community converter. |
| `bgImage`, `bgColor`, `bgText`, `updatetime` | Declared presentation/timestamp fields; not evidence of portable image bytes. |

## Permissions, login and proprietary barriers

Public code demonstrates processing an **already exported** local file without vendor credentials. Whether current local export itself needs login/payment is unverified; cloud sync is not a public migration API. An official-site recovery link redirected to Feishu login and was not pursued. Research used no private accounts or endpoints.

A Covelet file adapter would need no new host or cross-extension permission. Never read another extension's storage or obtain cloud tokens. No vendor schema contract was found in the reviewed sources; the converter is third-party MIT-licensed evidence, not an SDK or compatibility guarantee.

## Mapping gaps to Covelet

Baseline `b0483d9`, `app/src/lib/model.js` / `app/src/lib/import-plan.js`: map `name` + validated HTTP(S) `target` into sites, resolve folder IDs into unique labels, and generate Covelet IDs. Preserve array order; present source page information while letting Covelet allocate the destination screen. Deeper paths must become single-level folder labels. Same-name source folders need disambiguation because existing intake may reuse a destination folder with the same name.

Count and report unsupported app targets, malformed URLs and non-navigation content. Notes, todos, wallpapers, search settings and layout are outside scope; use letter icons initially. Deduplicate records represented both in `children` and page arrays before applying Covelet's optional URL deduplication, which can otherwise collapse intentional cross-folder copies. Keep preview/cancel and existing 5 MiB / 2,000-entry limits; reject unknown shapes rather than guessing.

## Cost and acceptance gate

**Roughly 4–6 engineering person-days if pursued:** 1 for schema/fixture confirmation, 1–2 for parsing and mapping, 1 for preview integration, 1–2 for boundary tests, documentation and acceptance. This is implementation effort, separate from the investigation cap.

Go for the observed local JSON shape only. Before shipment, require public, redistributable sanitized exports tied to current exporter versions, including folders, multiple pages and both child representations; verify permissions and URL/order/count retention. Pro, Edge, legacy and changed formats remain unsupported until evidenced. No real export was exercised here. If that gate cannot be met within the spike's three-person-day investigation ceiling, move the adapter to 0.4. Community HTML output could feed existing bookmark intake, but this spike neither ran nor endorses a hosted converter.

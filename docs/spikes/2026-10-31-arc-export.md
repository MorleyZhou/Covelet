# Arc export exploration — 0.3 P1-B

**Date:** 2026-10-31 · **Conclusion: No-Go**

Decision scope: no dedicated Arc product entry or adapter commitment for 0.3; export guidance only. Timebox: ≤3 person-days of investigation. Public documentation and static code inspection only; no login, installation, private profile or exporter execution.

## Obtainable data and evidence

Arc's [official farewell/timeline](https://arc.net/) announces desktop shutdown on **2026-12-22**, blocks new accounts from 2026-10-22 and schedules account data deletion within 30 days of deactivation. Older claims that Arc cannot export tabs are superseded by current help.

The [official export guide](https://resources.arc.net/hc/en-us/articles/25583851606039-How-Do-I-Export-My-Data-from-Arc) describes:

- **Desktop:** `Arc Data Export.md`, with a section per Space and links for Favorites, pinned tabs, folders and other sidebar tabs. It is a Markdown link list, not Netscape bookmark HTML or a complete browser backup.
- **Narrow fallback:** Copy All Links from a folder; macOS offers Copy All Links as Markdown, retaining titles.
- **Other assets:** Export All Easels produces a ZIP of web pages for Easels the user created; a single Easel can be saved as PNG. Boosts cannot be exported. These assets are outside navigation import scope.

**Reverse-engineered alternative:** [ivnvxd/arc-export](https://github.com/ivnvxd/arc-export/blob/088a888af3467583ab54e6008abf8e0b40c984db/README.md) converts local `StorableSidebar.json` into bookmark HTML. Its [source](https://github.com/ivnvxd/arc-export/blob/088a888af3467583ab54e6008abf8e0b40c984db/main.py) reads Spaces, parent references, saved titles/URLs and pinned containers. This February 2025 revision does not consume Markdown. Current schema, Favorites, unpinned/archived tabs and profile coverage are unverified. It is community MIT code, not an official interface.

## Permissions, login and proprietary barriers

An existing user obtains the export inside Arc before shutdown. Arc's separate direct migration into Dia establishes no portable interface for Covelet. The Markdown guide promises no password, cookie, history or extension-state portability.

The export can be read locally without vendor credentials or Covelet host permissions. Proprietary sidebar storage would require a user-provided file; ordinary extension APIs cannot simply access Arc's profile. OS paths, schema drift and post-shutdown accessibility remain untested.

## Mapping gaps to Covelet

Baseline `b0483d9`, `app/src/lib/model.js` / `app/src/lib/import-plan.js`: Covelet accepts HTTP(S) sites and single-level folders. `parseBulkLinks` reads URL/Markdown text but assigns **no folder from headings**; unnamed links fall back to hostnames. Existing bookmark HTML parsing flattens nested folders into path labels and drops empty folders. Neither route preserves Arc account isolation, split views or tab state.

For a future structured conversion, map Space/folder paths to distinct single-level labels (for example `Work / Research`); pinned/Favorite status has no navigation equivalent. Verify titles, order, shared Favorites and duplicates across Spaces. Skip internal/non-HTTP(S) URLs, report losses and retain existing 5 MiB / 2,000-entry limits. The exact Markdown grammar and multi-profile completeness were not validated against a real export.

## Export handoff, cost and decision

The official desktop steps are **macOS:** Arc → Settings → Advanced → Export Data; **Windows:** Settings → Advanced → Export Spaces and tabs → Export Data. Save the file before the deadline. Open it locally, then paste selected links/Markdown into Covelet's existing URL intake and review the preview; organize folders manually. The current file picker accepts bookmark HTML, so selecting `.md` there is not the handoff. This is a code-informed route, not tested Arc compatibility.

If pursued, guidance plus synthetic generic-intake checks would cost **0.5–1 engineering person-day**; a structured Markdown-to-plan/HTML adapter would be **3–5 days**, subject to a public representative export. These estimates are separate from the investigation cap. No-Go for dedicated Arc work in 0.3: official export and generic intake justify documentation; a permanent integration adds uncertain coverage for a retiring product. Reconsider only as general Markdown folder support after public exports establish the grammar.

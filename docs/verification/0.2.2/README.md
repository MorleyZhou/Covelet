# 0.2.2 verification · draft evidence

This is evidence for the 0.2.2 candidate on `feat/0.2.2-polish`, based on `46c6d05493fd93103c43684c6a15157016c5da60`. It is not release, store or live-cloud acceptance. Historical QA/audit logs and importer spikes are unchanged.

## Reproduced M3 defects and fixes

1. An unchanged causal document could be rejected as `DATA_SYNC_INVALID` after JSON members were reordered, including an otherwise valid pending retry. Reuse the existing structural JSON comparator in the cloud controller and full-data engine; canonicalize conflict-preview fingerprints. Tests retain array order and reject actual same-clock content changes.
2. `covelet.language.v1` was incorrectly portable. Two devices using different UI languages created permanent whole-record conflicts, contrary to the device-local language specification. Exclude it from snapshots and atomic imports. Accept its old causal history without materializing it or exposing language conflicts, so old remote indexes and persisted pending ciphertext remain usable. This does not remove historical encrypted cloud copies.

The [before-fix reproductions](m3-reproductions.txt) fail both regressions. The production WebDAV adapter with independent encrypted storage instances now covers bidirectional edits, offline deletion versus edit, explicit whole-record choice, lost PUT response, session clearing/re-unlock and an unchanged repeat with zero PUTs. Responses are synthetic HTTPS-shaped in-memory fixtures, never live credentials or a local application server. Existing P0 transport limits, authentication, redirects, pending ciphertext, CAS, secret exclusion and conflict tests still pass.

## Results

| Check | Observed result |
| --- | --- |
| `npm test` | [473 passed, 0 failed](final-unit-tests.txt); prior M2 run [468 passed](m2-unit-tests.txt) |
| Targeted WebDAV, full sync, encrypted storage, bookmarks and privacy | [86 passed, 0 failed](targeted-tests.txt) |
| `build:unpacked`, `check:extension` | Production unpacked build passed; [61 package files checked](final-extension-check.txt); no ZIP/release created |
| `check:wasm` | [All five packaged core checks passed](wasm-check.txt); binaries unchanged |
| `test:onboarding` | [Passed](final-onboarding.txt); [structured results](onboarding-results.json), all HTTP(S) intercepted |
| `test:bookmarks` | [Passed](final-bookmarks.txt); [11 imported sites; 0 HTTP(S) and 0 native-favicon requests during import](bookmarks-results.json) |
| Production web build and `test:sites` | Build passed; [4 passed](sites-tests-after-build.txt). Initial Sites packaging test lacked `dist/client/index.html`; rerun after its required build passed. |
| Version/permissions/analytics review | Package, lockfile root/package and manifest all 0.2.2. Manifest differs only in version. No analytics dependency, SDK or event dispatch added. |

Only the importer measurement interval is zero outbound. The separately intercepted initial Bing attempt is included in the structured results; the extension still has its disclosed wallpaper, search, image, contribution and opt-in storage network paths.

## UI evidence

Actual unpacked Chromium extension, synthetic data, no local application server. System light/dark media are emulated without changing saved settings. Each matrix cell has viewport/overflow assertions. Sample screenshots were visually inspected for readable wrapping and available actions. Keyboard Space expands both new disclosures and retains focus; existing failure, cancel, step, duplicate-count, scroll and revision checks remain active. These checks do not establish full accessibility or reviewer acceptance.

| State | Light 1100 × 850 | Dark 1100 × 850 | Light 390 × 844 | Dark 390 × 844 |
| --- | --- | --- | --- | --- |
| Data / What's new / backup boundaries | [View](data-whats-new-light-1100.png) | [View](data-whats-new-dark-1100.png) | [View](data-whats-new-light-390.png) | [View](data-whats-new-dark-390.png) |
| Privacy | [View](privacy-light-1100.png) | [View](privacy-dark-1100.png) | [View](privacy-light-390.png) | [View](privacy-dark-390.png) |
| Setup 1: provider | [View](step-one-light-1100.png) | [View](step-one-dark-1100.png) | [View](step-one-light-390.png) | [View](step-one-dark-390.png) |
| Setup 2: test | [View](step-two-light-1100.png) | [View](step-two-dark-1100.png) | [View](step-two-light-390.png) | [View](step-two-dark-390.png) |
| Setup 3: password / first sync | [View](step-three-light-1100.png) | [View](step-three-dark-1100.png) | [View](step-three-light-390.png) | [View](step-three-dark-390.png) |
| Bookmark tips | [View](import-tips-light-1100.png) | [View](import-tips-dark-1100.png) | [View](import-tips-light-390.png) | [View](import-tips-dark-390.png) |
| Bookmark preview / keep local | [View](bookmark-preview-light-1100.png) | [View](bookmark-preview-dark-1100.png) | [View](bookmark-preview-light-390.png) | [View](bookmark-preview-dark-390.png) |

## HIG / product / de-AI evidence

- Apple HIG：[Design principles](https://developer.apple.com/design/human-interface-guidelines/design-principles) 的 simplicity、agency、responsibility、familiarity；[Writing](https://developer.apple.com/design/human-interface-guidelines/writing) 的简短、直接、行动语言。沿用现有三步、控件、焦点与滚动区域；补充折叠式帮助，不增加自动弹窗；明确保存、测试与首次同步的不同结果。
- 产品规格：[需求文档](../../需求文档.md)、[README](../../../README.md)；保留八语言、默认关闭的可选同步、会话秘密、书签「保留本地」与跳过数量。未增加云服务或遥测。语言保持本机设置。
- 去 AI 腔：「近 7 天的外部请求」→「联网功能」并明确无法统计；「WebDAV 为本轮加固渠道…」→「WebDAV 优先；所有渠道的真实云账号验收仍待完成。」；首次同步不再承诺无既有云数据时也能验证密码。
- 截图：上方 28 张实际解压扩展截图覆盖受影响状态、尺寸与主题。
- 实际检查：473 单元测试、86 项定向测试、生产构建／静态检查、两条浏览器流程、键盘 Space／焦点、零联网书签导入，结果如上。
- 未验证边界：真实坚果云／Nextcloud 账号与两台物理设备、真实限流／证书／服务端并发；Firefox／Edge 扩展安装；屏幕阅读器和完整对比度审计；其他云渠道仍 Beta。无账户材料可据以完成这些验收。PostHog：永久 N/A（隐私 / 无遥测站立）。
- Creative Director：没有遗留的文案／视觉方案分歧，也未实现推测性视觉方案；采用现有控件与明确的能力描述。Creative Director／reviewer 的最终视觉、翻译及 HIG 签字仍待进行，不以自动截图代替。
- 验收结论：工程检查通过；整体发布验收 **未通过／待 reviewer 与真实云验收**。仅 Draft PR，**禁合入**；无 tag、无 release、无商店提交。

# Firefox 兼容性结论与实施边界

调研日期：2026-11-25。本文先于 Firefox 产品代码和构建修改写入。依据为当前仓库源码、已安装的 WXT 0.21.4，以及下列 Mozilla、WXT、Playwright 官方资料；并不代表已经完成 Firefox 浏览器验收。既有阅读器和 RSS 未提交改动保留。

## 结论

可增加独立的 **Firefox 桌面版 Manifest V3** 构建，复用新标签页、便笺、稍后读、隐私保护、加密 IndexedDB、云同步、RSS 和现有手动备份协议。Firefox 后台必须使用按事件唤醒的模块脚本页面，不能照搬 Chromium service worker。WXT 0.21.4 已有这一生成分支，无需降回 MV2。[MDN 后台清单](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background)、[WXT 多浏览器目标](https://wxt.dev/guide/essentials/target-different-browsers.html)

但“零新增权限、所有 Chromium 功能完全一致”目前不能同时成立。Firefox 不提供所选外部目录的 File System Access 接口，因此不能原样保留向用户指定操作系统目录自动写入备份的功能；也没有 Chromium 的 `favicon` 权限和 `/_favicon/` 本地接口。应明确报告平台限制，不能悄悄扩大权限、改为云端服务、把 OPFS 当作用户备份目录，或在 Firefox 构建中伪称这些功能可用。[MDN 目录选择器](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker)、[MDN 扩展权限](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/permissions)

推荐最低桌面版本为 **Firefox 140.0**：覆盖当前使用的 API，并与现行内置数据传输声明体验一致。这是保守的产品支持基线，不表示所有功能在 140 才出现；不声明 Firefox Android 支持。[MDN Gecko 设置](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings)

## 已核对的构建与 API

当前 `app/wxt.config.ts`、`app/scripts/build-extension.mjs` 固定 Chrome，产物目录为 `dist/extension`；检查脚本也固定校验 Chromium 权限和后台形式。Firefox 应有独立目录和独立校验，避免覆盖已供 Chrome/Edge 使用的产物。必须显式传 `--mv3`，因为 WXT 默认 Firefox 目标仍是 MV2。[WXT 目标配置](https://wxt.dev/guide/essentials/target-different-browsers.html)

本机 `app/node_modules/wxt/dist/core/utils/manifest.mjs` 的 `addEntrypoints()` 对 Firefox MV3 生成 `background.scripts` 和入口的 `type`；对 Chrome MV3 才生成 `service_worker`。入口现为 `defineBackground({type:'module',main(){...}})`，可以复用注册监听器的同步入口。MV3 不设置 `persistent:true`，每次后台重建从持久状态恢复 alarm，不能依赖内存变量跨休眠保留。[MDN 后台生命周期](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts)

| 能力 | 当前调用及结论 | Firefox 已有支持起点 |
| --- | --- | --- |
| 新标签页、工具栏 popup、快捷键 | 继续使用 `chrome_url_overrides.newtab`、`action`、`commands`；这些键名本身不是 Chrome 专属 | 新标签页 54 |
| 本地与会话存储 | `storage.local` 用于旧数据迁移；敏感解锁会话继续使用内存型 `storage.session`；业务数据仍为设备密钥加密 IndexedDB | `storage.session` 115 |
| 默认搜索 | 当前 `search.query({text,disposition})` 可保留，不必改为 Firefox 专用 `search.search`，也不增加搜索引擎替换权限 | `search.query` 111 |
| 选文捕获 | `activeTab` + `scripting.executeScript`，保持主框架、用户点击、导航变更校验；浏览器内部页和其他受限页仍应明确失败 | `activeTab` 48；`scripting.executeScript` 102 |
| 后台任务 | `alarms` 可以唤醒事件页面；启动时重建计划，因为 alarm 不跨浏览器会话持久化 | alarms 45 |
| 精确来源授权 | 保留现有 `optional_host_permissions`，只从用户操作申请选中来源；后台仅检查授权 | 此清单字段 128 |
| 锁与图像处理 | `navigator.locks`、`OffscreenCanvas` 已有支持；仍需实测扩展页面、后台和本地 WASM/CSP | Locks 96；OffscreenCanvas 105 |

版本起点核对自 [MDN 浏览器兼容数据](https://github.com/mdn/browser-compat-data) 中对应 `webextensions` / `api` JSON；具体行为参见 [search.query](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/search/query)、[storage.session](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/session)、[alarms](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/alarms)、[optional_host_permissions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/optional_host_permissions)。

固定必需来源继续严格为 `https://www.bing.com/*`，壁纸元数据地址仍为现有 Bing `HPImageArchive.aspx`。不改成其他 Bing 域名、代理或广泛必需主机权限；现有 HTTP(S) 可选主机模式也不转为必需授权。API 权限只保留原有且 Firefox 支持的 `storage/search/activeTab/scripting/alarms`，Firefox 清单移除不可用的 `favicon`，不新增 `tabs/downloads/nativeMessaging/notifications`。

## 必须处理的源码兼容点

| 源码位置 | 发现的问题与要求 |
| --- | --- |
| `entrypoints/background.js`、`src/popup.jsx`、`src/lib/search.js` 和多数适配器 | 当前把 `globalThis.chrome.*` 当作 Promise API。Firefox 的兼容 `chrome` 命名空间以回调兼容为目标；应使用其原生 `browser` Promise API，或一个统一选择适配器。WXT 的 `browser` 只选择现有全局对象，并非自动改写整个应用。 |
| `src/lib/cloud-sync.js` | `chromeCall()` 与 `defaultPermission()` 明确使用回调和 `runtime.lastError`。不能只把所有对象改成 `browser` 后继续向 Promise 方法传回调；需保留原回调兼容路径或统一封装，并验证 `storage.session` 共享、重启后锁定。 |
| `src/lib/bundled-navigation-icons.js` | 当前要求 `chrome-extension:` 且 URL 主机等于 `runtime.id`。Firefox 的 `moz-extension://内部UUID/` 主机不等于清单 Gecko ID。改为与 `runtime.getURL('')` 生成的扩展来源核对，继续校验精确本地资源路径。 |
| `src/lib/navigation-icon-cache.js` | 跨页面图标 BroadcastChannel 监听目前只允许 `chrome-extension:`，需要覆盖 Firefox 扩展页面。 |
| `src/components/ScheduledBackupSettings.jsx` | 状态消息检查写死 `chrome-extension://${runtime.id}`；Firefox 应核对当前扩展实际来源。保留 sender ID 与 URL 校验，不能简单移除来源检查。 |
| `src/lib/browser-favicon.js` | 刻意只访问 Chromium 原生本地图标接口；Firefox 不能构造 `moz-extension://.../_favicon/` 假接口。能力检测应返回不可用，并提供明确的现有替代方式。 |
| `src/lib/storage.js`、`src/lib/visual-processing.js` | 已识别 `moz-extension:`，但仍需用真实 Firefox 验证 Blob、Worker、WASM、备份和加密事务。 |
| `src/lib/scheduled-backup.js`、`src/lib/scheduled-backup-store.js` | 依赖外部目录句柄、`queryPermission/requestPermission`、原生结构克隆和后台写文件；Firefox 不具备这组外部目录能力。 |
| `src/lib/clock-runtime.js` | 有遗留通知权限调用，但当前功能已退出后台时钟调度；移植不因此增加通知权限或复活旧入口。 |

API 命名空间与 Promise 差异依据 [MDN JavaScript APIs](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API)、[WXT Extension APIs](https://wxt.dev/guide/essentials/extension-apis)。扩展 URL 应由 [runtime.getURL](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/getURL) 生成，而不是拼接 Gecko ID。

### 原生图标与目录备份的替代边界

图标仍可使用字母图标、已经随扩展打包的图标、手动图片和用户授权后的现有站点识别流程。popup 用户点击获得的 `activeTab` 可以用于当前页信息；即使取得 `tabs.Tab.favIconUrl`，它也不是可查询任意保存 URL 的本地图标数据库，不应为此追加所有标签权限或自动向远程图标站点取图。[MDN tabs 权限](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Working_with_the_Tabs_API)、[MDN Tab.favIconUrl](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/Tab)

Firefox 支持的 OPFS/部分 `FileSystemDirectoryHandle` 与用户可见外部目录是两种能力。OPFS 不能替代独立备份：清理扩展数据或卸载扩展可能一起失去它。当前手动 JSON、ZIP、加密 `.covelet` 下载和恢复继续可用。若将来增加基于 `downloads` 的计划备份，必须单独评审新增权限、下载目录选择、重复文件命名、保留三份、校验和清理语义；native helper 则还涉及新安装依赖和 `nativeMessaging`，均不属于此次无新增权限的移植。[MDN 文件系统访问](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker)

## Gecko 身份与数据传输声明

Firefox MV3 签名分发需要固定 `browser_specific_settings.gecko.id`。本项目采用稳定 ID `covelet@morleyzhou.github.io`；测试临时加载成功不代表已获得 AMO 签名。设置 `strict_min_version:'140.0'`，不设置随意的最高版本或 Android 声明。[MDN browser_specific_settings](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings)

新 Firefox 扩展自 2025-11-03 起需要声明 `gecko.data_collection_permissions`。`required:['none']` 只适用于没有必需数据传输的声明，不能仅凭“没有遥测、没有 Covelet 账号服务器”就推导完整功能不传数据。现有用户配置的云存储会接收加密内容及认证请求；网页/RSS/图片请求和搜索也需按实际行为分类。实现前须核对适用的 Mozilla 分类、隐式同意边界以及哪些功能需要可选数据同意；加密和自选服务不自动构成声明豁免。不添加遥测，也不把现有自选网络请求描述为零联网。[Mozilla 内置数据同意说明](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)、[Mozilla 数据传输政策](https://extensionworkshop.com/documentation/publish/add-on-policies/#data-collection-and-transmission-disclosure-and-control)

此次目标是未签名的本机 Firefox 兼容性构建，尚不提交 AMO；在完成准确分类与同意审查前，暂不填写 `data_collection_permissions`，也不填写未经证实的 `required:['none']`。该缺项是已记录的上架前工作，不能把该产物称为已经符合 AMO 提交要求。浏览器 API 权限、HTTP 主机授权与数据传输声明是不同层次，不能互相替代。

## 验证方法与未完成项

保留 Chromium 原有构建与验收，再为 Firefox 独立校验清单、所有入口、ESM 后台、CSP、本地 WASM、打包资源及权限集合。真实 Firefox 使用隔离测试配置，通过 `about:debugging` 临时加载，并验证新标签页、popup 选文、默认搜索、加密数据跨页面/重启、隐私遮挡、授权读取、RSS alarm 和同步协议。临时扩展不会证明签名分发或升级验收。

不能把 Playwright 的 Firefox 普通网页启动当作扩展验收。其官方扩展便利接口只支持 Chromium 持久上下文；本次用户已明确要求使用 Playwright。验收使用 Playwright 的真实 Firefox，通过 Mozilla 调试协议临时安装扩展，再由 Playwright 操作实际的 `moz-extension://` 页面，不使用普通网页替代扩展。测试会明确区分临时安装、自动化交互、外部服务验证和人工验收。[Playwright 官方扩展范围](https://playwright.dev/docs/chrome-extensions)、[Mozilla web-ext 的原生临时安装实现](https://github.com/mozilla/web-ext/blob/master/src/firefox/remote.js)

截至本文写入，仅完成源码和一手资料调研；未构建或运行 Firefox 包，未修改产品代码、运行时、依赖或权限，未提交、推送或发布。

## 随后实现的构建入口

两种构建共用 `src/` 和原始 `extension.manifest.json`。`scripts/extension-target.mjs` 从 Chrome 基线生成 Firefox 清单，`wxt.config.ts` 的配置钩子为直接 WXT Firefox 命令也选择独立目录；自定义 mode 被限制为安全的单段名称，不能穿越目录覆盖另一个目标。Chrome 的清单内容和固定目录保留。

| 命令（在 app/ 下） | 产物或检查 |
| --- | --- |
| `npm run build:unpacked` / `npm run check:extension` | 原有 Chrome `dist/extension` |
| `npm run build:firefox:unpacked` / `npm run check:firefox` | Firefox `dist/extension-firefox` |
| `npm run build:firefox` | Firefox 构建、WASM 检查、静态检查和 `dist/covelet-0.6.0-firefox.zip` |
| `npm run test:firefox` | Playwright 原始回归入口；当前驱动限制见下文和验证记录 |
| `npm run test:firefox:native` | 同一未修改 Firefox 的原生核心替代回归，单独报告结果 |
| `npm run test:firefox:r2` | 读取此前授权的本机配置，使用独立测试子目录验证真实 R2 同步 |

在 Firefox 140+ 桌面版的 `about:debugging#/runtime/this-firefox` 选择“临时载入附加组件”，打开 Firefox 目录的 `manifest.json`。临时加载只用于开发验收，正常分发仍需要签名；本轮不提交 AMO、不注册账号、不宣称商店可安装。

此未签名兼容性构建暂不填写 `data_collection_permissions`；这不代表免除后续分发声明，也不代表对现有可选网络功能作出“零传输”的新承诺。Chrome 清单不增加该字段。

### 实测发现的 Playwright 限制

仓库安装的 Playwright 1.64.1 / Firefox build 1555，在 `JugglerFrameChild.jsm` 中对 `moz-extension://` 提前返回，不创建页面自动化代理。Mozilla RDP 可以成功临时安装本扩展，后台为 RUNNING，但 Playwright 导航及后续 DOM 操作无法完成。关闭请求拦截或更换等待条件不能解决此限制。[Playwright Firefox 代理源码](https://github.com/microsoft/playwright/blob/main/browser_patches/firefox/juggler/content/JugglerFrameChild.jsm)

因此记录原始 Playwright 失败，并使用同一浏览器内置的 Marionette 通道补做实际扩展回归；两者结果分别记录，不把原生替代验证称作 Playwright 通过。未修改浏览器内部代理或以普通 HTTP 页面代替扩展页面。

Firefox 157 实测 `browser.storage.local.get()` 和 `chrome.storage.local.get()` 均可返回 Promise；不能把命名空间差异概括成所有 Firefox `chrome` API 都只支持回调。共享适配器仍明确为 Promise 调用选择 `browser`，并保留显式回调适配器，避免把不同 API 和支持版本混为一谈。实际验证见 [验证记录](verification/firefox-2026-11-25.md)。WebDAV 已按用户后续指令暂缓，本轮不计入验收。

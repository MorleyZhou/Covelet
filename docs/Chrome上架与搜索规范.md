# Chrome 上架与搜索规范

2026-10-21 后续开发源码加入可选 `tabs`（手动保存当前窗口标签快照）及 `readingList`（单次导入浏览器阅读清单），只在对应用户操作中申请。未增加 `history`，不被动采集浏览行为；图标识别流程不请求这两项权限。旧提交和下方早期权限表不代表这次新增功能已发布；未来重新打包提交前需更新公开隐私政策及商店披露。当前未运行应用构建、检查或商店验收。[可选权限](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)、[最新实现](扩展升级与本机工具-2026-10-21.md)。

## 2026-10-20 开发版图标修订（未重新提交商店）

开发版新增 `favicon` 权限，通过本扩展 `/_favicon/` 读取浏览器已有图标；新增网站和保存自定义引擎不再主动请求各站点访问权限。原生接口只查询输入来源的根地址及固定尺寸，不枚举历史；不新增 `history`、`tabs` 或 web-accessible resources。该权限可能产生一次安装／更新提示，不能承诺完全没有权限提示。浏览器没有缓存的图标可返回默认图，必须过滤并回退文字，不把默认图当成网站真实 Logo。[Chrome favicon 官方说明](https://developer.chrome.com/docs/extensions/how-to/ui/favicons)、[权限警告](https://developer.chrome.com/docs/extensions/reference/permissions-list#favicon)

名称补全仍可由用户主动授权具体来源，已有授权可继续读取根首页与同源图标。首页只读前512KiB，取消余流；首页失败仍尝试同源 favicon，图片大小与解码限制不放宽。发布更新前需同步公开隐私页及商店权限披露。本节覆盖下文历史基线中的“保存引擎即申请来源权限／没有增加安装权限”旧实现描述；原 v0.1.0 商店提交包未变。

核查日期：2026 年 10 月 19 日。依据为当日可访问的 Google / Chrome 官方原始文档。本文是开发和上架检查基线，不代表 Chrome Web Store 已审核、承诺通过或 OwnTab 已发布；提交前需要重新核查政策和实际发布包。

本轮扩展构建迁至 WXT 0.21.4；Manifest 源为 `app/extension.manifest.json`，WXT 生成 `chrome_url_overrides.newtab: "newtab.html"`。这仍是包内页面覆盖，未修改默认搜索设置、权限用途或 CSP 边界。WXT 构建与静态检查通过不表示真实扩展已安装或商店已审核；[框架选型](框架选型.md)另记录框架比较与迁移验证。

以上边界针对 `npm run build:extension` 生成的生产包；`dist/extension-dev` 为 WXT 热更新开发输出，可能包含本地连接、重载后台和开发命令等配置，不得用于商店提交或对外隐私声明的生产行为核验。

最新产品范围为全新空桌面（开发演示也不预置示例）、网格加号添加、拖拽建文件夹与整理；取消显式新建文件夹及右键移动／前后移动；设置→数据保留用户选择HTML文件的书签导入。右键保留编辑和删除，文件夹名称可直接编辑；OwnTab ZIP备份恢复继续保留。商店描述和截图不再宣传已移除的入口，书签文件在本机惰性解析，不读取浏览器书签库，不申请bookmarks权限；导入及ZIP恢复可带入文件夹。真实触屏、键盘及无障碍能力应按实际支持范围说明，不能声称拖拽已经有未实现的键盘移动替代。

本轮搜索图标修订：默认搜索只显示放大镜，显式选择的必应、Google、DuckDuckGo显示包内Logo；没有改动Search API或持久默认选择规则。自定义引擎在添加／保存修改的手势内请求具体来源权限并安全读取根首页及同源图标，复用现有可选HTTP／HTTPS来源范围，不增加安装时权限。该用途应与网站识别一起在商店权限说明披露；图像只作本地缓存，不进入同步／ZIP。纯网页文字回退不能证明真实扩展授权、抓取或商店审核通过。

## 搜索与新标签页

| 事项 | 级别及官方规则 | OwnTab 的实施约束 | 官方来源 |
| --- | --- | --- | --- |
| 新标签页覆盖 | **MUST**：使用适用于该用途的 Chrome API，禁止绕过 URL Overrides API | `chrome_url_overrides.newtab` 指向插件包内页面，不以监听新标签后重定向代替 | [API Use](https://developer.chrome.com/docs/webstore/program-policies/api-use)、[覆盖 Chrome 页面](https://developer.chrome.com/docs/extensions/develop/ui/override-chrome-pages) |
| 默认网页搜索 | **MUST**：NTP 网页搜索尊重浏览器现有搜索设置并使用 Chrome Search API | 默认项为“浏览器默认”，通过 `chrome.search.query` 提交，不固定拼接某个通用搜索引擎 URL | [Quality guidelines FAQ](https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines-faq) |
| Search API 的功能 | **API 能力**：通过浏览器默认搜索提供商执行查询，需要 `search` 权限 | 不把该 API 描述为任意搜索引擎选择或读取引擎品牌的 API；界面显示“默认” | [Chrome Search API](https://developer.chrome.com/docs/extensions/reference/api/search) |
| 多网页搜索选项 | **有条件允许**：顶部或默认项须由浏览器默认设置决定，官方举例允许下拉引擎列表 | 额外引擎仅在用户显式选择后使用；保留不可删除的“浏览器默认”项 | [FAQ：Can my NTP provide multiple web search options?](https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines-faq) |
| 默认搜索设置修改 | **MUST**：修改浏览器默认搜索只能通过 Settings Overrides API，并满足以搜索为主要用途等限制 | 当前无此需求，不声明 `chrome_settings_overrides.search_provider`，不改变用户浏览器设置 | [FAQ：Can my extension make changes to the default search settings?](https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines-faq) |
| 本地内容搜索 | **允许**：特定数据集或上下文的垂直搜索与通用网页搜索有区别 | 已保存网址的名称、域名和位置在本地匹配，不读取浏览历史 | [FAQ：vertical search](https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines-faq) |
| 单一用途 | **MUST**：用途狭窄易懂，不捆绑无关功能 | “可定制的网站导航新标签页”，网站导航、搜索、外观和布局均围绕该用途 | [Quality guidelines](https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines) |

FAQ 的关键原文：

> “by using the Chrome Search API”
>
> “must default to the web search provider the user has listed in their settings.”

不能据此概括为“所有非默认搜索引擎都被禁止”。该 FAQ 明确允许多搜索选项，但没有细述非默认引擎的具体提交实现。

OwnTab 每次新标签页初始都恢复到“浏览器默认”，不把一次显式选中的其他引擎保存为下次默认。这是**保守实施策略**，不是官方明确规定的重置机制。额外引擎配置和排序可以保存，并在用户开启浏览器同步后参与配置同步；临时选项不参与同步。非默认项按 URL 模板提交的具体行为，在上架前仍需结合实际实现复核，不宣称已获得商店认可。

## 权限、数据和代码

本轮增加的简洁时间日期属于新标签页的本地显示偏好，只使用 `Date`／`Intl` 与设备本地时区，无需增加 Chrome 权限；不读取日历、位置或外部时间服务。显示开关可随外观配置同步，当前时间与设备时区不保存或同步。界面改用自定义选择控件不改变默认搜索 API、站点授权或数据接收方。是否满足单一用途仍需结合最终页面及商店材料检查，不把采用 Apple 风格或某个扩展框架视为商店通过条件。

| 事项 | 级别及规则 | OwnTab 的实施约束 | 官方来源 |
| --- | --- | --- | --- |
| 最低权限 | **MUST**：只申请现有功能必需且访问范围最小的权限，包含可选权限；不能为未来预申请 | `storage`、`search`、Bing 图片所需主机，以及网站识别的按来源可选授权；安装时不取得全部网站访问，不申请历史记录或书签库 | [Use of Permissions](https://developer.chrome.com/docs/webstore/program-policies/permissions)、[User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq) |
| 本地及同步处理披露 | **MUST**：只在设备上处理或存储仍须披露，接收方及用途应准确 | 说明本地配置和缓存、可选浏览器厂商同步、默认 Bing 请求、网站名称与图标识别及各接收方的连接信息；“不上传给开发者”不能替代数据处理说明 | [User Data FAQ，问题 3、14](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)、[Privacy Policies](https://developer.chrome.com/docs/webstore/program-policies/privacy) |
| 隐私政策 | **MUST**：处理用户数据时提供准确、最新政策，披露收集、使用、分享及接收方，链接填入商店指定字段 | 以[隐私说明](隐私说明.md)为当前开发基线，发布前配置有效可访问的政策链接 | [Privacy Policies](https://developer.chrome.com/docs/webstore/program-policies/privacy) |
| 商店隐私表单 | **MUST**：填写用途、权限理由、远程代码和数据使用披露及认证，声明与政策、行为一致 | 对照最终发布包逐项填表；本地数据不能仅因无服务器就省略说明 | [Fill out the privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy) |
| Limited Use | **MUST**：只处理披露用途必要的数据，限制分享，不将其用于广告或出售；按适用规则披露遵守声明 | 无追踪、无广告、无数据出售；仅处理四模块及保存、恢复和用户启用的同步所需内容 | [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use) |
| MV3 远程代码 | **MUST**：插件逻辑应可从提交代码审查，不从外部加载和执行代码；存在文档列明的有限例外 | 当前不使用例外，应用脚本与依赖包内发布，不远程 `eval` 或注入脚本 | [Additional Requirements for Manifest V3](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements) |
| 远程数据和图片 | **明确允许的图片资源类型**：不执行逻辑的远程图片不属于远程代码禁令 | Bing JSON 和站点 HTML 仅作为数据处理，站点图标校验重编码，图片以本地 Blob 显示；不执行返回的脚本、不嵌入远程页面。这不等于取得图片授权，也不免除权限、隐私和网络核查 | [同一 MV3 规范](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements) |

## 网站名称和图标识别的可选主机权限

新增网站需要支持用户在运行时输入任意 HTTP／HTTPS 站点，因此清单在 `optional_host_permissions` 声明 `http://*/*` 和 `https://*/*`。这只是可申请的来源范围，不能写成安装时已经获得所有来源访问。每次需要新增权限时，通过用户点击识别按钮触发 `chrome.permissions.request({origins: [目标来源 + '/*']})`；已授权来源才允许输入后自动识别。拒绝授权仍可手动添加。Chrome 官方明确区分可选权限声明和运行时来源子集，并要求请求发生在用户手势内。[Permissions API](https://developer.chrome.com/docs/extensions/reference/api/permissions)

识别直接请求目标来源的根首页及同源 PNG、JPEG、WebP、ICO 图标，不传送输入网址的路径、查询或片段，不使用第三方图标代理；省略凭据和来源页，拒绝跨来源重定向及图标，验证响应大小、类型和解码尺寸。HTML 只提取标题及图标地址，不执行脚本、不加载页面内其他资源。扩展前台跨来源读取依赖主机权限；CSP 连接策略还需允许实际目标协议，因此不能继续把发布包 CSP 描述为只允许 Bing 的固定来源，必须由逐来源权限和请求校验共同限制访问。[跨来源请求与 CSP](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)

上架材料要说明该可选范围与“用户自行添加任意网站并识别名称、图标”这一现有功能的关系，以及实际逐来源授权行为；不能笼统声称“没有网站访问权限”。用户可在浏览器的扩展权限页撤销站点权限。普通网页预览没有扩展授权 API，不以本地代理绕过这一边界；静态清单检查和 API 替身不能证明真实 Chrome／Edge 的权限弹窗及跨来源请求已通过。

## Bing 每日背景的实施与发布边界

用户已确认使用 Bing 每日图片接口，本轮将其设为新安装默认背景；该功能不增加信息流或在线信息模块。请求限定为 `https://www.bing.com/HPImageArchive.aspx` 图片信息及同主机 `/th` 图片资源，所需主机权限为 `https://www.bing.com/*`。不使用自建代理，不携带 Bing 凭据、不发送来源页，不传送导航或搜索数据给背景服务。CSP 的连接来源仅增加实际实现需要的该 HTTPS 主机，执行代码仍随包发布。

每设备独立按日刷新，在独立 IndexedDB 缓存一张图片；失败冷却 15 分钟，并回退旧缓存或内置图片。定时及页面重新可见检查不绕过缓存和冷却。壁纸不进入 `storage.sync` 或新备份，不再接收用户上传的壁纸。选择内置、纯色或渐变后停止后续 Bing 背景请求；不能继续宣传“默认零联网”。

上架前需要核查：

- 图片信息接口可访问，但没有已确认的第三方正式 API 稳定性承诺；需要超时、响应校验和来源限制，不能依赖永远可用。
- [微软 Bing 首页说明](https://support.microsoft.com/en-us/bing/explore-the-homepage)指出部分图片因许可限制不能下载。[微软服务协议](https://www.microsoft.com/en-us/servicesagreement)与[版权许可说明](https://www.microsoft.com/en-us/legal/intellectualproperty/copyright/permissions)仍需结合具体图片、缓存及再展示方式核实；免费或无广告不自动取得使用权，`wp` 字段也不是许可文本。
- 页面展示接口返回的版权说明及来源链接；链接和文字作为数据校验，不执行服务返回的代码。
- 隐私政策和商店表单说明 Bing 是背景请求接收方，可获得 IP、时间、路径等连接信息，省略凭据不等于匿名请求。
- 在真实扩展中验证 Cookie／Referer 策略、仅单主机请求、重定向约束、缓存命中、刷新节流、失败回退以及切换后停止请求。

授权和接口核查作为发布条件记录，不将其作为本轮已获用户授权的实现工作的阻断理由。

## 浏览器原生同步

用户已确认采用 `chrome.storage.sync`；无需 OwnTab 账号或服务器。默认关闭，数据设置中说明浏览器账号和厂商处理后由用户主动开启；`storage` 权限同时覆盖本地和同步存储，不需 `identity` 或浏览历史权限。OwnTab 不能替用户开启浏览器账号同步，也不承诺 Chrome 与 Edge 之间互通。

[Chrome Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage) 列出同步总量 102,400 字节、单项 8,192 字节、最多 512 项，以及写入速率限制。分片不能突破总配额；每设备副本、删除记录、提交头和暂存新分片也占用空间，有效配置容量低于 100KB，设备和历史增多时可能提前达到限额。实现保留 `storage.local` 主副本，只同步可移植配置，预检容量并处理 API 配额错误；不截断配置、不删除本地数据、不把一次成功写入解释为其他设备已收到。

本轮实现使用每设备独立副本、分片与完整性提交头，再合并实体和逐字段设置；删除保留记录，同条目并发修改保留可恢复冲突，持久化至少 10 秒的发布间隔。协议用注入 API 的多设备模拟测试，真实云端多设备传播尚未验收，详见[验证记录](验证记录.md)。自定义图标图片及本地引用不进入同步，另一设备显示文字图标；Bing 缓存、本地快照、备份和瞬时搜索状态也不进入同步。

关闭插件同步只停止其同步行为，不承诺删除浏览器厂商保存的副本。商店披露必须同时说明开启条件、同步字段、数据接收方、关闭边界和失败恢复，避免把“无 OwnTab 服务器”写成“完全不向外传送数据”。

## 上架前待验收清单

以下均为**待执行**，不能把文档检查等同于运行验收或商店审核。

- [ ] 对最终 ZIP 解包检查，Manifest V3、包内页面、资源引用和版本正确。
- [ ] 核对 `storage`、`search`、`https://www.bing.com/*` 及 HTTP／HTTPS 可选来源范围的实际用途；网站识别只逐来源请求，不整体获取所有站点授权，没有未使用或未来权限。
- [ ] 在真实 Chrome 中修改默认引擎，验证新标签默认搜索始终由 `chrome.search.query` 跟随；不假称识别品牌。
- [ ] 验证其他引擎需要显式选择，新标签初始恢复“浏览器默认”；对非默认 URL 实现重新核对当日政策。
- [ ] 验证本地搜索、直接网址访问、特殊字符编码和无效协议拦截。
- [ ] 在真实 Chrome／Edge 验证网站识别的首次点击授权、拒绝／撤销后的手动路径、已授权来源自动识别和跨来源限制；HTML／图标大小、格式、超时、恶意响应与异步编辑竞态均有明确处理。
- [ ] 检查发布包网络：Bing 请求仅图片信息及图片；网站识别仅目标根首页及同源图标，两者无 Cookie／Referer、无第三方图标代理；手动编辑、本地搜索输入和导入导出不额外抓取网站。
- [ ] 检查 Bing 响应、版权和来源展示、缓存不进同步或备份、离线／超时／损坏响应回退、切换背景后停止请求及每日刷新节流。
- [ ] 用真实 Chrome 和 Edge 的两台设备或独立配置验证同步开关、账号条件、初次合并、离线合并、并发编辑／删除、冲突恢复、跨设备图标回退、超限与限频提示。
- [ ] 确认同步状态只反映能证明的阶段；不把写入同步存储成功说成另一设备已收到，关闭时不宣称云端数据已删除。
- [ ] 检查运行代码均在包内，无遥测、广告、远程执行或推广参数。
- [ ] 完成本地数据保存、删除、备份恢复、旧壁纸迁移、多分组合并为单桌面、旧同步副本与备份兼容、容量异常和多标签验证。
- [ ] 完成 Chrome、Edge 的键盘、窗口缩放、外观可读性和实际性能验证。
- [ ] 准备准确图标、截图、描述、单一用途及逐项权限理由；声明与实现一致。
- [ ] 配置可访问的隐私政策链接，完成隐私表单、Limited Use 认证及开发者账号发布条件检查。
- [ ] 重新核查官方政策，记录提交包、浏览器版本、验收结果和已知限制；实际提交与审核结果另行记录。

官方说明：[违规排查](https://developer.chrome.com/docs/webstore/troubleshooting)。符合开发规范不能保证自动通过审核。

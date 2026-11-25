# 本地阅读器验证（2026-11-25）

基线为 main 上已发布 0.6.0 之后的本机工作树。不更改版本、不推送、不发布。

## 自动化验证

- `npm test`：**1,112 项通过，0 失败、0 跳过**，退出码 0。
- `npm run build:unpacked`：通过，退出码 0，输出仍为 `app/dist/extension`，版本 0.6.0。
- `npm run check:extension`：通过，退出码 0；56 个文件、2 HTML、20 JS、3 CSS。新增的两个网络模块逐个纳入审查范围，并检查精确来源权限、凭据省略、无 Referer、禁止重定向、有界请求及没有固定远程代理。

重点覆盖提取失败保留链接、危险网页在 DOM 解析之前去资源化、URL 片段、空图片说明的文本锚点、访问权限/超时/响应大小、并发高亮、删除或改址后的迟到响应、正文变化保护高亮、容量拒绝、加密提交失败、孤立正文显式清理、正文/批注结构化匹配、隐藏内容计数、Markdown 高亮与隐私、导出预览失效、设备专属集合的实际同步快照/导入边界、RSS 解析失败保留旧数据和 alarm 生命周期。

稳定日志为 `output/playwright/local-reader-npm-test.log`、`local-reader-build.log`、`local-reader-extension-check.log` 和 `local-reader-browser.log`，目录名称沿用仓库现有约定；本次不使用 Playwright。

## 真实浏览器流程

运行器：`app/scripts/verify-local-reader-browser.mjs`。使用本机已安装的 Chrome、独立临时配置和当前 unpacked 构建的测试副本，通过原生 CDP 操作生产界面。公开 MDN 的 20 篇 API 文章由浏览器实时请求，保存、打开和选区高亮操作走生产 React 控件，搜索和 Markdown 内容通过打包的生产 API 检查持久化结果。另以明确标注的合成恶意 HTML 和单张图片响应检查无预取边界。

测试副本额外授予 MDN、Mozilla Hacks RSS 与合成测试来源的精确权限；生产 manifest 不扩权。桥接代码不替代抽取、加密 IndexedDB、高亮、搜索、导出或 RSS 实现。没有读取用户浏览器内容或使用真实同步凭据。

结果：**通过**。Chrome `157.0.8103.79`；20 篇真实 MDN 文章逐篇通过保存、打开本机正文、选区高亮、添加独有备注、列表内全文搜索、结构化搜索、单篇 Markdown 生产按钮实际下载及内容核对。保存的 20 个 Markdown 文件均含对应选区和备注；重启相同测试配置后，20 篇正文及高亮全部持久存在。

真实语料为 MDN 的 AbortController、AbortSignal、URL、URLSearchParams、Headers、Request、Response、Fetch API、ReadableStream、WritableStream、TransformStream、Blob、File、FileReader、TextEncoder、TextDecoder、DOMParser、Document、Element、Event；每篇抽取标题均包含 MDN，正文超过 500 字符，避免把错误页算作成功。

字号 20、行距 2、深色外观通过实际控件事件保存，截图人工查看布局和高亮。页面会话的网络记录在 20 篇流程中恰好只包含所选文章 HTML；恶意 HTML 中的图片、iframe、script、style 均未发起请求，阅读正文没有这些可执行节点。点击单张合成图片后才发生一次请求，图片验证为栅格字节后通过 Blob URL 显示；这一张响应使用测试图片替代，没有将该部分标为真实网页图片网络验收。

真实 Mozilla Hacks RSS 地址 `https://hacks.mozilla.org/feed/` 拉取成功，获得 20 条标题/摘要/链接；向生产 service worker 发送刷新消息成功，并有下一次 alarm。刷新前后文章缓存均为 21 篇（20 篇真实文章加 1 篇恶意 HTML 测试文章），证明 RSS 刷新未抽取正文。没有等待真实 15 分钟以上的定时周期；到期筛选、重启恢复和事件注册由单元测试覆盖。

真实流程曾暴露新配置默认偏好尚未持久化时，版本 0 被误判为并发更新的问题；修正后补齐无偏好记录的首次高亮回归测试，并重新完成上述全量检查与 20 篇流程。另有初始异步读取覆盖较新订阅事件的竞态、批注草稿切换丢失、改址后旧正文无法清除的问题，均已修正并加入界面回归测试。

凭据与浏览器配置不进入仓库，运行器在 finally 中已清理自己创建的临时浏览器配置及构建副本。证据位于 `output/playwright/covelet/local-reader/`：`browser.json`、`reader-dark-typography.png`、`first-article-highlight.png`、`no-image-prefetch.png`，以及 `markdown/Reader QA 01.md` 至 `Reader QA 20.md`。正文/批注/RSS 设备专属键也已从实际同步快照确认排除。

测试下载目录另外出现 `downloads.htm`；清理这个额外测试输出的 PowerShell 删除操作被自动审批以 `blocked by policy` 拒绝，文件仍保留。它没有进入源码、构建或验证断言，20 个 Markdown 文件的内容核对不受影响。

这是浏览器端自动交互验证，不能标为人工手动验收。人工复核步骤如下：

1. 加载 `app/dist/extension`，打开稍后读，逐条保存 20 篇不同文章，允许各自精确来源。断网或拒绝其中一篇权限，确认链接和手填标题仍保存。
2. 打开各篇本机正文，调整字号、行距和深浅色。检查开发者工具 Network：普通阅读与抽取不请求内嵌图片、脚本或外部样式；点击单张图片后才请求其来源。
3. 每篇选择一段文字，高亮并写入独有备注。关闭后重新打开，确认选区和备注存在；重启浏览器再确认。
4. 用正文独有词和备注搜索，组合 `type:reading is:unread domain:… tag:…`。切到隐藏模式，确认隐藏阅读记录及私密文件夹继承内容不进入结果、摘要或数量。
5. 从阅读器和 Markdown 资料库导出，确认文件包含正文、高亮和备注，提示未加密，且没有隐藏记录、图片预取语法或私密文件夹内容。
6. 添加有效 RSS/Atom 订阅，检查标题、纯文本摘要和链接；打开文章才抽取正文。关闭 Covelet 页面等待设定周期，重新打开收件箱确认更新。使用错误地址或无效 XML，确认已有条目仍在并有可见错误。

## 已知边界

登录内容、付费墙、客户端渲染正文、重定向来源或超过容量的网页允许抽取失败并保留链接。RSS 在浏览器关闭时不运行；重新启动后恢复 alarm。正文/批注是设备专属集合，不进入云同步和现有完整备份；需要携带的公开文章可明确导出 Markdown。人工手动复核未由本次自动化替代。

# Covelet v0.2.1 商店候选材料

状态：**候选材料已定稿、未提交**。

文案和截图来自 QA/CEO 候选材料目录 `/workspace/covelet-store-021-materials/`，按原文件复制。本 PR 仅整理仓库材料，不操作 Chrome / Edge 商店，不提交审核。

Chrome 线上仍为 **v0.2.0**，扩展 ID `clkholbmabommppnlpcnhdgmibibblgb`。相对线上 0.2.0，本候选下线标签快照和浏览器 Reading List 导入，并剥离 17 项扩展工具包；便笺和手动稍后读保留。

文案：

- EN：[listing-en.txt](listing-en.txt)（`docs/store/v0.2.1/listing-en.txt`）
- ZH：[listing-zh-CN.txt](listing-zh-CN.txt)（`docs/store/v0.2.1/listing-zh-CN.txt`）
- [审核说明](reviewer-notes.txt)

截图保存在 `docs/store/assets/v0.2.1/`：

- [b-newtab.png](../assets/v0.2.1/b-newtab.png) — 新标签页
- [c1-extension-center.png](../assets/v0.2.1/c1-extension-center.png) — 扩展中心，不含 17 项工具包
- [c2-settings-data.png](../assets/v0.2.1/c2-settings-data.png) — 设置／数据
- [a-extensions-0.2.1.png](../assets/v0.2.1/a-extensions-0.2.1.png) — 扩展版本 0.2.1
- [a2-details-permissions.png](../assets/v0.2.1/a2-details-permissions.png) — 权限详情

截图保留原始捕获文件；上传前可能需要裁剪至 **1280×800**（Screenshots may need crop to 1280×800 before upload）。

发布 ZIP 由 tag 对应的代码自动构建为 `covelet-0.2.1.zip`，本次构建的 SHA256 记录在 GitHub Release notes 中。材料目录不再指定本机 ZIP 路径或固定校验值。

隐私：已核对 [v0.2.1 政策](privacy-policy.txt)、[根目录 TXT](../privacy-policy.txt) 和 [HTML](../privacy-policy.html) 使用 `support@morley.work`，无浏览器原生同步，不请求 tabs / readingList 权限。托管 Google Sites 隐私页 **待更新**，不在本 PR 范围内；仓库材料不代表托管页已发布。

## Chrome / Edge 自动发布

参见 [自动发布 CI 使用与配置说明](../release-ci.md)：推送 `v0.2.1` 等发布 tag 会自动构建 ZIP、生成 SHA256、创建或更新 GitHub Release，并向 **Chrome 和 Edge 两个商店提交审核**；也可通过 `workflow_dispatch` 的 `tag` 输入重跑。

发布前配置 `chrome-web-store` 和 `edge-addons` 两个 GitHub Environments 的 secrets，建议启用 required reviewers。**Edge 首次提交必须先在 Partner Center 手动完成；0.2.1 需要准备已有产品及 Edge secrets，API 只能更新已有产品。**

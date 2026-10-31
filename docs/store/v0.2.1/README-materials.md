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

锁定 ZIP：`covelet-0.2.1.zip`，来自 main `22f725cc5c33c468bd8e468f47bd18b11de32bb2`。SHA256：

```text
bd2e26cb50a5bd3b1183677fdd89275b9499b774a25624f6a4d5c26a85d860dd
```

原本机路径：`/workspace/covelet-store-021/app/dist/covelet-0.2.1.zip`。本 PR 不重建、不修改、不提交 ZIP，也不修改 `app/` 源码。

隐私：已核对 [v0.2.1 政策](privacy-policy.txt)、[根目录 TXT](../privacy-policy.txt) 和 [HTML](../privacy-policy.html) 使用 `support@morley.work`，无浏览器原生同步，不请求 tabs / readingList 权限。托管 Google Sites 隐私页 **待更新**，不在本 PR 范围内；仓库材料不代表托管页已发布。

**Do not merge — waiting CoS/CTO OK**。本 PR 不授权商店上传或提交。

## Chrome Web Store CI（Path A，待批准）

[publish-cws.yml](../../../.github/workflows/publish-cws.yml) 使用 **Path A = Chrome Web Store API v2 + Service Account**，仅支持手动 `workflow_dispatch`，不构建扩展。**Do not merge — waiting CoS/CTO/exec OK**；本 PR 不执行上传或商店提交。**Do not workflow_dispatch until Secrets ready and exec re-OK**。

在 GitHub Settings → Environments 创建 `chrome-web-store`，将 `CWS_SERVICE_ACCOUNT_JSON`（服务账号 JSON key）和 `CWS_PUBLISHER_ID` 放在该 Environment 的 Secrets 中；exec 稍后配置 required reviewers。`CWS_EXTENSION_ID` 为可选配置名，但当前工作流使用固定 ID `clkholbmabommppnlpcnhdgmibibblgb`，不读取该 Secret。服务账号须配置商店发布者访问权限；按 [auth action 文档](https://github.com/google-github-actions/auth#inputs-service-account-key-json)配置自身的 `roles/iam.serviceAccountTokenCreator` 权限及所需 API，令牌 scope 为 `https://www.googleapis.com/auth/chromewebstore`。工作流首先检查两个必需 Secret，缺少任一个即失败。

ZIP 策略：**Release asset（或其他可信 HTTPS）+ `zip_url` 输入 + SHA256 gate**。目前尚无 GitHub Release；维护者须在任何 dispatch 前创建例如 `v0.2.1-candidate` 的 Release，在 Assets → Attach binaries 中附加来自 `22f725cc5c33c468bd8e468f47bd18b11de32bb2` 的锁定 `covelet-0.2.1.zip`（原路径见上文），并复制可直接下载的 HTTPS asset URL 作为必填 `zip_url`；URL 必须能由 runner 下载。不要将约 4 MB ZIP 提交进 git。下载及重定向仅允许 HTTPS；`sha256sum` 必须精确匹配上文完整 SHA256，否则在认证和上传前终止。

批准后，`publish_live=false`（默认）只调用 [API v2 upload](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/media/upload) 更新商店草稿；仍属于真实商店上传。只有 `publish_live=true` 才额外调用 [publish](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish) 提交审核，通过后默认发布，并不表示绕过审核或保证立即上线。HTTP / 网络错误会输出响应并失败；上传返回非 `SUCCEEDED`（包括处理中）也会阻止后续提交，需人工检查响应／Dashboard。准备此 PR 期间不得 dispatch、上传或提交。

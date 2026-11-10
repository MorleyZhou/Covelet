# GitHub 发布与可选商店提交 CI

推送 `v*` tag 会构建 ZIP、生成校验文件并创建或更新 GitHub Release。商店送审由手动运行 `workflow_dispatch` 并显式设置 **`submit_stores=true`** 触发，默认值为 `false`。

工作流：[release-stores.yml](../../.github/workflows/release-stores.yml)，Actions 名称为 **GitHub release and optional store submission**。审核通过后的上线时间由商店决定；CI 成功不代表商店已上线。

| 触发方式 | GitHub Release | 两个商店 |
| --- | --- | --- |
| 推送 `vX.Y.Z` tag | 构建并创建或更新 | 跳过 |
| 手动运行，`submit_stores=false`（默认） | 构建并创建或更新 | 跳过 |
| 手动运行，`submit_stores=true` | 构建并创建或更新 | 上传并提交审核 |

## 开发批次与正式版本

`main` 是稳定线。双数补丁号用作内部功能批次编号。每项功能从对应的集成分支开分支，经 PR 和 CI 合回该批次。双数批次使用本地解压包或 CI 验证，禁止推送对应的发布 tag。

| 用途 | 分支或版本 | 流程 |
| --- | --- | --- |
| 0.4 功能批次 | `feature/0.3.2-for-0.4` | [12 项功能及验收标准](../0.4.0%20功能范围.md)。整批验收后合入稳定线并发布 `0.4.0` |
| 0.5 功能批次 | `feature/0.3.4-for-0.5` | 在开始 0.5 功能时建分支。并行开发时，在整批验收前合入 `0.4.0` 的正式基线。累计 10–15 项通过验收的新功能后发布 `0.5.0` |
| 线上修复 | `0.3.3`、`0.3.5` 等奇数补丁 | 从当前稳定线起修复分支，按需发版。修复合入 `main` 后，同步到进行中的功能批次 |

双数编号写在分支名中。制作正式发布包时，统一将 package、lockfile 和 manifest 改为正式版本号。商店提交的版本必须递增。`0.4.0` 提交后，后续商店修复使用 `0.4.1`、`0.4.3` 等版本。参见 [Chrome 更新规则](https://developer.chrome.com/docs/webstore/update)和 [Edge 更新规则](https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/update-extension)。

## 首次配置

仅发布 GitHub 包不需要商店凭据。需要提交商店时，在 GitHub **Settings → Environments** 创建以下环境，分别配置 Environment secrets。建议两个环境都启用 **Required reviewers**，在构建及 GitHub Release 完成后、商店上传前审批；显式开启商店提交且未配置审批时会自动提交。环境的部署规则需要允许发布 tag，以及手动运行时选择的工作流分支。

| Environment | 必需 Secrets |
| --- | --- |
| `chrome-web-store` | `CWS_SERVICE_ACCOUNT_JSON`、`CWS_PUBLISHER_ID` |
| `edge-addons` | `EDGE_CLIENT_ID`、`EDGE_API_KEY`、`EDGE_PRODUCT_ID` |

Chrome 沿用 **Chrome Web Store API v2 + Service Account**，扩展 ID 为 `clkholbmabommppnlpcnhdgmibibblgb`。服务账号须有对应发布者的商店访问权限，并启用所需 API；`CWS_SERVICE_ACCOUNT_JSON` 保存 JSON key，`CWS_PUBLISHER_ID` 保存发布者 ID。按 [Google auth action 的服务账号配置说明](https://github.com/google-github-actions/auth#inputs-service-account-key-json)配置生成访问令牌所需的 `roles/iam.serviceAccountTokenCreator` 权限。工作流使用 `https://www.googleapis.com/auth/chromewebstore` scope。

Edge 使用 **Add-ons API v1.1 API key**，请求头为 `Authorization: ApiKey ...` 和 `X-ClientID: ...`，不使用旧版 OAuth client secret。设置步骤：

1. 先在 **Microsoft Partner Center** 创建扩展产品。**首次提交必须手动在 Partner Center 完成，API 只能更新已有产品，不能创建产品或替代首次提交。** 后续 API 更新需要完成首次提交并配置下面的 secrets。
2. 在 **Microsoft Edge → Publish API** 页面点击 **enable the new experience → Enable**，再点击 **Create API credentials**。
3. 将 Client ID 保存为 `EDGE_CLIENT_ID`，API key 保存为 `EDGE_API_KEY`，Partner Center 产品 ID 保存为 `EDGE_PRODUCT_ID`。产品 ID 与公开扩展 ID 不同；留意 API key 到期并及时轮换。

参见 [Microsoft Edge Add-ons API 设置文档](https://learn.microsoft.com/microsoft-edge/extensions/publish/api/using-addons-api)及[当前更新 API 文档](https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/using-addons-api)。缺少任何必需 secret，相关 job 会列出缺少项并失败；Edge 错误会同时提示 Partner Center 设置步骤。

## 发布一个版本

1. 将 `app/package.json` 和 `app/extension.manifest.json` 的版本同时改为 `X.Y.Z`，按需更新 `app/package-lock.json` 的版本元数据，并编写 `docs/releases/X.Y.Z.md`；提交并确保提交已在远端。
2. 在目标提交上创建并推送 annotated tag（例如 `v0.3.0`）：

   ```bash
   git tag -a vX.Y.Z -m "Release vX.Y.Z"
   git push origin vX.Y.Z
   ```

3. 在 GitHub Actions 查看 **GitHub release and optional store submission**，核对 GitHub Release 附件与校验结果。tag 运行中的两个商店 job 应跳过。

构建 job 精确检出 tag，使用 Node.js 22 和 `npm ci`，执行 `build:extension` 及存在时的 `check:extension`。tag 必须是 `vX.Y.Z`，去掉 `v` 后必须与 package、源 manifest 以及 `app/dist/extension/manifest.json` 的版本一致，否则终止。

工作流只分发本次构建的 `app/dist/covelet-X.Y.Z.zip`：计算 SHA256 后，将 ZIP、`SHA256SUMS.txt` 和 release notes 上传 Actions artifact。GitHub 发布及显式开启的商店 job 下载并校验同一 ZIP。发布正文读取 `docs/releases/X.Y.Z.md`，附上包名与 SHA256；缺少该说明时构建失败。GitHub Release 附件包含 ZIP 和 `SHA256SUMS.txt`；已存在则覆盖同名附件并更新正文。无需手动准备或上传 ZIP，也无需外部 ZIP 地址或固定校验值。不要将 ZIP 提交进 git。

只有手动运行并设置 `submit_stores=true` 时，GitHub Release 成功后才会运行 Chrome 与 Edge job；启用 Required reviewers 时还需批准对应环境。两个商店独立运行：Chrome 上传成功才提交，异步上传会轮询 `fetchStatus`；Edge 上传和提交都根据 `Location` 中的 operation ID 轮询，必须得到 `Succeeded`。网络、HTTP、处理失败、未知状态或轮询超时都会使对应 job 失败，不能视为成功提交。一个商店失败不阻止另一个商店提交，也不会撤销已创建的 GitHub Release。全流程使用 `release-stores` concurrency group，不取消正在执行的发布。

## 手动重跑

在 **Actions → GitHub release and optional store submission → Run workflow** 选择包含此工作流的分支，填写必需输入 **`tag`**（例如 `v0.3.0`），并保持 **`submit_stores=false`** 即可只重建和更新 GitHub Release。只有另行明确决定提交两个商店时才设为 `true`。即使选的是工作流分支，构建代码仍会精确检出输入的 tag，而不是分支最新提交。该工作流需要先合入默认分支，GitHub 才会提供手动运行入口。

手动重跑会重新构建并覆盖 GitHub Release 的同名附件和正文。**设置 `submit_stores=true` 会再次提交两个商店**，不会自动跳过已成功的商店；商店可能拒绝重复版本或正在审核中的提交，错误会直接失败。需要只重试失败的商店时，可在同一次已开启商店提交的运行中使用 GitHub 的 **Re-run failed jobs**，复用该运行仍未过期的 artifact。

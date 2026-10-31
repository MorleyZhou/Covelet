# Chrome / Edge 自动发布 CI

**WARNING：推送 `v*` tag 会自动构建 ZIP、创建或更新 GitHub Release，并向 Chrome Web Store 和 Microsoft Edge Add-ons 两个商店上传并提交审核。** `workflow_dispatch` 也会执行完整流程。审核通过后的上线时间由商店决定；CI 成功不代表已上线。

工作流：[release-stores.yml](../../.github/workflows/release-stores.yml)。仅 CI 与文档变化不会执行商店操作；推送发布 tag 或手动运行工作流才会触发。

## 首次配置

在 GitHub **Settings → Environments** 创建以下环境，分别配置 Environment secrets。建议两个环境都启用 **Required reviewers**，在构建及 GitHub Release 完成后、商店上传前审批；不配置审批时会自动提交。环境的部署规则需要允许发布 tag，以及手动运行时选择的工作流分支。

| Environment | 必需 Secrets |
| --- | --- |
| `chrome-web-store` | `CWS_SERVICE_ACCOUNT_JSON`、`CWS_PUBLISHER_ID` |
| `edge-addons` | `EDGE_CLIENT_ID`、`EDGE_API_KEY`、`EDGE_PRODUCT_ID` |

Chrome 沿用 **Chrome Web Store API v2 + Service Account**，扩展 ID 为 `clkholbmabommppnlpcnhdgmibibblgb`。服务账号须有对应发布者的商店访问权限，并启用所需 API；`CWS_SERVICE_ACCOUNT_JSON` 保存 JSON key，`CWS_PUBLISHER_ID` 保存发布者 ID。按 [Google auth action 的服务账号配置说明](https://github.com/google-github-actions/auth#inputs-service-account-key-json)配置生成访问令牌所需的 `roles/iam.serviceAccountTokenCreator` 权限。工作流使用 `https://www.googleapis.com/auth/chromewebstore` scope。

Edge 使用 **Add-ons API v1.1 API key**，请求头为 `Authorization: ApiKey ...` 和 `X-ClientID: ...`，不使用旧版 OAuth client secret。设置步骤：

1. 先在 **Microsoft Partner Center** 创建扩展产品。**首次提交必须手动在 Partner Center 完成，API 只能更新已有产品，不能创建产品或替代首次提交。** 因此 **0.2.1 的 Edge 发布需要先准备产品、手动首次提交以及下面的 secrets**。
2. 在 **Microsoft Edge → Publish API** 页面点击 **enable the new experience → Enable**，再点击 **Create API credentials**。
3. 将 Client ID 保存为 `EDGE_CLIENT_ID`，API key 保存为 `EDGE_API_KEY`，Partner Center 产品 ID 保存为 `EDGE_PRODUCT_ID`。产品 ID 与公开扩展 ID 不同；留意 API key 到期并及时轮换。

参见 [Microsoft Edge Add-ons API 设置文档](https://learn.microsoft.com/microsoft-edge/extensions/publish/api/using-addons-api)及[当前更新 API 文档](https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/using-addons-api)。缺少任何必需 secret，相关 job 会列出缺少项并失败；Edge 错误会同时提示 Partner Center 设置步骤。

## 发布一个版本

1. 将 `app/package.json` 和 `app/extension.manifest.json` 的版本同时改为 `X.Y.Z`，并按需更新 `app/package-lock.json` 的版本元数据；提交并确保提交已在远端。
2. 在目标提交上创建并推送 annotated tag（例如 `v0.2.1`）：

   ```bash
   git tag -a vX.Y.Z -m "Release vX.Y.Z"
   git push origin vX.Y.Z
   ```

3. 在 GitHub Actions 查看 **Release to Chrome and Edge**。启用 Required reviewers 时批准两个环境的部署。之后分别查看两个商店的审核结果。

构建 job 精确检出 tag，使用 Node.js 22 和 `npm ci`，执行 `build:extension` 及存在时的 `check:extension`。tag 必须是 `vX.Y.Z`，去掉 `v` 后必须与 package、源 manifest 以及 `app/dist/extension/manifest.json` 的版本一致，否则终止。

工作流只分发本次构建的 `app/dist/covelet-X.Y.Z.zip`：计算 SHA256 后上传 Actions artifact，下游三个 job 下载并校验同一 ZIP。GitHub Release 附件会自动创建，已存在则覆盖同名附件并更新生成的 release notes（包含当前 SHA256）。无需手动准备或上传 ZIP，也无需外部 ZIP 地址或固定校验值。不要将 ZIP 提交进 git。

GitHub Release 成功后，Chrome 与 Edge 独立运行：Chrome 上传成功才提交，异步上传会轮询 `fetchStatus`；Edge 上传和提交都根据 `Location` 中的 operation ID 轮询，必须得到 `Succeeded`。网络、HTTP、处理失败、未知状态或轮询超时都会使对应 job 失败，不能视为成功提交。一个商店失败不阻止另一个商店提交，也不会撤销已创建的 GitHub Release。全流程使用 `release-stores` concurrency group，不取消正在执行的发布。

## 手动重跑

在 **Actions → Release to Chrome and Edge → Run workflow** 选择包含此工作流的分支，并填写必需输入 **`tag`**（例如 `v0.2.1`）。即使选的是工作流分支，构建代码仍会精确检出输入的 tag，而不是分支最新提交。该工作流需要先合入默认分支，GitHub 才会提供手动运行入口。

补齐产品、权限或 secrets 后，可用该入口重跑。**手动重跑会重新构建、覆盖 GitHub Release 同名附件并重新提交两个商店**，不会自动跳过已成功的商店；商店可能拒绝重复版本或正在审核中的提交，错误会直接失败。需要只重试失败的商店时，可在同一次运行中使用 GitHub 的 **Re-run failed jobs**，复用该运行仍未过期的 artifact。

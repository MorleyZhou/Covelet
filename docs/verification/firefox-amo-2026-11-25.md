# Firefox AMO 0.7.0 候选与提交验证

日期：2026-11-25（Asia/Shanghai）。维护者已建立 `amo-addons` 环境并明确授权提交 Chrome、Edge、Firefox。环境已只读确认包含 `AMO_JWT_ISSUER`、`AMO_JWT_SECRET`，无额外审批规则；未读取或在本机保存密钥值。维护者随后确认 Chrome 已送审，后续仅处理 Firefox。

## 候选与 CI

- `npm test`：**1,234 项通过，0 失败、0 跳过**。
- Chrome / Firefox 正式构建、WASM 与扩展检查通过，各 57 个文件；本轮提交 Chrome/Edge 使用原 `v0.7.0` 包，不使用带新同意入口的本机重建 Chrome 包。
- Firefox 使用 main 历史中的固定 40 位候选 SHA，版本保持 0.7.0；不移动已发布的 tag。构建和源码包均来自该精确、干净提交，不接受未提交的构建输入。
- 数据声明为 `required: ["none"]` 和六类 optional，搜索及所有默认 HTTP 请求在实际出站前检查当前授权；未授权、不支持或撤权均停止相应新请求。不存在全局 fetch monkeypatch。便笺原生远程图片的初次 DOM 序列化、插入、阅读和撤权均另有门禁，原文不被投影覆盖。
- 单元回归覆盖真实 Folio/ProseMirror/React 的 image src 设置，未授权时 HTTP src 首次设置次数也为零；Chrome 不呈现此授权 UI，默认请求参数保持。
- AMO 客户端使用固定生产 API v5 与短期 HS256 JWT，上传校验、创建或更新版本、源码及政策分步处理。同版未能绑定本候选时停止，已有源码不能绕过绑定。日志仅保留字段名或校验代码，不打印原始响应、URL、凭据或 JWT。
- CI 在提交步骤才注入 Mozilla 密钥。原始候选、源码、metadata 与部分回执保存在 `firefox-amo-submission`；恢复核对源码 SHA 和全部输入摘要，使用原始 ZIP，不以重打包结果或签名后摘要冒充同一候选。单独提交 Firefox 不更新 GitHub Release 附件。

## 实际 Firefox 同意机制

使用官方已安装 Firefox 157，通过原生 Marionette 运行真实扩展页面，脚本为 `app/scripts/verify-firefox-data-consent.mjs`。只在隔离构建副本加入测试观察桥；产品代码、manifest、CSP 不变。原生权限存储测试插桩只授予本机测试来源及阅读所需的两类数据，不宣称测试了原生授权弹窗或人工签收。

| 场景 | 结果 |
| --- | --- |
| 初始声明/授权 | 实际 getAll.data_collection 为空，manifest 无必需传输且有六类 optional。 |
| 未授权读原文 | 生产抽取函数拒绝，fixture 收到 **0** 次请求。 |
| 本机操作 | 便笺可继续通过本机加密主副本保存。 |
| 授权与界面 | 生产隐私检查呈现五组；原生存储授予 reading 两类型后状态更新为已允许。 |
| 授权后读原文 | 正文抽取成功，fixture 总计 **1** 次 GET；无 Cookie、Authorization 或 Referer。 |
| 实际撤权 | browser.permissions.remove 后界面回到可授权；下一次读取拒绝，总请求仍为 **1**。 |
| 撤权后本机操作 | AES-GCM、不可导出设备 key 及本机写入继续可用。 |

使用空闲的 loopback 默认 HTTP 80 端口，测试结束已关闭服务并清理测试目录。Firefox 原生 host matching 不接受显式非默认端口；此前随机端口 fixture 出现 host-pattern/CORS 限制，不能据此伪装 consent 通过，也未为通过测试放宽产品权限/CSP。该平台限制未在本轮修复；非默认端口服务不在本次成功验收范围。

证据复用 `output/playwright/covelet/firefox/data-consent/native-consent.json`、`privacy-consent.png`；完整日志位于 `output/releases/v0.7.0/amo-*.log`。源码上传与商店实时回执以[发布状态](../store/发布状态.md)为准，候选验证不等于审核通过或已上线。

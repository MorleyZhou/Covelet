# 记录级同步合并验证记录

日期：2026-11-24（Asia/Shanghai）。仓库 `MorleyZhou/Covelet`，分支 `main`，基础与当前 HEAD 均为 `a3c01c2c4f570f4f8dd136d3b272cabed7433799`，应用版本保持 `0.6.0`。本次修改在工作区，尚未提交或推送；没有发布或商店操作。

## 已完成的工程检查

在 `app/` 中执行：

| 检查 | 实际结果 | 证据 |
| --- | --- | --- |
| `npm test` | 通过：917 个测试，917 通过，0 失败、取消、跳过 | [单元测试日志](../../output/playwright/record-merge-unit-tests.log) |
| `npm run build:unpacked` | 通过，输出 `app/dist/extension`，版本仍为 0.6.0 | [构建日志](../../output/playwright/record-merge-build.log) |
| `npm run check:extension` | 通过：55 个文件，2 HTML、19 JS、3 CSS | [扩展静态检查日志](../../output/playwright/record-merge-extension-check.log) |

覆盖包括两侧各自新增不同记录、同一记录不同字段修改、同一字段并发修改、一侧删除一侧修改、标签改名、文件夹移动、无可信基线时保留独有记录、因果祖先回退、失效预览、本机 CAS、加密恢复副本与容量边界。UI 测试另验证逐条选择、一次应用、撤销、分页选择保留、隐藏/锁定切换期间的异步预览作废，以及恢复副本读取失败后的重试。搜索引擎偏好通过本机加密存储持久化，不进入同步。

构建和静态检查不能证明真实浏览器交互、运行时 IndexedDB 提交或服务端跨浏览器验收。

容量追加检查补测：`record-sync-integration.test.js`、`full-data-sync.test.js`、`cloud-providers-integration.test.js` 共 81/81 通过。确认现有 2,000 个索引不能追加第 2,001 个；预览后达到 2,000 块时合并停止；撤销将超限时保留内容、元数据和已有恢复副本。文件夹删除与子项修改产生非法引用时，同样整次停止，用户调整文件夹选择后可正常应用。

## 真实 R2 传输验证：通过

用户后续将真实服务验收从 WebDAV 改为 R2。现有 WebDAV 支持及其回归测试保留。

执行脚本：[app/scripts/verify-record-merge-r2.mjs](../../app/scripts/verify-record-merge-r2.mjs)。脱敏回执：[record-merge-r2.json](../../output/playwright/covelet/record-merge-r2.json)。实际运行时间为 2026-11-24 15:48:24 至 15:49:04，共约 39.5 秒。

这次运行使用真实 R2 服务、正式 R2 适配器、打包的签名 WASM、现有全量同步加密，以及两个相互独立的加密本机数据实例。本机持久化后端为内存测试后端，业务数据为合成数据。它没有启动 Chrome 或 Edge，没有验证浏览器 UI，也不能代替真实 IndexedDB 和跨浏览器手动验收。

| 项目 | 回执结果 |
| --- | --- |
| 独立测试目录 | `covelet-record-merge-qa/20261124T074824643Z-2f8a1417-1f09-4d43-ba36-b9c3bb447ed8` |
| R2 请求 | 111 次；94 GET、17 PUT；上传 22,318 字节 |
| 合并预览 | 10 条；两侧都改 4 条、仅一侧改 6 条；明确选择 2 条 |
| 合并后数据 | 两侧快照摘要一致；4 条便笺、5 条导航；所有独有 ID 均保留 |
| 关联行为 | 标签 ID 保持、文件夹移动保持、本机偏好保持 |
| 恢复保护 | 合并前副本已保存 |
| 远端结果 | 4 个索引、13 个内容块；仅上传加密载荷 |

本轮真实 R2 数据没有删除/修改冲突（回执 `deleted: 0`）；这一情形由单元/集成测试覆盖，不能记作本轮真实服务验证通过。远端合成验证数据保留，便于复核。

复跑命令为在 `app/` 中执行 `node scripts/verify-record-merge-r2.mjs`。脚本从被 Git 忽略的本地配置 `output/playwright/covelet/live-config.local.json` 读取 R2 连接信息，每次创建独立测试前缀。此文档、脚本输出与回执不记录访问密钥、设备密钥或密码值；不要把本地连接配置加入版本控制。

## Chrome + Edge + R2 真实界面联调：通过

在安装的 Chrome `157.0.8103.79` 与 Edge `158.0.4370.33` 中，使用各自的隔离配置、真实 IndexedDB、真实 R2 和 Covelet `0.6.0` 完成验证。使用原生 CDP 进行界面操作，没有使用 Playwright。脚本为 [verify-record-merge-browsers.mjs](../../app/scripts/verify-record-merge-browsers.mjs) 与 [verify-record-merge-browser-r2.mjs](../../app/scripts/verify-record-merge-browser-r2.mjs)。

测试条件必须保留：运行的是当前 unpacked 扩展的独立测试副本，额外增加了一个精确 R2 域名授权和一个由当前源码构建的数据准备桥接脚本。桥接只调用现有 saveNote/saveState/加密存储接口准备共同身份和并发修改；连接配置、连接测试、同步、预览和应用使用实际产品界面。正式 `app/dist/extension`、正式 manifest 和用户日常配置没有因此修改。此结果不证明首次可选域名授权提示或无桥接的完整人工录入流程。

| 项目 | 实际结果 |
| --- | --- |
| 双端共同数据 | 真实 R2 交换共同便笺和导航基线 |
| 并发修改 | Chrome 修改共同便笺标题，Edge 修改同条正文；分别修改同批导航，并各新增独有便笺和导航 |
| 冲突界面 | Edge 预览显示 8 条，包含“两侧都改了”和“仅一边改了”；各条保留方式及展开内容控件存在 |
| Computer Use 核验 | 实际原生 Edge 窗口中读取并查看预览；原生点击因不可用几何信息/检测到窗口输入未确认成功，不能记作人工应用 |
| 应用与一致性 | 测试脚本点击实际“应用合并”，再双向同步；两端完整快照摘要一致 |
| 内容保留 | 3 条便笺、4 条导航；双方独有内容全部存在；共同便笺同时保留 Chrome 标题与 Edge 正文，两条共享导航的独立修改都保留 |
| 搜索引擎 | Chrome 界面选择 Google，完整刷新后仍为 Google |
| 测试清理 | 本次成功运行的两个临时浏览器配置、进程和测试构建副本已清理；加密远端合成数据保留 |

脱敏回执：[real-r2-browser.json](../../output/playwright/covelet/record-merge-browser-acceptance/real-r2-browser.json)。截图：[Edge 合并预览](../../output/playwright/covelet/record-merge-browser-acceptance/edge-real-r2-merge-preview.png)、[Edge 应用后](../../output/playwright/covelet/record-merge-browser-acceptance/edge-real-r2-merged.png)、[Chrome 最终状态](../../output/playwright/covelet/record-merge-browser-acceptance/chrome-real-r2-final.png)、[Edge 最终状态](../../output/playwright/covelet/record-merge-browser-acceptance/edge-real-r2-final.png)。

本轮浏览器实际运行覆盖同一记录不同字段合并与独有内容保留，没有在浏览器内完成同字段二选一、删除/修改、标签改名、文件夹移动、撤销、两侧语言及两侧引擎不同偏好的全部人工组合。这些情况的单元/本机集成/独立 R2 适配器覆盖范围见前述各节；不把它们升级为本轮浏览器人工验证通过。

## 可复现的完整人工补测步骤

下面保留完整人工补测清单，未执行步骤不算已通过。

1. 使用上面构建产物，在 Chrome 与 Edge 中分别新建隔离配置，以开发者模式加载 `app/dist/extension`。记录各浏览器版本、加载的扩展版本及实际运行时间；不要使用日常配置中的私人内容。
2. 两侧连接同一专用 R2 存储桶及一个新的独立测试前缀，例如 `covelet-record-merge-manual/<本次唯一标识>`。只授予实际服务地址的访问权限；两侧使用同一同步密码，访问凭据各自在本机填写。不要在截图或文档中暴露凭据。
3. 在 Chrome 建立共同基线：至少两条便笺、若干导航、两个文件夹及一个子导航、一个标签。先同步 Chrome，再同步 Edge，核对基线 ID 和内容一致。关闭两侧自动同步后断开网络，保留这份共同基线。
4. 离线分别修改同一条便笺正文，内容明确区分 Chrome 与 Edge，制造同字段冲突；另选第二条共同便笺，让 Chrome 改标题、Edge 改正文，以检查不同字段组合。两侧分别新增独有便笺和导航，各自写下新记录 ID。
5. 对同批导航做交叉修改：一侧改名称、另一侧改网址；让一侧移动文件夹或子导航，另一侧重命名相关文件夹；一侧按标签 ID 改名，另一侧修改关联内容。可另建一条专用记录，测试一侧删除、另一侧修改。每个预期保留记录及移动后的父级都记录在验收清单中。
6. 恢复网络，先同步一侧，再同步另一侧，打开“预览合并”。逐条确认“两侧都改了 / 仅一边改了 / 一边删了”，展开查看双方内容；独有新增应默认保留，删除/修改应默认保留修改。逐条选择同字段冲突需要的本机、云端或合并结果，再一次“应用合并”。
7. 应用后完成普通同步，再在另一浏览器同步，最后回到首个浏览器再次同步。比较两侧记录 ID、正文、网址、标签 ID/名称、父文件夹及位置；逐项检查双方独有 ID 全部存在。重复同步应不再出现旧冲突，也不应新增重复记录。保存脱敏结果及实际截图。
8. 对一次新的专用冲突重复合并，在继续编辑前点击“撤销上次合并”，检查本机恢复前副本与同步结果。另测试合并后新编辑或远端继续变化时，旧撤销应明确拒绝覆盖新数据。
9. 在 Chrome 与 Edge 分别更换搜索框引擎，刷新、关闭再打开新标签页，检查选择仍保留；确认两侧可以保持各自选择。给两侧设置不同语言，完成同步后确认语言未互相覆盖。
10. 记录每一步的实际结果、失败信息及任何未验证项。只有实际完成本清单后，才可将完整人工补测标记通过；前一节的实际界面联调结果不能冒充全部人工组合。

## 保留的临时产物

另保留初次浏览器启动诊断产生、进程已经关闭的 `output/playwright/covelet/record-merge-browser-acceptance/raw-record-merge-profile-edge-IDIXGk`。自动审批拒绝了经过绝对路径边界、符号链接与占用检查的 PowerShell 删除，返回「blocked by policy」；未换用其他删除方式。成功的最终 Chrome / Edge 验证轮次已在 `finally` 清理其配置、进程和测试复制品。

早期原生 Chrome 加载探测产生的 `output/playwright/covelet/record-merge-chrome-profile` 已关闭，但清理此目录的两次 PowerShell 操作被自动审批拒绝，工具仅返回 `blocked by policy`，没有提供更具体原因。此目录暂留，不影响后续成功运行所用配置的清理；没有绕过拒绝改用其他方式删除。

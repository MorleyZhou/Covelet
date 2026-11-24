# Chrome / Edge 记录合并与真实 R2 验证

日期：2026-11-24。当前 0.6.0 代码，实际安装的 Chrome 157.0.8103.79、Edge 158.0.4370.33。结果：通过。

## 验证方式与边界

使用有窗口的两款原生浏览器、彼此隔离的临时配置、真实加密 IndexedDB，以及本机配置文件中指定的真实 Cloudflare R2。通过浏览器原生 CDP 驱动实际界面，没有导入或使用 Playwright。

本轮是自动化 UI 验证，不应记作人工完整手动验收。Agent 曾在原生 Edge 窗口观察到实际八行合并预览；没有确认原生手动点击应用，最终由自动化点击实际「应用合并」按钮。

为稳定创建共同记录，测试复制当前 `app/dist/extension`，在复制品中附加一个从当前源代码编译的测试桥，调用现有 `saveNote`、`loadState`、`saveState` 和加密存储 API。复制品仅额外预授予真实 R2 的精确 origin，以避开浏览器原生权限弹窗；生产 manifest、权限与 `app/dist/extension` 未改动。连接配置、测试连接、保存并同步、立即同步、合并预览和应用，均通过生产界面的真实控件执行。此轮不验收原生权限弹窗。

真实 R2 连接与写入只使用独立随机测试子目录和随机同步密码。凭据从被 Git 忽略的本地配置读取，不写入日志或本报告。云上保留该目录的加密合成测试对象。成功轮次的临时浏览器配置、进程和测试复制品均已清理，未触碰日常浏览器配置。初次启动诊断遗留的已关闭 Edge 临时目录 `output/playwright/covelet/record-merge-browser-acceptance/raw-record-merge-profile-edge-IDIXGk` 仍保留：自动审批拒绝了经路径检查后的 PowerShell 删除，返回「blocked by policy」，没有换用其他删除方式。

## 执行步骤与结果

1. 通过两款浏览器当前提供的 `Extensions.loadUnpacked` 加载扩展，检查运行时 manifest 为 Covelet 0.6.0，新标签页正常显示。Chrome 与 Edge 均通过。
2. 在 Chrome 通过测试桥创建一条共同便笺、两条共同导航。通过实际同步设置界面连接真实 R2；Edge 配置同一随机子目录与密码，拉取共同数据，两侧再次同步建立共同基线。
3. 暂停自动同步，在 Chrome 修改共同便笺标题、导航 A 名称，新增独有便笺和导航；在 Edge 修改同一便笺正文、同批导航中的 B 名称，另增独有便笺和导航。所有修改通过当前领域 API 和原子加密存储边界提交。
4. Chrome 点击「立即同步」，Edge 随后同步并显示冲突。点击「预览合并」显示八行，包括共同便笺的「两侧都改了」、两侧独有内容与独立导航修改的「仅一边改了」，以及只读导航 snapshots 集合选择。没有新增旧历史恢复入口。
5. 保存合并预览截图并保留最多 60 秒的原生窗口检查时间。随后自动化点击实际「应用合并」，再次双向同步。
6. 读取两侧当前加密快照并比较完整摘要：完全一致。两侧均保留三条便笺、四条导航；共同便笺同时含 Chrome 修改的标题与 Edge 修改的正文；导航 A、B 分别保留两侧改名；两侧独有便笺与导航全部存在。
7. 在 Chrome 实际搜索引擎菜单选择 Google，完整刷新页面，再检查当前引擎：仍为 Google。通过。

## 证据与复现

- 自动化脚本：`app/scripts/verify-record-merge-browser-r2.mjs`。
- 原生浏览器加载工具：`app/scripts/verify-record-merge-browsers.mjs`。
- 脱敏收据：`output/playwright/covelet/record-merge-browser-acceptance/real-r2-browser.json`，`result: passed`。
- 预览截图：`edge-real-r2-merge-preview.png`；应用后：`edge-real-r2-merged.png`；最终两侧：`chrome-real-r2-final.png`、`edge-real-r2-final.png`，均位于同一证据目录。
- 在 `app/` 运行 `node scripts/verify-record-merge-browser-r2.mjs`。设置 `COVELET_QA_HOLD_PREVIEW=1` 可在预览保留最多 60 秒供观察。须先构建当前 unpacked 扩展，并在本地被忽略的 `output/playwright/covelet/live-config.local.json` 填好有效 R2 测试配置；不要把凭据复制到报告。

用户后续明确将真实服务验收从 WebDAV 改为 R2，本轮按最新要求执行；不宣称做过 WebDAV 真实服务验证。删除/修改、同字段竞争、撤销、超限等边界由独立单元与协议测试覆盖，此浏览器轮次未重复验证全部边界，也不等于完整人工验收。

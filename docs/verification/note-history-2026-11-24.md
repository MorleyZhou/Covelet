# 第三项：单篇便笺历史验证

2026-11-24，在第二项提交 ccd345f 之后单独实现。采用完整正文/富文本快照，最多 20 版、单版 768 KiB、单篇 4 MiB、全部 16 MiB；仅清理旧历史。设计见 [note-history.md](../note-history.md)。

## 工程检查

- `npm test`：1051/1051 通过，0 失败、取消、跳过；[日志](../../output/playwright/note-history-npm-test.log)。
- `npm run build:unpacked`：通过；[日志](../../output/playwright/note-history-build.log)。
- `npm run check:extension`：通过；[日志](../../output/playwright/note-history-extension-check.log)。
- 核心/便笺相关 58 项通过：完整快照、计数/字节限制、保护恢复前当前版、无操作/固定状态不制造历史、元数据组合、存储失败原子性、便笺/历史/隐私 CAS、永久删除清理。
- 历史同步新增 4 项通过：双端独有版本并集、逐版本选择不丢其他版本、相同不可变 ID 不同正文拒绝、本机修订重置不改变历史版本时钟与源修订。
- UI 11 项通过：只读对比/恢复、过期修订、未保存草稿、异步结果与隐藏/锁定/切换、通知更新及卸载，文本不作为 HTML/图片/链接渲染。
- 恢复与存储相关 69 项通过：完整备份 v2 JSON/加密往返，旧 0.6.0 v1 读取升级，追加模式不附加被跳过同 ID 的外来历史，恢复前保存当前版本，成对提交、失败及回滚 CAS。

## 实际 Chrome 界面与重启：通过

2026-11-24 17:44:50–17:44:55（Asia/Shanghai），Chrome 157.0.8103.79，扩展 0.6.0。原生 CDP 自动操作，无 Playwright；运行当前 unpacked 独立副本，仅加合成数据准备与核验桥接，没有扩大 host 权限。它是实际产品界面联调，不冒充完整人工录入验收。

1. 使用当前领域保存 API 建立完整 Folio 便笺 A→B→C。
2. 点击实际编辑器“历史”，选择 A；只读界面并排展示历史 A 和当前 C。
3. 点击实际“恢复此版本”：当前正文和完整 Folio 文档为 A，主编辑器随之刷新；恢复前的 C 成为可查看历史，共保留 3 条。
4. 再打开历史查看 C 与当前 A；预览产生 0 次外部请求，没有 HTML、图片、脚本或链接节点。
5. 完全关闭 Chrome，使用同一隔离配置重启；当前 A、历史 C 和历史预览仍可用。

回执：[browser.json](../../output/playwright/covelet/note-history/browser.json)。脚本：[verify-note-history-browser.mjs](../../app/scripts/verify-note-history-browser.mjs)。安全截图位于同一证据目录，实际 1280×900 对比界面已检查。测试浏览器、配置与构建副本清理完成。

## 新版自动备份回归：通过

使用最终构建再次运行实际 Chrome 的生产 Worker 自动备份。独立密码解密后的每份文件都是完整备份 v2，包含真正的隐藏便笺历史；四次运行仅保留三份。停止旧 Worker 并关闭全部 Covelet 页面后，真实闹钟唤醒新 Worker 写入第五份，仍保留三份且不再选择目录。

证据：[scheduled-backup/receipt.json](../../output/playwright/covelet/scheduled-backup/receipt.json)。该回归仍使用真实 OPFS 目录，外部系统目录授权不在本次自动化证明范围。

版本号保持 0.6.0，不发布、不提交商店；本次按要求完成独立代码提交，未推送远端。

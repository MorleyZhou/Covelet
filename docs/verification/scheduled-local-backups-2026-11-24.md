# 第二项：定时本机加密备份验证

2026-11-24；在第一项提交 c0e983c 后独立实现，本提交不含便笺历史。用户明确选择默认包含隐藏内容，只生成加密 `.covelet`。

## 工程检查

- `npm test`：1018/1018 通过，0 失败、取消、跳过；[日志](../../output/playwright/scheduled-backup-npm-test.log)。
- `npm run build:unpacked`：通过；[日志](../../output/playwright/scheduled-backup-build.log)。
- `npm run check:extension`：通过；[日志](../../output/playwright/scheduled-backup-extension-check.log)。
- 调度测试覆盖四次以上写入仅保留最近三份、独立密码解密、权限/写入/配额/回读/删除/状态保存失败、用户修改文件保护、时钟回拨、重启日志恢复和关闭时清除句柄/密钥。加密测试另用独立 Node PBKDF2/AES 实现读取生成文件。
- 后台测试覆盖 Worker 启动/浏览器启动/安装恢复闹钟、只接受本扩展消息、不接受密码/密钥/句柄参数，以及失败状态广播。

## 实际 Chrome + Service Worker：通过

Chrome 157.0.8103.79、扩展 0.6.0，使用实际加密、本机 IndexedDB、目录句柄和生产 Worker。原生 CDP 自动操作，无 Playwright。测试副本仅增加数据准备/核验桥接，并把选择器返回值替换为**真实 OPFS 目录句柄**；不是操作系统外部目录的人工选择器验收。

1. 实际设置界面选择每日备份，输入独立备份密码并确认。目录选择仅一次；密码不保存，保存的 key 是原生不可导出加密 CryptoKey。
2. 通过实际后台运行请求完成四次完整备份。目录与文件账本中最终均为三份 `.covelet`，没有明文 JSON/ZIP。
3. 用独立密码逐份解密：隐藏便笺、隐藏标记及导航存在；访问凭据和隐藏密码验证记录不在文件里。每份 IV 不同，密码盐属于本次密钥配置，格式仍为可移植 v1。
4. 终止旧 Worker，安排真实到期闹钟，并关闭全部 Covelet 页面。新生产 Worker 在没有 Covelet 页面的情况下完成一份新备份，轮换后仍为三份。
5. 重新打开设置，原生目录句柄与密钥仍有效，不再次调用选择器；状态为 saved、lastError 为 null。

脚本：[verify-scheduled-backup-browser.mjs](../../app/scripts/verify-scheduled-backup-browser.mjs)。[脱敏回执](../../output/playwright/covelet/scheduled-backup/receipt.json)。截图与回执保留，测试浏览器配置、进程和构建副本已清理。

## 仍需人工核验的平台边界

本轮文件写入位置是原生 OPFS，未宣称验证系统文件夹选择和外部目录的持久权限。用户实际选择系统目录时，是否能跨浏览器重启保留写入授权取决于浏览器版本及用户授权；权限失效时设置会明确要求重新选择，不会在 Worker 中发起授权弹窗。浏览器关闭/系统休眠期间不保证执行，恢复运行后补做一次到期任务。

设计与容量、密钥保存、轮换事务和失败策略见 [scheduled-local-backups.md](../scheduled-local-backups.md)。普通手动 JSON/ZIP 导出仍未加密且有明确提示。

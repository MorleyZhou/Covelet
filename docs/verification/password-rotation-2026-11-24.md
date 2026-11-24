# 第一项：同步密码轮换验证

2026-11-24，基于 main 准备基线 e0b026e，版本保持 0.6.0。本次仅实现同步密码轮换，尚未实现定时备份或便笺历史。

设计见 [sync-password-rotation.md](../sync-password-rotation.md)。云端当前权威版本和本机同步凭据采用新密码；业务 IndexedDB 的设备密钥不更换。旧云端归档、已下载文件和 Git 历史不能追溯撤销，界面和设计已说明。

## 工程检查

- `npm test`：980/980 通过，0 失败、取消、跳过；[日志](../../output/playwright/password-rotation-npm-test.log)。
- `npm run build:unpacked`：通过；[日志](../../output/playwright/password-rotation-build.log)。
- `npm run check:extension`：通过；[日志](../../output/playwright/password-rotation-extension-check.log)。
- 轮换故障测试 22 项：错误密码、当前和历史损坏零发布、未同步/冲突拒绝、候选回读失败、上传中本机/云端变化、中断日志恢复、并发轮换失败方重新绑定、连续换密、原子收尾失败、缓存清理失败、真实界面的完整凭据形状。
- 原子存储测试确认设备密钥和业务数据保持；新日志与归档设备键不进入同步。

## 真实 Chrome + R2 界面联调：通过

运行于 2026-11-24 17:13:42–17:15:12（Asia/Shanghai），Chrome 157.0.8103.79，扩展 0.6.0。通过原生 CDP 驱动真实产品界面，无 Playwright。测试使用 unpacked 的独立副本、精确 R2 origin 授权以及合成数据准备/快照核对桥接代码；不冒充未插桩的完整人工验收。

1. 在隔离配置内准备一篇便笺和一条导航，以实际设置连接独立 R2 测试前缀并完成同步。
2. 打开实际“修改同步密码”，填写当前密码、新密码、确认密码，执行“更新同步密码”。云端重加密并完成切换后，界面为锁定状态。
3. 使用旧密码：拒绝解锁。检查本机封套，旧密码不能打开，新密码可以打开；无待完成轮换日志。
4. 显式输入新密码解锁，普通同步成功；便笺、导航和完整快照保持一致。
5. 完全关闭 Chrome，保留本次隔离配置后重启。会话仍锁定；再次使用新密码解锁、普通同步，内容仍一致。

回执：[browser-r2.json](../../output/playwright/covelet/password-rotation/browser-r2.json)。脚本：[verify-password-rotation-browser.mjs](../../app/scripts/verify-password-rotation-browser.mjs)。仅保留脱敏回执和安全截图，测试配置/构建副本均已清理；远端加密合成数据保留。

实机测试曾发现界面会话包含其他服务空字段，导致换密后封套能解密但内容校验失败；现已在封装前按当前服务过滤凭据，并加入完整表单形状的回归测试。最终上述真实服务结果均为修复后通过。

## 未验证边界

真实服务本轮为 R2；WebDAV/GitHub/GitLab/OSS 的新控制路径由传输协议测试覆盖，不记作真实服务实测。归档历史不会因改密而远程擦除。第一项提交后再开始第二项，提交及后续结果以 Git 记录为准。

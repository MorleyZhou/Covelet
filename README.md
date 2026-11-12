# Covelet

Covelet 是无需账号的新标签页扩展，提供网站导航、文件夹、搜索、外观与布局，以及便笺、稍后读和 GitHub 贡献组件。首页显示时间和日期，可在极简模式中隐藏。支持八种界面语言，没有广告、遥测或 Covelet 数据服务器。

当前源码版本为 **0.5.1**，修复自备存储同步的冲突处理，本轮未发布或提审。支持链接备注与标签、动态清单、链接列表与重复审阅、稍后读再看及批量处理、网页选文便笺、Markdown 交换、导航回收站、搜索引擎关键词和密码加密完整备份。商店版本以各商店页面为准。 [0.5.1 修复说明](docs/releases/0.5.1.md) · [0.5.0 更新](docs/releases/0.5.0.md) · [发布状态](docs/store/发布状态.md)

新安装时可添加常用网站、导入书签或从空白开始。旧时钟组件已退役，仍可读取旧备份。

数据以本机加密 IndexedDB 为主副本，浏览器原生同步已停用。用户可选择默认关闭的自备存储同步，直接连接自己配置的服务。设备密钥、隐藏密码和访问凭据不随同步传播。访问凭据加密保存在本机。普通 JSON/ZIP 导出文件未加密；完整备份也可用独立密码导出为 `.covelet` 加密文件，密码丢失无法恢复。[隐私说明](docs/隐私说明.md) · [自备存储同步](docs/自定义存储同步.md)

同步以 **WebDAV** 为推荐渠道，提供独立连接测试和整组二选一的冲突处理。后续真云验收按维护者要求仅使用 GitHub。其他渠道的历史结果见[收口记录](docs/verification/0.3-closeout.md)。

在「扩展 → 自备存储同步」选择渠道、填写并测试连接、设置同步密码。失败时可转为仅本机使用。仅保存配置不会验证连接或启动同步。「设置 → 关于 → 隐私自查」展示当前权限与用途、已知联网场景及数据位置。扩展不保存网络请求历史。

在 `app/` 中运行 `npm ci`、`npm test`、`npm run build:unpacked`、`npm run check:extension`。加载目录为 `app/dist/extension/`。`npm run test:e2e` 验证真实扩展页面，运行前执行 `npx playwright install chromium`。[浏览器测试说明](app/tests/playwright/README.md)。构建与测试结果不表示已通过商店审核。

[0.2.2 发布检查](docs/releases/0.2.2.md) · [0.2.2 书签 HTML 导入说明](docs/bookmark-html-import-0.2.2.md)

支持及隐私联系：support@morley.work。

本项目采用 MIT 许可，详见仓库根目录 LICENSE。

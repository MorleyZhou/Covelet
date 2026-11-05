# Covelet

Covelet 是无需账号的新标签页扩展，提供网站导航、文件夹、搜索、外观与布局，以及便笺、稍后读和 GitHub 贡献组件。首页显示时间和日期，可在极简模式中隐藏。支持八种界面语言，没有广告、遥测或 Covelet 数据服务器。

当前源码与包版本为 **0.3.0**。发行包及发布结果以 [v0.3.0](https://github.com/MorleyZhou/Covelet/releases/tag/v0.3.0) 和 [GitHub Actions](https://github.com/MorleyZhou/Covelet/actions/workflows/release-stores.yml) 为准。本轮未提交商店，也未重新核实商店线上版本。扩展 ID：`clkholbmabommppnlpcnhdgmibibblgb`。[0.3.0 发布说明](docs/releases/0.3.0.md) · [发布状态](docs/store/发布状态.md) · [0.3.0 使用说明](docs/0.3使用说明.md)

新安装从空桌面开始。旧时钟组件已退役，原有配置和数据保留，仍可读取旧备份。

数据以本机加密 IndexedDB 为主副本，浏览器原生同步已停用。用户可选择默认关闭的自备存储同步（Beta），直接连接自己配置的服务；设备密钥、隐藏密码和会话凭据不随同步传播。JSON/ZIP 导出文件不等于加密备份，应妥善保管。[隐私说明](docs/隐私说明.md) · [自备存储同步（Beta）](docs/自定义存储同步.md)

同步以 **WebDAV** 为推荐入口，提供独立连接测试和整组二选一的冲突处理。OSS 保留独立 **Beta** 标识。后续真云验收按维护者要求仅使用 GitHub；其他渠道的历史结果与当前边界见[收口记录](docs/verification/0.3-closeout.md)。

设置引导位于「设置 → 数据 → 自备存储同步（Beta）」（原扩展入口仍可用）：选择渠道 → 填写最少连接字段并测试 → 设置同步密码并首次同步。失败可转为仅本机使用；仅保存配置不会验证连接或启动同步。「设置 → 隐私自查」展示当前权限与用途、已知联网场景及数据位置；没有近 7 天请求日志，页面不虚构次数，也不添加分析服务。

在 `app/` 中运行 `npm ci`、`npm test`、`npm run build:unpacked`、`npm run check:extension`。加载目录为 `app/dist/extension/`。`npm run test:e2e` 验证真实扩展页面，运行前执行 `npx playwright install chromium`。[浏览器测试说明](app/tests/playwright/README.md)。构建与测试结果不表示已通过商店审核。

[0.2.2 发布检查](docs/releases/0.2.2.md) · [书签 HTML 导入说明](docs/bookmark-html-import-0.2.2.md)

支持及隐私联系：support@morley.work。

本项目采用 MIT 许可，详见仓库根目录 LICENSE。

# Covelet

Covelet 是无需账号的新标签页扩展，提供网站导航、文件夹、搜索、外观与布局，以及便笺、稍后读和 GitHub 贡献组件。首页显示时间和日期，可在极简模式中隐藏。支持八种界面语言，没有广告、遥测或 Covelet 数据服务器。

当前源码版本为 **0.7.0**，新增记录级同步合并、同步密码更换、定时本机加密备份、便笺历史、本地阅读器与 RSS 收件箱、浏览器命令面板及本机会话，并提供独立的 Firefox 开发预览包。商店审核和上线版本以实际回执为准。[0.7.0 更新](docs/releases/0.7.0.md) · [发布验收](docs/releases/0.7.0-local-qa.md) · [发布状态](docs/store/发布状态.md)

新安装时可添加常用网站、导入书签或从空白开始。旧时钟组件已退役，仍可读取旧备份。

数据以本机加密 IndexedDB 为主副本，浏览器原生同步已停用。用户可选择默认关闭的自备存储同步，直接连接自己配置的服务。设备密钥、隐藏密码和访问凭据不随同步传播。访问凭据加密保存在本机。普通 JSON/ZIP 导出文件未加密；完整备份也可用独立密码导出为 `.covelet` 加密文件，密码丢失无法恢复。[隐私说明](docs/隐私说明.md) · [自备存储同步](docs/自定义存储同步.md)

自备存储同步提供独立连接测试和按记录预览、选择及合并冲突，可撤销上次合并。本轮真实服务验收使用 **R2**，WebDAV 真实服务复验按维护者要求暂缓。各渠道的适用条件与限制见[自备存储同步](docs/自定义存储同步.md)。

在「扩展 → 自备存储同步」选择渠道、填写并测试连接、设置同步密码。失败时可转为仅本机使用。仅保存配置不会验证连接或启动同步。「设置 → 关于 → 隐私自查」展示当前权限与用途、已知联网场景及数据位置。扩展不保存网络请求历史。

在 `app/` 中运行 `npm ci`、`npm test`、`npm run build:unpacked`、`npm run check:extension`。加载目录为 `app/dist/extension/`。`npm run test:e2e` 验证真实扩展页面，运行前执行 `npx playwright install chromium`。[浏览器测试说明](app/tests/playwright/README.md)。构建与测试结果不表示已通过商店审核。

Firefox 使用 `npm run build:firefox` 和 `npm run check:firefox`，输出 `app/dist/extension-firefox/` 与独立 ZIP；最低 Firefox 140。当前包未签名，可在开发调试中临时加载，不是已上架的 AMO 安装包。阅读正文、高亮、RSS 和浏览器会话仅存此设备，不参与云同步或现有完整备份；会话恢复每批需确认，最多打开 10 个后台标签。

[0.2.2 发布检查](docs/releases/0.2.2.md) · [0.2.2 书签 HTML 导入说明](docs/bookmark-html-import-0.2.2.md)

支持及隐私联系：support@morley.work。

本项目采用 MIT 许可，详见仓库根目录 LICENSE。

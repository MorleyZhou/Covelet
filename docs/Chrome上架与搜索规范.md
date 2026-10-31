# Chrome 提交与搜索 · 0.2.1 A+

Chrome 线上为 0.2.0，ID `clkholbmabommppnlpcnhdgmibibblgb`；0.2.1 尚未提交。本轮只准备代码、候选包与 PR，不更新托管政策、不操作商店、不合并。

默认搜索通过 chrome.search.query 使用浏览器已有提供者，不更改其设置。用户临时选择其他引擎时才使用对应配置。搜索查询由所选服务接收，Covelet 无遥测或数据服务器。

A+ 移除标签快照与浏览器阅读清单导入，不保留对应权限或界面。仅可选 notifications；storage/search/favicon/activeTab/scripting/alarms、固定 Bing 主机和按需逐来源 HTTP(S) 授权保留。工具栏使用 activeTab 查询被调用当前页并以包内脚本读取元数据，不遍历其他标签。浏览器原生同步停用，可选自选存储加密同步默认关闭。

提交前须核对生产 ZIP、权限用途、隐私政策、支持邮箱 support@morley.work、真实截图与权利，并单独进行 Chrome 实装和真实服务验收。Edge 只提供可选材料草稿，不提交 Partner Center。[候选材料](store/商店提交材料.md)

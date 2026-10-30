import { tr } from '../i18n/index.js';

// Reviewed, packaged modules only. These identifiers are also storage identities.
const definitions = [
  ['tasks', 'productivity', '待办清单', '我的一天、清单、重复任务与提醒。', 'CheckSquare', '任务 To Do todo habit calendar'],
  ['snippets', 'development', '文本小抄', '收藏代码、常用语和带变量的文本模板。', 'CodeBlock', '片段 模板 提示词 snippet prompt'],
  ['online-tools', 'development', '在线工具', 'JSON、文本对比、正则、编码与格式转换。', 'Toolbox', 'diff regex JSON YAML UUID hash Base64'],
  ['images', 'creative', '图片工具', '批量处理图片、提取配色与检查对比度。', 'Image', '压缩 裁剪 水印 转换 palette'],
  ['pdf', 'creative', 'PDF 工具', '合并、提取、排序、旋转和图片转 PDF。', 'FilePdf', 'PDF 页面 合并 拆分'],
  ['subscriptions', 'productivity', '订阅中心', '订阅 RSS、项目发布与网页变化。', 'Rss', 'RSS Atom GitHub release feed'],
  ['ai-chat', 'productivity', 'AI 聊天', '连接自己的模型，保存会话与资料问答。', 'ChatCircle', 'AI Ollama LM Studio chat 本地模型'],
  ['language', 'learning', '语言学习', '单词卡片、语境练习、听写与学习进度。', 'Translate', '单词 词库 语言 vocabulary language'],
  ['stocks', 'finance', '股市', '管理自选列表，查看行情与走势。', 'ChartLine', '股票 指数 ETF stock market'],
  ['currency', 'finance', '汇率计算', '多币种换算、常用货币与离线参考汇率。', 'CurrencyDollar', '汇率 外汇 货币 exchange currency'],
  ['ledger', 'finance', '个人账本', '记录收支、预算和周期账单。', 'Wallet', '账单 预算 账户 budget money'],
  ['canvas', 'creative', '思维画板', '用节点、连线和画板整理想法。', 'Graph', '思维导图 流程图 whiteboard mindmap'],
  ['media', 'creative', '音视频工具', '剪辑声音、调整音量与导出媒体片段。', 'MusicNotes', '音频 视频 裁剪 audio video'],
  ['travel', 'life', '行程规划', '整理每日安排、交通住宿和预订资料。', 'Airplane', '旅行 地点 行程 trip travel'],
  ['orders', 'life', '订单与物品', '管理订单、收据、退换和保修期限。', 'Package', '订单 包裹 保修 物品 package receipt'],
  ['sports', 'life', '赛事中心', '关注球队、赛程、比分和排名。', 'Basketball', '体育 赛事 球队 比分 sports'],
  ['meals', 'life', '饮食计划', '安排食谱、每周菜单和食材购物清单。', 'ForkKnife', '食谱 食材 菜单 recipe meal'],
];
export const APP_DEFINITIONS = Object.freeze(definitions.map(([id, category, name, description, icon, keywords]) => Object.freeze({
  id, category, icon, title: name, text: description, type: 'widget', app: true,
  get name() { return tr(name); }, get description() { return tr(description); }, keywords: Object.freeze(keywords.split(' ')),
})));
export const APP_IDS = Object.freeze(APP_DEFINITIONS.map((app) => app.id));
export const isAppId = (id) => APP_IDS.includes(id);
export const appDefinition = (id) => APP_DEFINITIONS.find((app) => app.id === id);

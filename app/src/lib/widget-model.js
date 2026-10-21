import { tr, getLocale } from "../i18n/index.js";
import { normalizeTimeZone } from './time-zones.js';
export const GITHUB_WIDGET_ID = 'github-contributions';
export const CLOCK_WIDGET_ID = 'clock';
export const NOTES_WIDGET_ID = 'notes';
export const READING_WIDGET_ID = 'read-later';
export const WIDGET_NAMES = Object.freeze({ get clock() { return tr("时钟"); }, get 'github-contributions'() { return tr("GitHub 贡献"); }, get notes() { return tr("便笺"); }, get 'read-later'() { return tr("稍后读"); } });
export const WIDGET_SIZE_OPTIONS = Object.freeze([
  Object.freeze({ value: 'mini', get label() { return tr("迷你 · 1×1"); } }),
  Object.freeze({ value: 'small', get label() { return tr("小 · 2×2"); } }),
  Object.freeze({ value: 'medium', get label() { return tr("中 · 2×4"); } }),
  Object.freeze({ value: 'large', get label() { return tr("大 · 4×4"); } }),
]);
// Read compatibility for existing local/native/cloud/backup records only.
// The current widget has no range control; geometry chooses visible weeks.
export const CONTRIBUTION_RANGES = Object.freeze([
  { value: 'week', get label() { return tr("近一周"); } }, { value: 'month', get label() { return tr("近一月"); } },
  { value: 'half-year', get label() { return tr("近半年"); } }, { value: 'year', get label() { return tr("近一年"); } },
]);

export function normalizeGitHubUsername(input) {
  if (typeof input !== 'string') throw new Error(tr("请填写 GitHub 用户名。"));
  const username = input.trim().replace(/^@/, '');
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(username) || username.includes('--')) {
    throw new Error(tr("GitHub 用户名须为 1 至 39 位字母、数字或连字符。"));
  }
  return username.toLowerCase();
}

export function validateWidgetConfig(extensionId, input) {
  if (extensionId === CLOCK_WIDGET_ID) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => !['size', 'style', 'zones', 'timeZone'].includes(key))
      || !WIDGET_SIZE_OPTIONS.some(({ value }) => value === input.size) || !['analog', 'digital'].includes(input.style)) throw Error(tr("时钟配置无效。"));
    const config = { size: input.size, style: input.style };
    if (input.zones !== undefined) {
      if (!Array.isArray(input.zones) || input.zones.length < 1 || input.zones.length > 8) throw Error(tr("请选择 1 至 8 个世界时钟。"));
      config.zones = [...new Set(input.zones.map(normalizeTimeZone))];
    }
    if (input.timeZone !== undefined) config.timeZone = input.timeZone === 'local' ? 'local' : normalizeTimeZone(input.timeZone);
    return config;
  }
  if ([NOTES_WIDGET_ID, READING_WIDGET_ID].includes(extensionId)) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => key !== 'size')
      || !WIDGET_SIZE_OPTIONS.some(({ value }) => value === input.size)) throw Error(tr("组件配置无效。"));
    return { size: input.size };
  }
  if (extensionId !== GITHUB_WIDGET_ID) throw new Error(tr("不支持此组件。"));
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !['username', 'size', 'range'].includes(key))) throw new Error(tr("组件配置无效。"));
  if (!WIDGET_SIZE_OPTIONS.some(({ value }) => value === input.size)) throw new Error(tr("组件尺寸无效。"));
  if (input.range !== undefined && !CONTRIBUTION_RANGES.some((range) => range.value === input.range)) throw Error(tr("贡献时间范围无效。"));
  return { username: normalizeGitHubUsername(input.username), size: input.size, ...(input.range !== undefined ? { range: input.range } : {}) };
}

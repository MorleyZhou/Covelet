import { isAppMessage, tr } from '../i18n/index.js';

const localMessages = {
  LOCAL_DATA_UNAVAILABLE: () => tr("无法打开本机数据，请重新打开 Covelet 后再试。"),
  LOCAL_DATA_BLOCKED: () => tr("请关闭其他 Covelet 页面后重试，原数据已保留。"),
  LOCAL_DATA_KEY_MISSING: () => tr("无法打开加密数据，原数据已保留。"),
  LOCAL_DATA_KEY_INVALID: () => tr("无法打开加密数据，原数据已保留。"),
  LOCAL_DATA_DECRYPT_FAILED: () => tr("无法读取加密数据，原数据已保留。"),
  LOCAL_DATA_WRITE_FAILED: () => tr("数据未能保存，请重试。"),
  LOCAL_DATA_CLOSED: () => tr("本机数据连接已关闭，请重新打开 Covelet。"),
  LOCAL_DATA_INVALID: () => tr("本机数据格式不受支持或超出容量限制。"),
  LOCAL_DATA_MIGRATION_FAILED: () => tr("旧版数据未能转换，原数据已保留。"),
  LOCAL_DATA_MIGRATION_CONFLICT: () => tr("旧版数据存在不同副本，暂未转换。原数据已保留。"),
  LOCAL_DATA_PRIVACY_CONFLICT: () => tr("请先解锁本机隐藏内容，再采用删除版本。"),
  REVISION_CONFLICT: () => tr("数据已在其他页面更新，请重新打开后再试。"),
};

// Only application messages are presented verbatim. Native/storage errors may
// contain implementation details or data values; their codes select safe copy.
export function userErrorMessage(error, fallback = tr('操作失败，请重试。')) {
  const message = typeof error === 'string' ? error : error?.message;
  if (isAppMessage(message)) return tr(message);
  if (Object.hasOwn(localMessages, error?.code)) return localMessages[error.code]();
  if (error?.name === 'QuotaExceededError') return tr('浏览器存储空间不足，请释放空间后重试。');
  if (error?.name === 'SecurityError' || error?.name === 'NotAllowedError') return tr('浏览器不允许访问本机数据，请检查浏览器的存储设置。');
  return fallback;
}

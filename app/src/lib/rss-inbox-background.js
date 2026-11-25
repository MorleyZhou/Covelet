import { tr } from '../i18n/index.js';
import { getExtensionApi } from './extension-api.js';
import { RSS_ALARM } from './rss-inbox.js';

export function startRssInboxBackground(controller, { extension = getExtensionApi(), ready = Promise.resolve(),
  reportError = (code) => console.error('Covelet RSS update failed', code) } = {}) {
  let stopped = false;
  const safeCode = (reason) => typeof reason?.code === 'string' && /^RSS_[A-Z_]{1,40}$/.test(reason.code) ? reason.code : 'RSS_NETWORK';
  const perform = async (operation, feedId) => {
    try {
      await ready; if (stopped) return { ok: false, error: { code: 'RSS_NETWORK', message: tr('订阅更新失败，请检查网络后重试。') } };
      const status = await controller[operation](feedId);
      return { ok: true, status };
    } catch (reason) {
      const code = safeCode(reason); try { reportError(code); } catch { /* Never print untrusted error text. */ }
      return { ok: false, error: { code, message: tr('订阅更新失败，请检查网络后重试。') } };
    }
  };
  const restore = () => perform('restoreSchedule');
  const onAlarm = (alarm) => { if (!stopped && alarm?.name === RSS_ALARM) return perform('refreshDue'); };
  const onMessage = (message, sender, respond) => {
    if (stopped || message?.type !== 'covelet:rss:refresh' || sender?.id !== extension.runtime.id
      || !sender.url?.startsWith(extension.runtime.getURL(''))) return undefined;
    if (Object.keys(message).some((key) => !['type', 'feedId'].includes(key)) || message.feedId !== undefined && (typeof message.feedId !== 'string' || message.feedId.length > 100)) {
      respond({ ok: false, error: { code: 'RSS_MISSING', message: tr('此订阅或条目已被移除。') } }); return false;
    }
    perform('refresh', message.feedId).then(respond); return true;
  };
  extension.alarms.onAlarm.addListener(onAlarm); extension.runtime.onMessage.addListener(onMessage);
  extension.runtime.onStartup.addListener(restore); extension.runtime.onInstalled.addListener(restore); restore();
  return () => {
    stopped = true; extension.alarms.onAlarm.removeListener(onAlarm); extension.runtime.onMessage.removeListener(onMessage);
    extension.runtime.onStartup.removeListener(restore); extension.runtime.onInstalled.removeListener(restore);
  };
}

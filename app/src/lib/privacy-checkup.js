import manifest from '../../extension.manifest.json' with { type: 'json' };
import { tr } from '../i18n/index.js';

// This is a permission snapshot, not a request monitor. Opening the checkup
// neither probes a host nor adds permissions or persistent browsing logs.
export async function readPrivacyPermissions(browser = globalThis.chrome) {
  const declared = browser?.runtime?.getManifest?.() || manifest;
  let granted = null;
  if (browser?.runtime?.id && browser.permissions?.getAll) {
    try {
      granted = await new Promise((resolve, reject) => {
        browser.permissions.getAll((value) => browser.runtime.lastError ? reject(new Error('permissions')) : resolve(value));
      });
    } catch { /* Show declarations with an explicit unknown grant state. */ }
  }
  const unique = (values = []) => [...new Set(values)].sort();
  return {
    grantsKnown: Boolean(granted),
    requiredPermissions: unique(declared.permissions),
    optionalPermissions: unique(declared.optional_permissions),
    grantedPermissions: unique(granted?.permissions),
    requiredOrigins: unique(declared.host_permissions),
    optionalOriginScope: unique(declared.optional_host_permissions),
    grantedOrigins: unique(granted?.origins),
  };
}

export function permissionPurpose(permission) {
  return {
    storage: tr('保存设置和临时连接信息。内容数据在本机加密保存。'),
    search: tr('按浏览器默认设置执行搜索，不更改默认搜索引擎。'),
    favicon: tr('添加或导入网站时，读取浏览器已有的网站图标。'),
    activeTab: tr('点击工具栏后，临时读取当前网页的网址、标题和图标地址。'),
    scripting: tr('点击工具栏后读取当前网页信息，帮助添加网站。'),
    alarms: tr('接续后台同步并清理旧版时钟提醒。'),
    notifications: tr('旧版时钟使用的通知权限，当前版本不再发送通知。'),
  }[permission] || tr('此权限由当前扩展声明；请在浏览器扩展详情中核对用途。');
}

export function permissionLabel(permission) {
  return {
    storage: tr('保存设置'),
    search: tr('浏览器搜索'),
    favicon: tr('网站图标'),
    activeTab: tr('当前网页'),
    scripting: tr('读取网页信息'),
    alarms: tr('后台任务'),
    notifications: tr('通知'),
  }[permission] || permission;
}

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
    storage: tr('迁移设备设置并保存会话状态；业务数据使用本机加密 IndexedDB，不启用浏览器原生同步。'),
    search: tr('按浏览器默认设置执行搜索，不更改默认搜索引擎。'),
    favicon: tr('显式添加或导入网站时读取浏览器已有图标。'),
    activeTab: tr('点击工具栏后临时读取当前页面的地址、标题和图标声明。'),
    scripting: tr('点击工具栏后运行随扩展打包的页面信息读取代码。'),
    alarms: tr('调度本机倒计时，送达时间受浏览器运行状态限制。'),
    notifications: tr('仅在你启用后显示倒计时完成通知。'),
  }[permission] || tr('此权限由当前扩展声明；请在浏览器扩展详情中核对用途。');
}

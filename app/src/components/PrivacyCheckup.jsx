import { useEffect, useState } from 'react';
import { tr } from '../i18n/index.js';
import { cloudOrigin } from '../lib/cloud-providers.js';
import { loadCloudSyncSettings, subscribeCloudSyncStatus } from '../lib/cloud-sync.js';
import { readPrivacyPermissions, permissionPurpose } from '../lib/privacy-checkup.js';
import './privacy-checkup.css';

export default function PrivacyCheckup({ demo = false }) {
  const [permissions, setPermissions] = useState(null), [connection, setConnection] = useState(null);
  useEffect(() => {
    let active = true, generation = 0;
    const refresh = async () => {
      const current = ++generation;
      const [permissions, sync] = await Promise.allSettled([readPrivacyPermissions(), demo ? Promise.resolve(null) : loadCloudSyncSettings()]);
      if (!active || current !== generation) return;
      if (permissions.status === 'fulfilled') setPermissions(permissions.value);
      if (sync.status === 'fulfilled') setConnection(sync.value);
    };
    refresh();
    const off = demo ? () => {} : subscribeCloudSyncStatus(status => {
      if (active) setConnection(current => current ? { ...current, unlocked: status.unlocked, autoSync: status.autoSync } : current);
    });
    const events = [globalThis.chrome?.permissions?.onAdded, globalThis.chrome?.permissions?.onRemoved];
    for (const event of events) event?.addListener(refresh);
    return () => { active = false; off(); for (const event of events) event?.removeListener(refresh); };
  }, [demo]);
  let endpoint = '';
  try { if (connection?.profile) endpoint = cloudOrigin(connection.profile); } catch { /* Never show an invalid or credential-bearing URL. */ }
  const permissionNames = permissions ? [...new Set([...permissions.requiredPermissions, ...permissions.optionalPermissions, ...permissions.grantedPermissions])] : [];
  const origins = permissions ? [...new Set([...permissions.requiredOrigins, ...permissions.grantedOrigins])] : [];
  const grantLabel = (granted) => !permissions.grantsKnown ? tr('授权状态未知') : granted ? tr('已授予') : tr('未授予');
  return <div className="privacy-checkup form-stack">
    <section aria-labelledby="privacy-network-title">
      <h3 id="privacy-network-title">{tr('近 7 天的外部请求')}</h3>
      <p>{tr('本机构建：无第三方分析、广告或自动日志上传。')}</p>
      <p className="hint">{tr('此版本未记录网络请求历史，无法统计近 7 天的请求次数。以下为可能联网的功能。')}</p>
      <ul>
        <li>{tr('同步：仅在你测试连接或解锁同步后，请求你配置的存储端点；自动同步需要单独开启。')}</li>
        <li>{tr('Bing 每日壁纸：获取图片及元数据；改用颜色或渐变可停止每日壁纸请求。')}</li>
        <li>{tr('手动获取网站信息、图片及导入修复：可能请求你选择的网站或图片来源；普通导航显示读取本机缓存。')}</li>
        <li>{tr('GitHub 贡献组件：授权后读取所选账号的公开贡献日历。')}</li>
        <li>{tr('搜索会前往所选搜索引擎；便笺中的远程图片可能连接图片来源。')}</li>
      </ul>
      <p>{!connection ? tr('同步状态暂时无法读取。') : !connection.profile || !connection.unlocked ? tr('当前同步未连接；不会自动发送同步数据。') : connection.autoSync ? tr('当前同步已解锁，自动同步已开启。') : tr('当前同步已解锁，自动同步未开启。')}</p>
      {endpoint && <p className="hint">{tr('配置的同步来源：{0}', [endpoint])}</p>}
    </section>
    <section aria-labelledby="privacy-permissions-title">
      <h3 id="privacy-permissions-title">{tr('当前权限与用途')}</h3>
      {!permissions ? <p role="status">{tr('正在读取权限…')}</p> : <>
        {!permissions.grantsKnown && <p className="hint">{tr('无法读取浏览器当前授权，以下仅为安装清单声明。')}</p>}
        <dl className="privacy-permission-list">{permissionNames.map(name => <div key={name}>
          <dt><code>{name}</code><span>{permissions.requiredPermissions.includes(name) ? tr('必需') : tr('可选')} · {grantLabel(permissions.grantedPermissions.includes(name))}</span></dt>
          <dd>{permissionPurpose(name)}</dd>
        </div>)}</dl>
        <h4>{tr('网站访问范围')}</h4>
        <dl className="privacy-permission-list">{origins.map(origin => <div key={origin}>
          <dt><code>{origin}</code><span>{permissions.requiredOrigins.includes(origin) ? tr('固定来源') : tr('额外授权来源')} · {grantLabel(permissions.grantedOrigins.includes(origin))}</span></dt>
          <dd>{origin === 'https://www.bing.com/*' ? tr('用于 Bing 每日壁纸。') : tr('允许读取此范围内的内容，用于你选择的网站信息、图片、GitHub 或自定义存储服务。')}</dd>
        </div>)}</dl>
        <p className="hint">{tr('可申请范围：{0}。这只是按需授权范围，不代表已获准访问所有网站。', [permissions.optionalOriginScope.join('、')])}</p>
        <p className="hint">{tr('可在浏览器的扩展详情中管理网站访问和通知权限。activeTab 仅在点击工具栏时临时生效。')}</p>
      </>}
    </section>
    <section aria-labelledby="privacy-storage-title">
      <h3 id="privacy-storage-title">{tr('数据存放在哪里')}</h3>
      <dl className="privacy-permission-list">
        <div><dt>{tr('本机 IndexedDB')}</dt><dd>{tr('导航、便笺、稍后读、图片和设置主要保存在本机加密 IndexedDB。设备密钥不可导出；同源应用仍可使用它，加密不能替代设备安全。')}</dd></div>
        <div><dt>{tr('浏览器会话存储')}</dt><dd>{tr('同步连接凭据和同步密码仅保留在 chrome.storage.session；锁定或退出浏览器会清除，业务备份和同步不包含这些凭据。')}</dd></div>
        <div><dt>{tr('你选择的存储端点')}</dt><dd>{tr('同步开启后，业务数据和图片使用独立同步密码加密，直接发送到你配置的服务。服务商仍可看到路径、请求时间和网络元数据。')}</dd></div>
        <div><dt>{tr('备份与旧副本')}</dt><dd>{tr('导出的 JSON/ZIP 备份不是密码加密文件。浏览器原生同步已停用；旧云端副本、其他设备和恢复点可能仍保留数据。')}</dd></div>
      </dl>
    </section>
  </div>;
}

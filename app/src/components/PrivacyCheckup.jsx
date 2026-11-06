import { useEffect, useState } from 'react';
import { tr } from '../i18n/index.js';
import { cloudOrigin } from '../lib/cloud-providers.js';
import { loadCloudSyncSettings, subscribeCloudSyncStatus } from '../lib/cloud-sync.js';
import { readPrivacyPermissions, permissionLabel, permissionPurpose } from '../lib/privacy-checkup.js';
import { Disclosure } from './ui/disclosure.jsx';
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
      <h3 id="privacy-network-title">{tr('联网功能')}</h3>
      <p>{tr('扩展不收集使用统计，也不自动上传日志。')}</p>
      <p className="hint">{tr('不保存网络请求历史。')}</p>
      <ul>
        <li>{tr('同步：测试连接及同步操作会访问你配置的存储服务。自动同步需要单独开启。')}</li>
        <li>{tr('启用随机壁纸后，会连接所选壁纸源。关闭随机壁纸或改用颜色背景可停止这些请求。')}</li>
        <li>{tr('获取网站信息、图片或修复导入图片时，可能访问相应网站和图片来源。日常显示导航只读取本机内容。')}</li>
        <li>{tr('GitHub 贡献组件：授权后读取所选账号的公开贡献日历。')}</li>
        <li>{tr('网页搜索会前往所选搜索引擎。加载便笺中的远程图片时，会连接图片来源。')}</li>
      </ul>
      <p>{!connection ? tr('同步状态暂时无法读取。') : !connection.profile || !connection.unlocked ? tr('当前同步未连接；不会自动发送同步数据。') : connection.autoSync ? tr('当前同步已解锁，自动同步已开启。') : tr('当前同步已解锁，自动同步未开启。')}</p>
      {endpoint && <p className="hint">{tr('同步服务：{0}', [endpoint])}</p>}
    </section>
    <section aria-labelledby="privacy-permissions-title">
      <h3 id="privacy-permissions-title">{tr('当前权限与用途')}</h3>
      {!permissions ? <p role="status">{tr('正在读取权限…')}</p> : <>
        {!permissions.grantsKnown && <p className="hint">{tr('无法读取浏览器当前授权，以下仅为安装清单声明。')}</p>}
        <dl className="privacy-permission-list">{permissionNames.map(name => <div key={name}>
          <dt>{permissionLabel(name)}<span>{permissions.requiredPermissions.includes(name) ? tr('必需') : tr('可选')} · {grantLabel(permissions.grantedPermissions.includes(name))}</span></dt>
          <dd>{permissionPurpose(name)}</dd>
        </div>)}</dl>
        <h4>{tr('网站访问范围')}</h4>
        <dl className="privacy-permission-list">{origins.map(origin => <div key={origin}>
          <dt><code>{origin}</code><span>{permissions.requiredOrigins.includes(origin) ? tr('固定来源') : tr('额外授权来源')} · {grantLabel(permissions.grantedOrigins.includes(origin))}</span></dt>
          <dd>{origin === 'https://www.bing.com/*' || origin === 'https://upload.wikimedia.org/*' ? tr('用于随机壁纸。') : tr('允许读取此范围内的内容，用于你选择的网站信息、图片、GitHub 或自定义存储服务。')}</dd>
        </div>)}</dl>
        <p className="hint">{tr('可在浏览器的扩展详情中管理网站访问和通知权限。')}</p>
        <Disclosure title={tr('权限详情')}>
          <dl className="privacy-permission-list">{permissionNames.map(name => <div key={name}><dt>{permissionLabel(name)}</dt><dd><code>{name}</code></dd></div>)}</dl>
          <p className="hint">{tr('可申请范围：{0}。这只是按需授权范围，不代表已获准访问所有网站。', [permissions.optionalOriginScope.join('、')])}</p>
          <p className="hint">{tr('activeTab 仅在点击工具栏时临时生效。')}</p>
        </Disclosure>
      </>}
    </section>
    <section aria-labelledby="privacy-storage-title">
      <h3 id="privacy-storage-title">{tr('数据存放在哪里')}</h3>
      <dl className="privacy-permission-list">
        <div><dt>{tr('当前浏览器')}</dt><dd>{tr('网站、便笺、稍后读、图片和设置在当前浏览器中加密保存。')}</dd></div>
        <div><dt>{tr('同步凭据')}</dt><dd>{tr('访问凭据由同步密码加密后保存在本机，不进入备份或同步。锁定或退出浏览器会清除会话中的密码和已解密凭据。')}</dd></div>
        <div><dt>{tr('你选择的存储服务')}</dt><dd>{tr('开启同步后，内容和图片加密后直接发送到你配置的服务。服务商仍可看到文件路径、请求时间和网络信息。')}</dd></div>
        <div><dt>{tr('备份和旧副本')}</dt><dd>{tr('导出的 JSON/ZIP 备份未加密。旧云端副本、其他设备和恢复点可能仍保留数据。')}</dd></div>
      </dl>
      <Disclosure title={tr('本机存储详情')}>
        <p>{tr('数据使用本机加密 IndexedDB 保存。设备密钥不可导出，但同源页面仍能使用；本机加密不能替代设备安全。')}</p>
        <p>{tr('解锁期间使用 chrome.storage.session。浏览器原生同步已停用。')}</p>
      </Disclosure>
    </section>
  </div>;
}

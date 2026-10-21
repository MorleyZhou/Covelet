import { tr, getLocale } from "../i18n/index.js";
import { useEffect, useState } from 'react';
import { LockKey, ArrowsClockwise } from '@phosphor-icons/react';
import Select from './Select.jsx';
import CloudHistory from './CloudHistory.jsx';
import { MessageDialog } from './PromptDialog.jsx';
import { validateCloudConfig, cloudOrigin } from '../lib/cloud-providers.js';
import { requestSiteAccess } from '../lib/site-info.js';
import {
  loadCloudSyncSettings, saveCloudSyncSettings, unlockCloudSync, lockCloudSync,
  syncCloudNow, supportsCloudSync, getCloudSyncStatus, subscribeCloudSyncStatus,
  getCloudSyncConflicts, restoreCloudSyncConflict,
} from '../lib/cloud-sync.js';
import './cloud-sync.css';

const blank = { provider: 'github', endpoint: '', bucket: '', region: 'cn-hangzhou', owner: '', repo: '', project: '', branch: 'main', prefix: 'covelet' };
const emptySecrets = { accessKeyId: '', secretAccessKey: '', sessionToken: '', token: '', username: '', appPassword: '' };
function profileOf(draft) {
  const { provider, endpoint, bucket, region, owner, repo, project, branch, prefix } = draft;
  if (provider === 'gitlab') return validateCloudConfig({ provider, endpoint, project, branch, prefix });
  if (provider === 'webdav') return validateCloudConfig({ provider, endpoint, prefix });
  return validateCloudConfig(provider === 'github' ? { provider, owner, repo, branch, prefix }
    : provider === 'oss' ? { provider, endpoint, bucket, region, prefix } : { provider, endpoint, bucket, prefix });
}
function targetLabel(profile) {
  if (profile.provider === 'github') return `${profile.owner}/${profile.repo} · ${profile.branch} / ${profile.prefix}`;
  if (profile.provider === 'gitlab') return `${profile.endpoint} / ${profile.project} · ${profile.branch} / ${profile.prefix}`;
  if (profile.provider === 'webdav') return `${profile.endpoint}${profile.prefix}`;
  return `${profile.endpoint} · ${profile.bucket} / ${profile.prefix}`;
}

export function CloudSyncSummary({ id, extension, metadata, demo = false, onOpen }) {
  const [saved, setSaved] = useState(null), [status, setStatus] = useState(() => getCloudSyncStatus());
  const [loadError, setLoadError] = useState(false);
  useEffect(() => {
    if (demo) return;
    let active = true;
    loadCloudSyncSettings().then((value) => { if (active) setSaved(value); }).catch(() => { if (active) setLoadError(true); });
    const off = subscribeCloudSyncStatus((value) => { if (active) setStatus(value); });
    return () => { active = false; off(); };
  }, [demo]);
  const label = loadError ? tr("配置读取失败") : status.phase === 'error' ? tr("同步失败") : status.phase === 'syncing' ? tr("同步中") : saved?.profile ? (status.unlocked ? tr("已解锁") : tr("需解锁")) : '';
  return <button id={id} type="button" className="extension-item" onClick={onOpen}>
    <span className="extension-item-icon extension-sync-icon"><ArrowsClockwise size="54%" weight="bold" aria-hidden="true" /></span>
    <span className="extension-item-content"><strong>{extension.name}</strong><span className="extension-item-description">{extension.description}</span><span className="extension-item-meta">{[label, metadata].filter(Boolean).join(' · ')}</span></span>
    <span className="extension-item-action">{saved?.profile ? tr("管理") : tr("配置")}</span>
  </button>;
}

export default function CloudSyncSettings({ demo = false, onBusyChange = () => {}, introduction }) {
  const [draft, setDraft] = useState(blank), [secrets, setSecrets] = useState(emptySecrets);
  const [password, setPassword] = useState(''), [autoSync, setAutoSync] = useState(false);
  const [saved, setSaved] = useState(null), [status, setStatus] = useState(() => getCloudSyncStatus());
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [feedback, setFeedback] = useState('');
  const [conflicts, setConflicts] = useState([]);
  const [editing, setEditing] = useState(false);
  const available = supportsCloudSync();
  const connectionMatches = (() => {
    try { return Boolean(saved?.profile) && JSON.stringify(profileOf(draft)) === JSON.stringify(saved.profile); }
    catch { return false; }
  })();
  useEffect(() => {
    if (demo) return;
    let active = true;
    loadCloudSyncSettings().then((value) => {
      if (!active) return;
      setSaved(value);
      if (value.profile) setDraft({ ...blank, ...value.profile });
      setAutoSync(value.autoSync);
      getCloudSyncConflicts().then((items) => { if (active) setConflicts(items); }).catch(() => {});
    }).catch(() => { if (active) setError(tr("暂时无法读取同步连接设置。")); });
    const off = subscribeCloudSyncStatus((value) => {
      if (active) {
        setStatus(value);
        if (['syncing', 'error'].includes(value.phase)) setFeedback('');
        if (value.conflicts > 0) getCloudSyncConflicts().then((items) => { if (active) setConflicts(items); }).catch(() => {});
      }
    });
    return () => { active = false; off(); };
  }, [demo]);
  function patch(value) { setDraft((current) => ({ ...current, ...value })); setFeedback(''); }
  async function run(action) {
    setBusy(true); onBusyChange(true); setError(''); setFeedback('');
    try { await action(); setStatus(getCloudSyncStatus()); }
    catch (reason) { setError(reason?.message || tr("同步操作未完成，本机数据已保留。")); }
    finally { setBusy(false); onBusyChange(false); }
  }
  function saveConnection() {
    if (busy || demo) return;
    let profile;
    try {
      profile = profileOf(draft);
      if (password.length < 12) throw new Error(tr("请设置至少 12 个字符的同步密码。"));
    } catch (reason) { setError(reason.message); return; }
    // Request the concrete origin directly in the user's click, before any await.
    const access = available ? requestSiteAccess(cloudOrigin(profile)) : Promise.resolve(true);
    run(async () => {
      if (!await access) throw new Error(tr("未获得此存储地址的访问权限，连接未保存。"));
      const value = await saveCloudSyncSettings(profile, secrets, password, { autoSync });
      setSaved(value); setDraft({ ...blank, ...value.profile });
      setSecrets(emptySecrets); setPassword('');
      setEditing(false);
      setFeedback(tr("配置已保存"));
    });
  }
  function credentialField(label, key, type = 'password', optional = false) {
    return <label>{label}{optional ? tr("（可选）") : ''}<input type={type} value={secrets[key]} autoComplete="off" spellCheck={false}
      maxLength={key === 'sessionToken' ? 8192 : 2048} onChange={(event) => setSecrets((current) => ({ ...current, [key]: event.target.value }))} disabled={busy || demo} /></label>;
  }
  const configuring = !saved?.profile || editing;
  function unlock() {
    if (busy || !connectionMatches) return;
    run(async () => { await unlockCloudSync(secrets, password); setSecrets(emptySecrets); setPassword(''); });
  }
  return <form className="cloud-sync-form form-stack" onSubmit={(event) => {
    event.preventDefault();
    if (event.nativeEvent?.isComposing) return;
    if (configuring) saveConnection();
    else if (!status.unlocked) unlock();
  }}>
    <div className="settings-scroll cloud-sync-fields">
      {introduction}
      {saved?.profile && <div className="cloud-connection-summary">
        <div><strong>{({ github: 'GitHub', gitlab: 'GitLab', r2: 'Cloudflare R2', oss: tr("阿里云 OSS"), webdav: 'WebDAV' })[saved.profile.provider]}</strong><span className="connection-state">{status.unlocked ? tr("已解锁") : tr("需解锁")}</span></div>
        <p className="cloud-sync-target">{targetLabel(saved.profile)}</p>
        <p className="hint">{tr("浏览器重启后需重新输入凭据和同步密码。")}</p>
        {!configuring && <button type="button" className="button quiet" disabled={busy} onClick={() => { setEditing(true); setError(''); setFeedback(''); }}>{tr("修改配置")}</button>}
      </div>}
      {configuring && <>
      <Select label={tr("存储服务")} value={draft.provider} disabled={busy || demo} onChange={(provider) => { patch({ provider, endpoint: provider === 'gitlab' ? 'https://gitlab.com' : '' }); setSecrets(emptySecrets); setPassword(''); }}
        options={[{ value: 'r2', label: 'Cloudflare R2' }, { value: 'oss', label: tr("阿里云 OSS") }, { value: 'github', label: 'GitHub' }, { value: 'gitlab', label: 'GitLab' }, { value: 'webdav', label: 'WebDAV' }]} />
      {draft.provider === 'github' ? <>
        <label>{tr("仓库所有者")}<input value={draft.owner} maxLength={100} spellCheck={false} disabled={busy || demo} onChange={(e) => patch({ owner: e.target.value })} /></label>
        <label>{tr("仓库名称")}<input value={draft.repo} maxLength={100} spellCheck={false} disabled={busy || demo} onChange={(e) => patch({ repo: e.target.value })} /></label>
        <label>{tr("分支")}<input value={draft.branch} maxLength={200} spellCheck={false} disabled={busy || demo} onChange={(e) => patch({ branch: e.target.value })} /></label>
      </> : draft.provider === 'gitlab' ? <>
        <label>{tr("GitLab 服务地址")}<input type="text" inputMode="url" value={draft.endpoint} maxLength={600} spellCheck={false} disabled={busy || demo} onChange={(e) => patch({ endpoint: e.target.value })} /></label>
        <label>{tr("项目 ID 或完整路径")}<input value={draft.project} placeholder="group/project" maxLength={300} spellCheck={false} disabled={busy || demo} onChange={(e) => patch({ project: e.target.value })} /></label>
        <label>{tr("分支")}<input value={draft.branch} maxLength={200} spellCheck={false} disabled={busy || demo} onChange={(e) => patch({ branch: e.target.value })} /></label>
      </> : draft.provider === 'webdav' ? <>
        <label>{tr("WebDAV 基目录地址")}<input type="text" inputMode="url" value={draft.endpoint} placeholder="https://dav.jianguoyun.com/dav/" maxLength={1000} autoComplete="off" spellCheck={false} disabled={busy || demo} onChange={(e) => patch({ endpoint: e.target.value })} /></label>
      </> : <>
        <label>{draft.provider === 'r2' ? tr("账户 API 地址") : tr("Bucket 访问域名")}<input type="text" inputMode="url" value={draft.endpoint} autoComplete="off" spellCheck={false} maxLength={600}
          placeholder={draft.provider === 'r2' ? tr("https://<账户ID>.r2.cloudflarestorage.com") : 'https://<bucket>.oss-cn-hangzhou.aliyuncs.com'} disabled={busy || demo} onChange={(e) => patch({ endpoint: e.target.value })} /></label>
        <label>{tr("Bucket 名称")}<input value={draft.bucket} maxLength={63} spellCheck={false} disabled={busy || demo} onChange={(e) => patch({ bucket: e.target.value })} /></label>
        {draft.provider === 'oss' && <label>{tr("地域")}<input value={draft.region} maxLength={80} spellCheck={false} disabled={busy || demo} onChange={(e) => patch({ region: e.target.value })} /></label>}
      </>}
      <label>{tr("保存目录")}<input value={draft.prefix} maxLength={300} spellCheck={false} disabled={busy || demo} onChange={(e) => patch({ prefix: e.target.value })} /></label>
      </>}
      {(configuring || !status.unlocked) && <>
      {['github', 'gitlab'].includes(draft.provider) ? credentialField(tr("{0} 访问令牌", [draft.provider === 'github' ? 'GitHub' : 'GitLab']), 'token') : draft.provider === 'webdav' ? <>
        {credentialField(tr("WebDAV 用户名"), 'username', 'text')}
        {credentialField(tr("WebDAV 应用密码"), 'appPassword')}
      </> : <>
        {credentialField('Access Key ID', 'accessKeyId', 'text')}
        {credentialField('Secret Access Key', 'secretAccessKey')}
        {credentialField(tr("临时安全令牌"), 'sessionToken', 'password', true)}
      </>}
      <label>{tr("同步密码")}<input type="password" value={password} maxLength={1024} autoComplete={configuring ? 'new-password' : 'current-password'} aria-describedby="cloud-password-help" disabled={busy || demo} onChange={(e) => setPassword(e.target.value)} /></label>
      <p className="hint" id="cloud-password-help">{tr("至少 12 个字符。密码无法找回，其他设备须使用相同密码。")}</p>
      </>}
      {configuring && <>
      <label className="check-label"><input type="checkbox" checked={autoSync} disabled={busy || demo} onChange={(e) => setAutoSync(e.target.checked)} />{tr("解锁后自动同步")}</label>
      <p className="hint">{tr("自动同步仅在 Covelet 页面打开且已解锁时运行。")}</p>
      <details className="context-help"><summary>{tr("连接要求")}</summary>
      {draft.provider === 'r2' && <p className="hint">{tr("创建专用 Bucket，并使用仅限该 Bucket 对象读写的 API 凭据。")}</p>}
      {draft.provider === 'github' && <p className="hint">{tr("建议使用私有仓库及仅限该仓库 Contents 读写的令牌；同步会生成仓库提交。")}</p>}
      {draft.provider === 'gitlab' && <p className="hint">{tr("先创建私有项目和分支，使用具备 API 写权限的专用令牌；同步会生成仓库提交。")}</p>}
      {draft.provider === 'webdav' && <p className="hint">{tr("支持坚果云、Nextcloud 等 HTTPS WebDAV。请先在基目录内建好保存目录，并使用应用密码。免费服务可能限制流量、请求频率和文件数量。")}</p>}
      {draft.provider === 'oss' && <p className="hint">{tr("使用专用 RAM 凭据或临时令牌；部分 OSS 账号需要自己的 HTTPS 域名。")}</p>}
      </details>
      <p className="hint">{tr("保存时将请求访问所选存储地址。")}</p>
      </>}
      {!configuring && saved?.autoSync && <p className="hint">{tr("自动同步已开启，仅在 Covelet 页面打开且已解锁时运行。")}</p>}
      <details className="context-help"><summary>{tr("同步内容与隐私")}</summary><p className="hint">{tr("导航和设置加密后直接写入所选存储。图片、访问凭据和同步密码不参与同步，凭据和密码仅保留在当前浏览器会话。")}</p></details>
      {demo ? <p className="hint" role="status">{tr("演示模式无法连接存储。")}</p> : !available && <p className="hint" role="status">{tr("请在 Chrome 或 Edge 扩展中连接存储。")}</p>}
      <MessageDialog message={error || feedback || (status.phase === 'error' ? status.message : '')} onClose={() => { setError(''); setFeedback(''); }} />
      {status.lastSync > 0 && <p className="hint">{tr("最近同步：")}{new Date(status.lastSync).toLocaleString(getLocale())}</p>}
      {conflicts.length > 0 && <div className="cloud-sync-conflicts"><strong>{tr("保留的冲突版本")}</strong>{conflicts.map((item) => <div key={item.id}><span>{item.name || item.key}{item.deleted ? tr("（删除版本）") : ''}</span><button type="button" className="button" disabled={busy} onClick={() => run(async () => { await restoreCloudSyncConflict(item.id); setConflicts(await getCloudSyncConflicts()); })}>{tr("恢复此版本")}</button></div>)}</div>}
      {saved?.profile && !configuring && <CloudHistory disabled={busy || demo || !available} unlocked={status.unlocked} onBusyChange={(value) => { setBusy(value); onBusyChange(value); }} />}
    </div>
    <div className="settings-footer cloud-sync-actions">
      {configuring ? <>
        {saved?.profile && <button type="button" className="button" disabled={busy} onClick={() => { setDraft({ ...blank, ...saved.profile }); setAutoSync(saved.autoSync); setSecrets(emptySecrets); setPassword(''); setEditing(false); setError(''); }}>{tr("取消修改")}</button>}
        <button type="submit" className="button primary" disabled={busy || demo || !available}>{busy ? tr("正在保存…") : tr("保存配置")}</button>
      </> : <>
        {status.unlocked ? <>
          <button type="button" className="button quiet" disabled={busy} onClick={() => run(lockCloudSync)}><LockKey size={16} />{tr("锁定")}</button>
          <button type="button" className="button primary" disabled={busy || demo || !available || !connectionMatches} onClick={() => run(async () => { await syncCloudNow(); setConflicts(await getCloudSyncConflicts()); })}><ArrowsClockwise size={16} />{busy ? tr("正在同步…") : tr("立即同步")}</button>
        </> : <button type="submit" className="button primary" disabled={busy || demo || !available || !connectionMatches}>{busy ? tr("正在解锁…") : tr("解锁")}</button>}
      </>}
    </div>
  </form>;
}

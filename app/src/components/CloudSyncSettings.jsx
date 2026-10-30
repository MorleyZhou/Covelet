import { tr, getLocale } from "../i18n/index.js";
import { useEffect, useState } from 'react';
import { LockKey, ArrowsClockwise } from '@phosphor-icons/react';
import Select from './Select.jsx';
import { Disclosure } from './ui/disclosure.jsx';
import CloudHistory from './CloudHistory.jsx';
import PromptDialog, { MessageDialog } from './PromptDialog.jsx';
import { validateCloudConfig, cloudOrigin } from '../lib/cloud-providers.js';
import { requestSiteAccess } from '../lib/site-info.js';
import {
  loadCloudSyncSettings, saveCloudSyncSettings, unlockCloudSync, lockCloudSync,
  syncCloudNow, supportsCloudSync, getCloudSyncStatus, subscribeCloudSyncStatus,
  getCloudSyncConflicts, restoreCloudSyncConflict,
} from '../lib/cloud-sync.js';
import './cloud-sync.css';
import { Button } from './ui/button.jsx';
import { Input } from './ui/input.jsx';
import { Switch } from './ui/switch.jsx';

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
  return <Button variant="unstyled" size="unstyled" id={id} type="button" className="extension-item" onClick={onOpen}>
    <span className="extension-item-icon extension-sync-icon"><ArrowsClockwise size="54%" weight="bold" aria-hidden="true" /></span>
    <span className="extension-item-content"><strong>{extension.name}</strong><span className="extension-item-description">{extension.description}</span><span className="extension-item-meta">{[label, metadata].filter(Boolean).join(' · ')}</span></span>
    <span className="extension-item-action">{saved?.profile ? tr("管理") : tr("配置")}</span>
  </Button>;
}

export default function CloudSyncSettings({ demo = false, onBusyChange = () => {}, introduction }) {
  const [draft, setDraft] = useState(blank), [secrets, setSecrets] = useState(emptySecrets);
  const [password, setPassword] = useState(''), [autoSync, setAutoSync] = useState(false);
  const [saved, setSaved] = useState(null), [status, setStatus] = useState(() => getCloudSyncStatus());
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [conflicts, setConflicts] = useState([]);
  const [conflictChoice, setConflictChoice] = useState(null);
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
        getCloudSyncConflicts().then((items) => { if (active) setConflicts(items); }).catch(() => {});
      }
    });
    return () => { active = false; off(); };
  }, [demo]);
  function patch(value) { setDraft((current) => ({ ...current, ...value })); }
  async function run(action) {
    setBusy(true); onBusyChange(true); setError('');
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
    });
  }
  function credentialField(label, key, type = 'password', optional = false) {
    return <label>{label}{optional ? tr("（可选）") : ''}<Input type={type} value={secrets[key]} autoComplete="off" spellCheck={false}
      maxLength={key === 'sessionToken' ? 8192 : 2048} onChange={(event) => setSecrets((current) => ({ ...current, [key]: event.target.value }))} disabled={busy || demo} /></label>;
  }
  const configuring = !saved?.profile || editing;
  function unlock() {
    if (busy || !connectionMatches) return;
    run(async () => { await unlockCloudSync(secrets, password); setSecrets(emptySecrets); setPassword(''); });
  }
  function conflictLabel(item) {
    if (item.namespace === 'assets' || item.namespace === 'navigation-icons' || item.namespace === 'provider-icons') return tr('图片与图标');
    if (item.namespace === 'wallpaper') return tr('壁纸');
    if (item.key === 'owntab.local.v1') return tr('导航、文件夹与外观');
    if (item.key === 'covelet.tools.v1') return tr('便笺、稍后读与标签快照');
    if (item.key === 'covelet.content.preferences.v1') return tr('别名与隐私标记');
    if (item.key === 'covelet.desktop-templates.v1') return tr('桌面方案');
    if (item.key === 'covelet.recovery-point.v1') return tr('恢复前副本');
    if (item.key.startsWith('covelet.clock.v1.')) return tr('时钟');
    return tr('扩展数据');
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
        {!configuring && <Button variant="ghost" type="button" className="button quiet" disabled={busy} onClick={() => { setEditing(true); setError(''); }}>{tr("修改配置")}</Button>}
      </div>}
      {configuring && <>
      <Select label={tr("存储服务")} value={draft.provider} disabled={busy || demo} onChange={(provider) => { patch({ provider, endpoint: provider === 'gitlab' ? 'https://gitlab.com' : '' }); setSecrets(emptySecrets); setPassword(''); }}
        options={[{ value: 'r2', label: 'Cloudflare R2' }, { value: 'oss', label: tr("阿里云 OSS") }, { value: 'github', label: 'GitHub' }, { value: 'gitlab', label: 'GitLab' }, { value: 'webdav', label: 'WebDAV' }]} />
      {draft.provider === 'github' ? <>
        <label>{tr("仓库所有者")}<Input value={draft.owner} maxLength={100} spellCheck={false} disabled={busy || demo} onChange={(e) => patch({ owner: e.target.value })} /></label>
        <label>{tr("仓库名称")}<Input value={draft.repo} maxLength={100} spellCheck={false} disabled={busy || demo} onChange={(e) => patch({ repo: e.target.value })} /></label>
        <label>{tr("分支")}<Input value={draft.branch} maxLength={200} spellCheck={false} disabled={busy || demo} onChange={(e) => patch({ branch: e.target.value })} /></label>
      </> : draft.provider === 'gitlab' ? <>
        <label>{tr("GitLab 服务地址")}<Input type="text" inputMode="url" value={draft.endpoint} maxLength={600} spellCheck={false} disabled={busy || demo} onChange={(e) => patch({ endpoint: e.target.value })} /></label>
        <label>{tr("项目 ID 或完整路径")}<Input value={draft.project} placeholder="group/project" maxLength={300} spellCheck={false} disabled={busy || demo} onChange={(e) => patch({ project: e.target.value })} /></label>
        <label>{tr("分支")}<Input value={draft.branch} maxLength={200} spellCheck={false} disabled={busy || demo} onChange={(e) => patch({ branch: e.target.value })} /></label>
      </> : draft.provider === 'webdav' ? <>
        <label>{tr("WebDAV 基目录地址")}<Input type="text" inputMode="url" value={draft.endpoint} placeholder="https://dav.jianguoyun.com/dav/" maxLength={1000} autoComplete="off" spellCheck={false} disabled={busy || demo} onChange={(e) => patch({ endpoint: e.target.value })} /></label>
      </> : <>
        <label>{draft.provider === 'r2' ? tr("账户 API 地址") : tr("Bucket 访问域名")}<Input type="text" inputMode="url" value={draft.endpoint} autoComplete="off" spellCheck={false} maxLength={600}
          placeholder={draft.provider === 'r2' ? tr("https://<账户ID>.r2.cloudflarestorage.com") : 'https://<bucket>.oss-cn-hangzhou.aliyuncs.com'} disabled={busy || demo} onChange={(e) => patch({ endpoint: e.target.value })} /></label>
        <label>{tr("Bucket 名称")}<Input value={draft.bucket} maxLength={63} spellCheck={false} disabled={busy || demo} onChange={(e) => patch({ bucket: e.target.value })} /></label>
        {draft.provider === 'oss' && <label>{tr("地域")}<Input value={draft.region} maxLength={80} spellCheck={false} disabled={busy || demo} onChange={(e) => patch({ region: e.target.value })} /></label>}
      </>}
      <label>{tr("保存目录")}<Input value={draft.prefix} maxLength={300} spellCheck={false} disabled={busy || demo} onChange={(e) => patch({ prefix: e.target.value })} /></label>
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
      <label>{tr("同步密码")}<Input type="password" value={password} maxLength={1024} autoComplete={configuring ? 'new-password' : 'current-password'} aria-describedby="cloud-password-help" disabled={busy || demo} onChange={(e) => setPassword(e.target.value)} /></label>
      <p className="hint" id="cloud-password-help">{tr("至少 12 个字符。密码无法找回，其他设备须使用相同密码。")}</p>
      </>}
      {configuring && <>
      <label className="check-label"><Switch checked={autoSync} disabled={busy || demo} onCheckedChange={(nextChecked) => setAutoSync(nextChecked)} />{tr("解锁后自动同步")}</label>
      <p className="hint">{tr("自动同步仅在 Covelet 页面打开且已解锁时运行。")}</p>
      <Disclosure className="context-help" title={tr("连接要求")}>
      {draft.provider === 'r2' && <p className="hint">{tr("创建专用 Bucket，并使用仅限该 Bucket 对象读写的 API 凭据。")}</p>}
      {draft.provider === 'github' && <p className="hint">{tr("建议使用私有仓库及仅限该仓库 Contents 读写的令牌；同步会生成仓库提交。")}</p>}
      {draft.provider === 'gitlab' && <p className="hint">{tr("先创建私有项目和分支，使用具备 API 写权限的专用令牌；同步会生成仓库提交。")}</p>}
      {draft.provider === 'webdav' && <p className="hint">{tr("支持坚果云、Nextcloud 等 HTTPS WebDAV。请先在基目录内建好保存目录，并使用应用密码。免费服务可能限制流量、请求频率和文件数量。")}</p>}
      {draft.provider === 'oss' && <p className="hint">{tr("使用专用 RAM 凭据或临时令牌；部分 OSS 账号需要自己的 HTTPS 域名。")}</p>}
      </Disclosure>
      <p className="hint">{tr("保存时将请求访问所选存储地址。")}</p>
      </>}
      {!configuring && saved?.autoSync && <p className="hint">{tr("自动同步已开启，仅在 Covelet 页面打开且已解锁时运行。")}</p>}
      <Disclosure className="context-help" title={tr("同步内容与隐私")}>
        <p className="hint">{tr('同步桌面、内置扩展、图片和图标。')}</p>
        <p className="hint">{tr('数据加密后上传，隐藏密码和隐藏状态不会同步。关闭浏览器后需重新输入访问凭据和同步密码。')}</p>
        <p className="hint">{tr('首次同步会迁入旧版导航与便笺同步内容。其他设备请升级到支持全量同步的版本，使用相同目录和同步密码。')}</p>
      </Disclosure>
      {demo ? <p className="hint" role="status">{tr("演示模式无法连接存储。")}</p> : !available && <p className="hint" role="status">{tr("请在 Chrome 或 Edge 扩展中连接存储。")}</p>}
      <MessageDialog message={error || (status.phase === 'error' ? status.message : '')} onClose={() => { setError(''); }} />
      {status.lastSync > 0 && <p className="hint">{tr("最近同步：")}{new Date(status.lastSync).toLocaleString(getLocale())}</p>}
      {saved?.profile && !configuring && <section className="cloud-tool-sync" aria-label={tr('全部数据加密同步')}>
        <strong>{tr('全部数据加密同步')}</strong>
        <div className="cloud-tool-sync-status" role="status"><span>{tr('待同步：{0} 项', [status.pending || 0])}</span><span>{tr('保留的冲突版本：{0}', [conflicts.length])}</span></div>
        {status.phase === 'syncing' && <p className="hint" role="status">{status.message || tr('正在同步…')}</p>}
      </section>}
      {conflicts.length > 0 && <div className="cloud-sync-conflicts"><strong>{tr("保留的冲突版本")}</strong>
        <p className="hint">{tr('不同设备同时修改的版本均已保留。选择采用一个版本，或将当前本机内容作为新版本；选择后再同步到其他设备。')}</p>
        {conflicts.map((item, index) => <div key={item.id}><span>{conflictLabel(item)} · {index + 1}{item.deleted ? tr("（删除版本）") : ''}</span><div>
          <Button variant="ghost" type="button" disabled={busy || !status.unlocked} onClick={() => setConflictChoice({ ...item, discard: true })}>{tr('保留当前版本')}</Button>
          <Button variant="secondary" type="button" disabled={busy || !status.unlocked} onClick={() => setConflictChoice({ ...item, discard: false })}>{tr('采用此版本')}</Button>
        </div></div>)}
      </div>}
      {conflictChoice && <PromptDialog title={tr('处理并发版本')} action={conflictChoice.discard ? tr('保留当前版本') : tr('采用此版本')} busy={busy} onCancel={() => setConflictChoice(null)}
        onConfirm={() => run(async () => { await restoreCloudSyncConflict(conflictChoice.id, { discard: conflictChoice.discard }); setConflictChoice(null); setConflicts(await getCloudSyncConflicts()); })}>
        <p>{tr('此操作会更新对应的数据类别，并在下次同步时作为新版本上传。当前隐藏状态和本机隐藏密码保持不变。')}</p>
      </PromptDialog>}
      {saved?.profile && !configuring && <Disclosure className="context-help" title={tr('旧版导航历史')}>
        <p className="hint">{tr('这里保留升级前的导航历史。新版本的桌面、扩展数据和图标使用统一加密同步；旧版客户端请升级后继续使用。')}</p>
        <CloudHistory disabled={busy || demo || !available} unlocked={status.unlocked} onBusyChange={(value) => { setBusy(value); onBusyChange(value); }} />
      </Disclosure>}
    </div>
    <div className="settings-footer cloud-sync-actions">
      {configuring ? <>
        {saved?.profile && <Button variant="secondary" type="button" className="button" disabled={busy} onClick={() => { setDraft({ ...blank, ...saved.profile }); setAutoSync(saved.autoSync); setSecrets(emptySecrets); setPassword(''); setEditing(false); setError(''); }}>{tr("取消修改")}</Button>}
        <Button variant="default" type="submit" className="button primary" disabled={busy || demo || !available}>{busy ? tr("正在保存…") : tr("保存配置")}</Button>
      </> : <>
        {status.unlocked ? <>
          <Button variant="ghost" type="button" className="button quiet" disabled={busy} onClick={() => run(lockCloudSync)}><LockKey size={16} />{tr("锁定")}</Button>
          <Button variant="default" type="button" className="button primary" disabled={busy || demo || !available || !connectionMatches} onClick={() => run(async () => { await syncCloudNow(); setConflicts(await getCloudSyncConflicts()); })}><ArrowsClockwise size={16} />{busy ? tr("正在同步…") : tr("立即同步")}</Button>
        </> : <Button variant="default" type="submit" className="button primary" disabled={busy || demo || !available || !connectionMatches}>{busy ? tr("正在解锁…") : tr("解锁")}</Button>}
      </>}
    </div>
  </form>;
}

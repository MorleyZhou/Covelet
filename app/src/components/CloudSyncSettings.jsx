import { tr, getLocale } from "../i18n/index.js";
import { useContext, useEffect, useRef, useState } from 'react';
import { PresentationContext } from '../lib/presentation.js';
import { LockKey, ArrowsClockwise } from '@phosphor-icons/react';
import { Disclosure } from './ui/disclosure.jsx';
import CloudHistory from './CloudHistory.jsx';
import PromptDialog, { MessageDialog } from './PromptDialog.jsx';
import { validateCloudConfig, cloudOrigin } from '../lib/cloud-providers.js';
import { cloudProviderLabel, SYNC_PROVIDERS, finishCloudSetup } from '../lib/cloud-connection.js';
import { validateCloudPassword } from '../lib/cloud-crypto.js';
import { conflictRecordPreview, conflictRecordScope, conflictRecordSummary, conflictRecordImpact } from '../lib/cloud-conflict-preview.js';
import { userErrorMessage } from '../lib/user-error.js';
import { requestSiteAccess } from '../lib/site-info.js';
import {
  loadCloudSyncSettings, testCloudConnection, saveCloudSyncSettings, unlockCloudSync, lockCloudSync, useLocalOnlyCloudSync,
  syncCloudNow, supportsCloudSync, getCloudSyncStatus, subscribeCloudSyncStatus,
  getCloudSyncConflicts, previewCloudSyncConflict, restoreCloudSyncConflict,
} from '../lib/cloud-sync.js';
import './cloud-sync.css';
import { Button } from './ui/button.jsx';
import { Input } from './ui/input.jsx';
import { Switch } from './ui/switch.jsx';

const blank = { provider: 'webdav', endpoint: '', bucket: '', region: 'cn-hangzhou', owner: '', repo: '', project: '', branch: 'main', prefix: 'covelet' };
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

export default function CloudSyncSettings({ demo = false, onBusyChange = () => {}, introduction, onLocalOnly = () => {} }) {
  const presentation = useContext(PresentationContext);
  const presentationActive = useRef(presentation.active);
  presentationActive.current = presentation.active;
  const [draft, setDraft] = useState(blank), [secrets, setSecrets] = useState(emptySecrets);
  const [password, setPassword] = useState(''), [autoSync, setAutoSync] = useState(false);
  const [saved, setSaved] = useState(null), [status, setStatus] = useState(() => getCloudSyncStatus());
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [draftTest, setDraftTest] = useState(null), [testing, setTesting] = useState(false), [testFailed, setTestFailed] = useState(false);
  const [conflicts, setConflicts] = useState([]);
  const [conflictChoice, setConflictChoice] = useState(null);
  const conflictPreviewEpoch = useRef(0);
  useEffect(() => {
    if (presentation.active) { conflictPreviewEpoch.current++; setConflictChoice(null); }
  }, [presentation.active]);
  const [step, setStep] = useState(demo ? 1 : null), [loaded, setLoaded] = useState(demo);
  const wasUnlocked = useRef(status.unlocked);
  const fieldsRef = useRef(null);
  useEffect(() => { if (fieldsRef.current) fieldsRef.current.scrollTop = 0; }, [step]);
  const available = supportsCloudSync();
  let currentProfile = null;
  try { currentProfile = profileOf(draft); } catch { /* Incomplete connection draft. */ }
  const connectionMatches = Boolean(saved?.profile) && JSON.stringify(currentProfile) === JSON.stringify(saved.profile);
  useEffect(() => {
    if (demo) return;
    let active = true;
    loadCloudSyncSettings().then((value) => {
      if (!active) return;
      setSaved(value);
      setStep(value.profile ? null : 1); setLoaded(true);
      if (value.profile) setDraft({ ...blank, ...value.profile });
      setAutoSync(value.autoSync);
      getCloudSyncConflicts().then((items) => { if (active) setConflicts(items); }).catch(() => {});
    }).catch(() => { if (active) { setError(tr("暂时无法读取同步连接设置。")); setLoaded(true); } });
    const off = subscribeCloudSyncStatus((value) => {
      if (active) {
        setStatus(value);
        if (!value.unlocked) setConflictChoice(null);
        if (wasUnlocked.current && !value.unlocked) setDraftTest(null);
        wasUnlocked.current = value.unlocked;
        getCloudSyncConflicts().then((items) => { if (active) setConflicts(items); }).catch(() => {});
      }
    });
    return () => { active = false; off(); };
  }, [demo]);
  function patch(value) { setTestFailed(false); setDraftTest(null); setDraft((current) => ({ ...current, ...value })); }
  async function run(action) {
    setBusy(true); onBusyChange(true); setError('');
    try { await action(); setStatus(getCloudSyncStatus()); }
    catch (reason) { setError(userErrorMessage(reason, tr("同步操作未完成，本机数据已保留。"))); }
    finally { setBusy(false); onBusyChange(false); }
  }
  function saveConnection(firstSync = false) {
    if (busy || demo) return;
    let profile;
    try {
      profile = profileOf(draft);
      validateCloudPassword(password);
    } catch (reason) { setError(userErrorMessage(reason)); return; }
    // Request the concrete origin directly in the user's click, before any await.
    const access = available ? requestSiteAccess(cloudOrigin(profile)) : Promise.resolve(true);
    run(async () => {
      if (!await access) throw new Error(tr("未获得此存储地址的访问权限，连接未保存。"));
      try {
        const value = await finishCloudSetup({ profile, secrets, password, autoSync, firstSync }, { saveCloudSyncSettings, syncCloudNow });
        setSaved(value); setDraft({ ...blank, ...value.profile });
        setSecrets(emptySecrets); setPassword(''); setDraftTest(null); setStep(null);
      } finally { setSaved(await loadCloudSyncSettings()); }
    });
  }
  function testConnection() {
    if (busy || demo) return;
    let profile;
    try { profile = profileOf(draft); } catch (reason) { setError(userErrorMessage(reason)); return; }
    const access = requestSiteAccess(cloudOrigin(profile));
    setDraftTest(null); setTestFailed(true); setTesting(true);
    run(async () => {
      try {
        if (!await access) throw new Error(tr('尚未授权访问这个云服务，请先在设置中授权。'));
        const result = configuring || !status.unlocked ? await testCloudConnection(profile, secrets) : await testCloudConnection();
        setDraftTest(result); setTestFailed(false);
      } finally { setTesting(false); setSaved(await loadCloudSyncSettings()); }
    });
  }
  function credentialField(label, key, type = 'password', optional = false) {
    return <label>{label}{optional ? tr("（可选）") : ''}<Input type={type} value={secrets[key]} autoComplete="off" spellCheck={false}
      maxLength={key === 'sessionToken' ? 8192 : 2048} onChange={(event) => { setTestFailed(false); setDraftTest(null); setSecrets((current) => ({ ...current, [key]: event.target.value })); }} disabled={busy || demo} /></label>;
  }
  const configuring = step !== null;
  function localOnly() {
    if (busy) return;
    run(async () => {
      if (!demo) setSaved(await useLocalOnlyCloudSync());
      setSecrets(emptySecrets); setPassword(''); setDraftTest(null); setTestFailed(false); setAutoSync(false);
      onLocalOnly();
    });
  }
  function chooseProvider(provider) {
    if (provider === draft.provider) return;
    patch({ provider, endpoint: provider === 'gitlab' ? 'https://gitlab.com' : '' });
    setSecrets(emptySecrets); setPassword('');
  }
  function unlock() {
    if (busy || !connectionMatches) return;
    run(async () => { setSaved(await unlockCloudSync(secrets, password)); setDraftTest(null); setSecrets(emptySecrets); setPassword(''); });
  }
  const connectionTest = !testFailed && (configuring || !status.unlocked ? draftTest : saved?.connectionTest);
  return <form className="cloud-sync-form form-stack" onSubmit={(event) => {
    event.preventDefault();
    if (event.nativeEvent?.isComposing || busy || !loaded) return;
    if (configuring) {
      if (step === 1) setStep(2);
      else if (step === 2 && draftTest && !testFailed) setStep(3);
      else if (step === 3) saveConnection(true);
    } else if (!status.unlocked) unlock();
  }}>
    <div ref={fieldsRef} className="settings-scroll cloud-sync-fields">
      {introduction}
      {!loaded && <p className="hint" role="status">{tr('正在读取同步设置…')}</p>}
      {configuring && <ol className="cloud-setup-steps" aria-label={tr('同步设置步骤')}>
        {[tr('选择渠道'), tr('测试连接'), tr('密码与首次同步')].map((label, index) => <li key={index} aria-current={step === index + 1 ? 'step' : undefined}>
          <span aria-hidden="true">{index + 1}</span>{label}
        </li>)}
      </ol>}
      {step === 3 && currentProfile && <p className="cloud-sync-target">{cloudProviderLabel(currentProfile.provider)} · {targetLabel(currentProfile)}</p>}
      {saved?.profile && !configuring && <div className="cloud-connection-summary">
        <div><strong>{cloudProviderLabel(saved.profile.provider)}</strong><span className="connection-state">{status.unlocked ? tr("已解锁") : tr("需解锁")}</span></div>
        <p className="cloud-sync-target">{targetLabel(saved.profile)}</p>
        <p className="hint">{tr("凭据仅在本次浏览器会话保留；重启后需重新输入凭据和同步密码。")}</p>
        <Button variant="ghost" type="button" className="button quiet" disabled={busy} onClick={() => { setStep(1); setDraftTest(null); setError(''); }}>{tr("修改配置")}</Button>
      </div>}
      {(step === 2 || step === 3 || saved?.profile && !configuring) && <div className="cloud-connection-test" role="status" aria-live="polite">
        <p className="hint">{testing ? tr('正在测试连接…') : testFailed ? tr('最近连接测试未通过，请检查后重试。') : connectionTest ? tr('最近连接测试通过：{0}', [new Date(connectionTest.testedAt).toLocaleString(getLocale())]) : saved?.profile && !configuring ? tr('配置已保存；当前凭据的连接尚未验证。') : tr('连接尚未验证。')}</p>
        <p className="hint">{tr('测试只检查登录和目录读取，不验证写入或同步密码。保存配置不会执行连接测试。')}</p>
      </div>}
      {step === 1 && <div className="cloud-channel-options" role="group" aria-label={tr('选择渠道')}>
        {SYNC_PROVIDERS.map(provider => <Button key={provider} type="button" variant="secondary" className="cloud-channel-option" aria-pressed={draft.provider === provider} disabled={busy || demo} onClick={() => chooseProvider(provider)}>
          <strong>{cloudProviderLabel(provider)}</strong>{provider === 'webdav' && <span>{tr('推荐')}</span>}
        </Button>)}
      </div>}
      {step === 2 && <>
      <strong>{cloudProviderLabel(draft.provider)}</strong>
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
      {(step === 2 || !configuring && saved?.profile && !status.unlocked) && <>
      {['github', 'gitlab'].includes(draft.provider) ? credentialField(tr("{0} 访问令牌", [draft.provider === 'github' ? 'GitHub' : 'GitLab']), 'token') : draft.provider === 'webdav' ? <>
        {credentialField(tr("WebDAV 用户名"), 'username', 'text')}
        {credentialField(tr("WebDAV 应用密码"), 'appPassword')}
      </> : <>
        {credentialField('Access Key ID', 'accessKeyId', 'text')}
        {credentialField('Secret Access Key', 'secretAccessKey')}
        <Disclosure className="context-help" title={tr('临时安全令牌')}>{credentialField(tr("临时安全令牌"), 'sessionToken', 'password', true)}</Disclosure>
      </>}
      </>}
      {(step === 3 || !configuring && saved?.profile && !status.unlocked) && <>
      <label>{tr("同步密码")}<Input type="password" value={password} maxLength={1024} autoComplete={configuring ? 'new-password' : 'current-password'} aria-describedby="cloud-password-help" disabled={busy || demo} onChange={(e) => setPassword(e.target.value)} /></label>
      <p className="hint" id="cloud-password-help">{tr("至少 12 个字符。密码无法找回，其他设备须使用相同密码。")}</p>
      </>}
      {step === 3 && <>
      <p className="hint">{tr('首次同步会读取云端数据并尝试写入。失败可重试，或仅在本机使用。')}</p>
      <label className="check-label"><Switch checked={autoSync} disabled={busy || demo} onCheckedChange={(nextChecked) => setAutoSync(nextChecked)} />{tr('首次同步成功后自动同步')}</label>
      <p className="hint">{tr("自动同步仅在 Covelet 页面打开且已解锁时运行。")}</p>
      </>}
      {step === 2 && <Disclosure className="context-help" title={tr("连接要求")}>
      {draft.provider === 'r2' && <p className="hint">{tr("创建专用 Bucket，并使用仅限该 Bucket 对象读写的 API 凭据。")}</p>}
      {draft.provider === 'github' && <p className="hint">{tr("建议使用私有仓库及仅限该仓库 Contents 读写的令牌；同步会生成仓库提交。")}</p>}
      {draft.provider === 'gitlab' && <p className="hint">{tr("先创建私有项目和分支，使用具备 API 写权限的专用令牌；同步会生成仓库提交。")}</p>}
      {draft.provider === 'webdav' && <p className="hint">{tr("使用 HTTPS WebDAV 和应用密码。先在基目录内建好保存目录；服务商可能限制流量和请求频率。")}</p>}
      {draft.provider === 'oss' && <p className="hint">{tr("使用专用 RAM 凭据或临时令牌；部分 OSS 账号需要自己的 HTTPS 域名。")}</p>}
      </Disclosure>}
      {step === 2 && <p className="hint">{tr('测试时仅申请所选存储地址的访问权限。')}</p>}
      {step === 3 && <p className="hint">{tr('仅保存配置不会验证连接、开启自动同步或执行首次同步。')}</p>}
      {!configuring && saved?.autoSync && <p className="hint">{tr("自动同步已开启，仅在 Covelet 页面打开且已解锁时运行。")}</p>}
      <Disclosure className="context-help" title={tr("同步内容与隐私")}>
        <p className="hint">{tr('同步桌面、内置扩展、图片和图标。')}</p>
        <p className="hint">{tr('数据加密后上传，隐藏密码和隐藏状态不会同步。关闭浏览器后需重新输入访问凭据和同步密码。')}</p>
        <p className="hint">{tr('其他设备请更新 Covelet，并使用相同的保存目录和同步密码。')}</p>
      </Disclosure>
      {demo ? <p className="hint" role="status">{tr("演示模式无法连接存储。")}</p> : !available && <p className="hint" role="status">{tr("请在 Chrome 或 Edge 扩展中连接存储。")}</p>}
      {!configuring && <MessageDialog message={error || (status.phase === 'error' ? status.message : '')} onClose={() => { setError(''); }} />}
      {status.lastSync > 0 && <p className="hint">{tr("最近同步：")}{new Date(status.lastSync).toLocaleString(getLocale())}</p>}
      {saved?.profile && !configuring && <section className="cloud-tool-sync" aria-label={tr('同步状态')}>
        <strong>{tr('同步状态')}</strong>
        <div className="cloud-tool-sync-status" role="status"><span>{tr('待同步：{0} 项', [status.pending || 0])}</span><span>{tr('保留的冲突版本：{0}', [conflicts.length])}</span></div>
        {status.phase === 'syncing' && <p className="hint" role="status">{status.message || tr('正在同步…')}</p>}
      </section>}
      {conflicts.length > 0 && <div className="cloud-sync-conflicts"><strong>{tr("保留的冲突版本")}</strong>
        <p className="hint">{tr('发生冲突的内容暂时保留本机版本。比较后，选择保留本机版本或采用一个云端版本。')}</p>
        {presentation.active && <p className="hint">{tr('输入密码以查看隐藏内容。')}</p>}
        {conflicts.filter(item => !item.local).map((item, index) => <div key={item.id}>
          <span>{conflictRecordScope(item)} · {tr('云端版本 {0}', [index + 1])}{item.deleted ? tr("（删除版本）") : ''}</span>
          <Button variant="secondary" type="button" disabled={busy || !status.unlocked} onClick={() => {
            if (presentationActive.current) { presentation.requestUnlock(); return; }
            run(async () => {
              const epoch = conflictPreviewEpoch.current;
              const preview = await previewCloudSyncConflict(item.id);
              if (!presentationActive.current && epoch === conflictPreviewEpoch.current) setConflictChoice({ ...preview, choice: null });
            });
          }}>{presentation.active ? tr('输入密码查看隐藏内容') : tr('查看并选择版本')}</Button>
        </div>)}
      </div>}
      {conflictChoice && !presentation.active && <PromptDialog title={tr('选择保留的版本')} action={conflictChoice.choice === 'remote' ? tr('采用云端版本') : tr('保留本机版本')} busy={busy} confirmDisabled={!conflictChoice.choice} onCancel={() => setConflictChoice(null)}
        onConfirm={() => { if (!presentationActive.current) run(async () => { await restoreCloudSyncConflict(conflictChoice.id, { choice: conflictChoice.choice, token: conflictChoice.token }); setConflictChoice(null); setConflicts(await getCloudSyncConflicts()); }); }}>
        <p className="cloud-conflict-impact">{conflictRecordImpact(conflictChoice)}</p>
        {(conflictChoice.local.deleted || conflictChoice.remote.deleted) && <p className="cloud-conflict-delete">{tr('选择已删除的版本，会删除本机对应的整组内容。')}</p>}
        <div className="cloud-conflict-sides" role="group" aria-label={tr('选择保留的版本')}>
          {['local', 'remote'].map(side => {
            const summary = conflictRecordSummary(conflictChoice, conflictChoice[side]);
            return <section key={side}>
            <strong>{side === 'local' ? tr('本机版本') : tr('云端版本')}</strong>
            <span className="cloud-conflict-scope">{tr('影响范围：{0}', [summary.scope])}</span>
            <ul className="cloud-conflict-summary">{summary.lines.map((line, index) => <li key={index}>{line}</li>)}</ul>
            {summary.partial && <p className="hint">{tr('摘要只显示部分内容；选择时会采用此版本的完整内容。')}</p>}
            {!conflictChoice[side].deleted && <Disclosure className="context-help cloud-conflict-details" title={tr('技术详情')}>
              <pre>{conflictRecordPreview(conflictChoice[side].value)}</pre>
            </Disclosure>}
            <Button type="button" variant="secondary" disabled={busy} aria-pressed={conflictChoice.choice === side} onClick={() => setConflictChoice(current => ({ ...current, choice: side }))}>
              {side === 'local' ? tr('保留本机版本') : tr('采用云端版本')}
            </Button>
          </section>; })}
        </div>
      </PromptDialog>}
      {saved?.profile && !configuring && <Disclosure className="context-help" title={tr('旧版导航历史')}>
        <p className="hint">{tr('这里保留升级前的导航历史。其他设备请更新 Covelet 后继续同步。')}</p>
        <CloudHistory disabled={busy || demo || !available} unlocked={status.unlocked} onBusyChange={(value) => { setBusy(value); onBusyChange(value); }} />
      </Disclosure>}
    </div>
    {configuring && error && <p className="form-error cloud-setup-error" role="alert">{error}</p>}
    <div className="settings-footer cloud-sync-actions">
      <Button variant="ghost" type="button" className="button quiet" disabled={busy || !loaded} onClick={localOnly}>{tr('仅在本机使用')}</Button>
      {(step === 2 || !configuring && saved?.profile) && <Button variant="secondary" type="button" className="button" disabled={busy || demo || !available} onClick={testConnection}>{testing ? tr('正在测试连接…') : tr('测试连接')}</Button>}
      {configuring ? <>
        {step > 1 && <Button variant="secondary" type="button" className="button" disabled={busy} onClick={() => { setStep(step - 1); setError(''); }}>{tr('上一步')}</Button>}
        {saved?.profile && <Button variant="secondary" type="button" className="button" disabled={busy} onClick={() => { setDraft({ ...blank, ...saved.profile }); setAutoSync(saved.autoSync); setSecrets(emptySecrets); setPassword(''); setStep(null); setDraftTest(null); setError(''); }}>{tr("取消修改")}</Button>}
        {step === 3 && <Button variant="secondary" type="button" className="button" disabled={busy || demo || !available} onClick={() => saveConnection(false)}>{tr('保存配置')}</Button>}
        <Button variant="default" type="submit" className="button primary" disabled={busy || demo || !available || step === 2 && (!draftTest || testFailed)}>{busy && !testing ? tr('正在同步…') : step === 3 ? tr('保存并首次同步') : tr('下一步')}</Button>
      </> : saved?.profile ? <>
        {status.unlocked ? <>
          <Button variant="ghost" type="button" className="button quiet" disabled={busy} onClick={() => run(lockCloudSync)}><LockKey size={16} />{tr("锁定")}</Button>
          <Button variant="default" type="button" className="button primary" disabled={busy || demo || !available || !connectionMatches} onClick={() => run(async () => { await syncCloudNow(); setConflicts(await getCloudSyncConflicts()); })}><ArrowsClockwise size={16} />{busy ? tr("正在同步…") : tr("立即同步")}</Button>
        </> : <Button variant="default" type="submit" className="button primary" disabled={busy || demo || !available || !connectionMatches}>{busy ? tr("正在解锁…") : tr("解锁")}</Button>}
      </> : null}
    </div>
  </form>;
}

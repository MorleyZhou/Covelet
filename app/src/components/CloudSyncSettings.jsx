import { tr, getLocale } from "../i18n/index.js";
import { useContext, useEffect, useRef, useState } from 'react';
import { PresentationContext } from '../lib/presentation.js';
import { LockKey, ArrowsClockwise, CheckCircle, WarningCircle } from '@phosphor-icons/react';
import { Disclosure } from './ui/disclosure.jsx';
import CloudHistory from './CloudHistory.jsx';
import { requestBackgroundCloudSync } from '../lib/cloud-sync-background.js';
import { validateCloudConfig, cloudOrigin } from '../lib/cloud-providers.js';
import { cloudProviderLabel, SYNC_PROVIDERS, finishCloudSetup, requireCloudSyncSuccess } from '../lib/cloud-connection.js';
import { validateCloudPassword } from '../lib/cloud-crypto.js';
import { userErrorMessage } from '../lib/user-error.js';
import { requestSiteAccess } from '../lib/site-info.js';
import {
  loadCloudSyncSettings, testCloudConnection, saveCloudSyncSettings, unlockCloudSync, lockCloudSync, useLocalOnlyCloudSync,
  supportsCloudSync, getCloudSyncStatus, subscribeCloudSyncStatus, acceptBackgroundCloudSyncStatus, getCloudSyncRuns,
} from '../lib/cloud-sync.js';
import './cloud-sync.css';
import { Button } from './ui/button.jsx';
import { Input } from './ui/input.jsx';
import { Switch } from './ui/switch.jsx';

const blank = { provider: 'webdav', endpoint: '', bucket: '', region: 'cn-hangzhou', owner: '', repo: '', project: '', branch: 'main', prefix: 'covelet' };
const emptySecrets = { accessKeyId: '', secretAccessKey: '', sessionToken: '', token: '', username: '', appPassword: '' };
const editableErrors = new Set(['CLOUD_INVALID_CONFIG', 'CLOUD_AUTH', 'CLOUD_FORBIDDEN', 'CLOUD_NOT_FOUND', 'CLOUD_DECRYPT', 'CLOUD_OSS_VERSIONING_CHECK']);
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

function syncComplete(lastSync) {
  return lastSync ? tr('同步完成 · {0}', [new Date(lastSync).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' })]) : tr('同步完成。');
}

function cleanupMessage(outcome) {
  if (outcome === 'files-cleaned') return tr('已清理云端旧同步文件。');
  if (outcome === 'indexes-cleaned') return tr('旧同步索引已清理。历史数据块仍保留。');
  if (outcome === 'unsupported') return tr('当前存储服务暂不支持安全清理旧版本。');
  if (outcome === 'retained') return tr('未能确认旧索引已清理。');
  if (outcome === 'deferred') return tr('旧版本等待验证后清理。');
  return undefined;
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

export default function CloudSyncSettings({ demo = false, onBusyChange = () => {}, introduction, onLocalOnly = () => {}, onNotice = () => {}, toastVisible = false }) {
  const presentation = useContext(PresentationContext);
  const presentationActive = useRef(presentation.active);
  presentationActive.current = presentation.active;
  const [draft, setDraft] = useState(blank), [secrets, setSecrets] = useState(emptySecrets);
  const [password, setPassword] = useState(''), [autoSync, setAutoSync] = useState(false);
  const [saved, setSaved] = useState(null), [status, setStatus] = useState(() => getCloudSyncStatus());
  const [operationBusy, setBusy] = useState(false), [feedback, setFeedback] = useState(null);
  const busy = operationBusy || status.phase === 'syncing';
  const [draftTest, setDraftTest] = useState(null);
  const [connectionTestFailed, setConnectionTestFailed] = useState(false);
  const [runs, setRuns] = useState([]);
  const [step, setStep] = useState(demo ? 1 : null), [loaded, setLoaded] = useState(demo);
  const wasUnlocked = useRef(status.unlocked);
  const previousPhase = useRef(status.phase);
  const observedSync = useRef(status.phase === 'syncing');
  const fieldsRef = useRef(null);
  const recoveryFocus = useRef(null);
  useEffect(() => {
    if (fieldsRef.current) fieldsRef.current.scrollTop = 0;
    if (step === 2 && recoveryFocus.current) fieldsRef.current?.querySelector(recoveryFocus.current)?.focus();
    recoveryFocus.current = null;
  }, [step]);
  const available = supportsCloudSync();
  const isGitStorage = draft.provider === 'github' || draft.provider === 'gitlab';
  let currentProfile = null;
  try { currentProfile = profileOf(draft); } catch { /* Incomplete connection draft. */ }
  const connectionMatches = Boolean(saved?.profile) && JSON.stringify(currentProfile) === JSON.stringify(saved.profile);
  useEffect(() => {
    if (demo) return;
    let active = true;
    let refreshId = 0;
    function refreshSyncResults() {
      const id = ++refreshId;
      getCloudSyncRuns().then(items => { if (active && id === refreshId) setRuns(items); }).catch(() => {});
    }
    loadCloudSyncSettings().then((value) => {
      if (!active) return;
      setSaved(value);
      setStep(value.profile ? null : 1); setLoaded(true);
      if (value.profile) setDraft({ ...blank, ...value.profile });
      setAutoSync(value.autoSync);
      refreshSyncResults();
    }).catch(() => { if (active) { setFeedback({ tone: 'error', message: tr('暂时无法读取同步连接设置。') }); setLoaded(true); } });
    const off = subscribeCloudSyncStatus((value) => {
      if (active) {
        if (value.phase === 'syncing' && previousPhase.current !== 'syncing') {
          observedSync.current = true;
          setFeedback(null);
        }
        previousPhase.current = value.phase;
        setStatus(value);
        if (wasUnlocked.current && !value.unlocked) { setDraftTest(null); setConnectionTestFailed(false); }
        wasUnlocked.current = value.unlocked;
        refreshSyncResults();
      }
    });
    return () => { active = false; off(); };
  }, [demo]);
  function resetTest() { setDraftTest(null); setFeedback(null); }
  function patch(value) { resetTest(); setDraft((current) => ({ ...current, ...value })); }
  function showFailure(reason, operation) {
    const message = userErrorMessage(reason, tr('同步操作未完成，本机数据已保留。'));
    setFeedback({ tone: 'error', message, operation, code: reason?.code });
    if (operation) onNotice({ kind: 'error', text: operation === 'test' ? tr('测试失败') : tr('同步失败'), detail: message });
  }
  async function run(action, { progress, operation } = {}) {
    const blocksPage = operation !== 'sync';
    setBusy(true);
    if (blocksPage) onBusyChange(true);
    onNotice(null);
    observedSync.current = false;
    setFeedback(progress ? { tone: 'progress', message: progress } : null);
    try {
      const message = await action();
      const current = getCloudSyncStatus();
      const conflict = operation === 'sync' && current.phase === 'conflict';
      setFeedback(message ? { tone: conflict ? 'info' : 'success', message } : null);
      setStatus(current);
      if (operation === 'test') onNotice({ kind: 'success', text: tr('测试通过'), detail: message });
      if (operation === 'sync' && !conflict) onNotice({ kind: 'success', text: tr('同步成功'), detail: cleanupMessage(current.cleanup) });
    } catch (reason) {
      if (operation === 'test' && !configuring) setConnectionTestFailed(true);
      showFailure(reason, operation);
    }
    finally { setBusy(false); if (blocksPage) onBusyChange(false); }
  }
  async function backgroundSync(choice) {
    const result = await requestBackgroundCloudSync(choice);
    acceptBackgroundCloudSyncStatus(result);
    return result;
  }
  function syncMessage(result) {
    if (result?.phase === 'conflict') return tr('有冲突待处理');
    requireCloudSyncSuccess(result);
    return syncComplete(result.lastSync);
  }
  function saveConnection(firstSync = false) {
    if (busy || demo) return;
    let profile;
    try {
      profile = profileOf(draft);
      validateCloudPassword(password);
    } catch (reason) { showFailure(reason, firstSync ? 'sync' : undefined); return; }
    // Request the concrete origin directly in the user's click, before any await.
    const access = available ? requestSiteAccess(cloudOrigin(profile)) : Promise.resolve(true);
    run(async () => {
      if (!await access) throw new Error(tr("未获得此存储地址的访问权限，连接未保存。"));
      const value = await finishCloudSetup({ profile, secrets, password, autoSync, firstSync, onSaved(savedConnection) {
        setSaved(savedConnection); setDraft({ ...blank, ...savedConnection.profile });
        setSecrets(emptySecrets); setPassword(''); setDraftTest(null); setConnectionTestFailed(false); setStep(null);
      } }, { saveCloudSyncSettings, syncCloudNow: backgroundSync });
      setSaved(value);
      return firstSync ? syncMessage(getCloudSyncStatus()) : connectionMatches ? tr('配置已更新') : tr('配置已保存，尚未同步');
    }, firstSync ? { progress: tr('正在同步…'), operation: 'sync' } : undefined);
  }
  function testConnection() {
    if (busy || demo) return;
    let profile;
    try { profile = profileOf(draft); } catch (reason) { showFailure(reason, 'test'); return; }
    const access = requestSiteAccess(cloudOrigin(profile));
    setDraftTest(null);
    if (!configuring) {
      setConnectionTestFailed(false);
      setSaved(current => ({ ...current, connectionTest: null }));
    }
    run(async () => {
      if (!await access) throw new Error(tr('尚未授权访问这个云服务，请先在设置中授权。'));
      const result = configuring || !status.unlocked ? await testCloudConnection(profile, secrets) : await testCloudConnection();
      if (configuring || !status.unlocked) setDraftTest(result);
      else setSaved(current => ({ ...current, connectionTest: result }));
      if (draft.provider === 'webdav') return tr('连接通过，可读取目录');
      return isGitStorage ? tr('连接通过，可访问仓库') : tr('连接通过，可访问存储桶');
    }, { progress: tr('正在测试连接…'), operation: 'test' });
  }
  function syncNow() {
    if (busy || !connectionMatches) return;
    run(async () => syncMessage(await backgroundSync()), { progress: tr('正在同步…'), operation: 'sync' });
  }
  function editConnection(fromError = false, code) {
    resetTest();
    onNotice(null);
    const selector = code === 'CLOUD_AUTH' ? 'input[type=password]' : 'input';
    if (step === 2) fieldsRef.current?.querySelector(selector)?.focus();
    else {
      if (fromError) recoveryFocus.current = selector;
      setStep(fromError ? 2 : 1);
    }
  }
  function credentialField(label, key, type = 'password', optional = false) {
    return <label>{label}{optional ? tr("（可选）") : ''}<Input type={type} value={secrets[key]} autoComplete="off" spellCheck={false}
      maxLength={key === 'sessionToken' ? 8192 : 2048} onChange={(event) => { resetTest(); setSecrets((current) => ({ ...current, [key]: event.target.value })); }} disabled={busy || demo} /></label>;
  }
  const configuring = step !== null;
  const passwordOnlyUnlock = !configuring && !status.unlocked && saved?.credentialsStored;
  const hasConflicts = status.phase === 'conflict' || status.conflicts > 0;
  const conflictRun = hasConflicts ? runs.find(run => run.outcome === 'conflict' || run.newConflictCount > 0) : null;
  function resolveConflicts(choice) {
    if (busy || !status.unlocked || !connectionMatches || !hasConflicts || presentationActive.current) return;
    run(async () => syncMessage(await backgroundSync(choice)), { progress: tr('正在同步…'), operation: 'sync' });
  }
  const conflictChoice = <div className="cloud-sync-choice" role="group" aria-label={tr('选择同步版本')}>
    {presentation.active ? <Button variant="secondary" type="button" disabled={busy} onClick={presentation.requestUnlock}>{tr('解锁隐藏内容')}</Button>
      : !status.unlocked ? <p className="hint">{tr('输入同步密码后，可选择要保留的版本。')}</p> : <>
        <p className="hint">{draft.provider === 'github'
          ? tr('以本地为准会替换 GitHub 上的同步数据。其他设备需更新 Covelet 后才能继续同步。')
          : tr('选择保留整份本机或云端数据。另一端的同步内容会被替换。')}</p>
        <div>
          <Button variant="secondary" type="button" disabled={busy || !connectionMatches} onClick={() => resolveConflicts('local')}>{tr('以本地为准')}</Button>
          <Button variant="secondary" type="button" disabled={busy || !connectionMatches} onClick={() => resolveConflicts('remote')}>{tr('以云端为准')}</Button>
        </div>
      </>}
  </div>;
  function localOnly() {
    if (busy) return;
    run(async () => {
      if (!demo) setSaved(await useLocalOnlyCloudSync());
      setSecrets(emptySecrets); setPassword(''); setDraftTest(null); setAutoSync(false);
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
    run(async () => {
      setSaved(await unlockCloudSync(passwordOnlyUnlock ? undefined : secrets, password));
      setDraftTest(null); setSecrets(emptySecrets); setPassword('');
    }, { progress: tr('正在解锁…') });
  }
  const connectionTest = configuring || !status.unlocked ? draftTest : saved?.connectionTest;
  let visibleFeedback = feedback;
  if (!configuring && status.unlocked) {
    if (status.phase === 'syncing') visibleFeedback = { tone: 'progress', message: tr('正在同步…') };
    else if (!feedback && status.phase === 'conflict') visibleFeedback = { tone: 'info', message: tr('有冲突待处理') };
    else if (!feedback && status.phase === 'error') visibleFeedback = { tone: 'error', message: status.message, operation: 'sync', code: status.code };
    else if (!feedback && observedSync.current && status.phase === 'saved') visibleFeedback = { tone: 'success', message: syncComplete(status.lastSync) };
  }
  const failedOperation = visibleFeedback?.operation;
  const editAfterError = editableErrors.has(visibleFeedback?.code);
  function recoveryLabel(operation, label) {
    return failedOperation === operation ? editAfterError ? tr('修改配置') : tr('重试') : label;
  }
  return <form className="cloud-sync-form form-stack" onSubmit={(event) => {
    event.preventDefault();
    if (event.nativeEvent?.isComposing || busy || !loaded) return;
    if (configuring) {
      if (step === 1) setStep(2);
      else if (step === 2 && draftTest) { setStep(3); setFeedback(null); }
      else if (step === 3) saveConnection(true);
    } else if (!status.unlocked) unlock();
  }}>
    <div ref={fieldsRef} className="settings-scroll cloud-sync-fields">
      {introduction}
      {!loaded && <p className="hint" role="status">{tr('正在读取同步设置…')}</p>}
      {configuring && <ol className="cloud-setup-steps" aria-label={tr('同步设置步骤')}>
        {[tr('选择存储'), tr('测试连接'), tr('设置同步密码')].map((label, index) => <li key={index} aria-current={step === index + 1 ? 'step' : undefined}>
          <span aria-hidden="true">{index + 1}</span>{label}
        </li>)}
      </ol>}
      {step === 3 && currentProfile && <p className="cloud-sync-target">{cloudProviderLabel(currentProfile.provider)} · {targetLabel(currentProfile)}</p>}
      {saved?.profile && !configuring && <section className="cloud-settings-group" aria-labelledby="cloud-connection-heading">
        <h3 id="cloud-connection-heading">{tr('连接')}</h3>
        <div className="cloud-settings-row">
          <div><strong>{cloudProviderLabel(saved.profile.provider)}</strong><p className="cloud-sync-target">{targetLabel(saved.profile)}</p></div>
          {!(failedOperation && editAfterError) && <Button variant="ghost" type="button" className="button quiet" disabled={busy} onClick={() => editConnection()}>{tr('修改配置')}</Button>}
        </div>
        <p className="connection-state">{status.unlocked ? tr('已解锁') : tr('同步已锁定')}</p>
        <div className="cloud-settings-row">
          <span>{draft.provider === 'webdav' ? tr('目录读取') : isGitStorage ? tr('仓库访问') : tr('存储桶访问')}</span>
          <span className="cloud-settings-value">{connectionTest ? tr('已通过') : connectionTestFailed ? tr('未通过') : tr('待测试')}</span>
        </div>
        {!status.unlocked && !passwordOnlyUnlock && <p className="hint">{tr('请补填一次访问凭据。同步成功后，只需用同步密码解锁。')}</p>}
      </section>}
      {step === 1 && <div className="cloud-channel-options" role="group" aria-label={tr('选择存储')}>
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
        <label>{tr('服务器地址')}<Input type="text" inputMode="url" value={draft.endpoint} placeholder="https://dav.jianguoyun.com/dav/" maxLength={1000} autoComplete="off" spellCheck={false} disabled={busy || demo} onChange={(e) => patch({ endpoint: e.target.value })} /></label>
      </> : <>
        <label>{draft.provider === 'r2' ? tr("账户 API 地址") : tr("Bucket 访问域名")}<Input type="text" inputMode="url" value={draft.endpoint} autoComplete="off" spellCheck={false} maxLength={600}
          placeholder={draft.provider === 'r2' ? tr("https://<账户ID>.r2.cloudflarestorage.com") : 'https://<bucket>.oss-cn-hangzhou.aliyuncs.com'} disabled={busy || demo} onChange={(e) => patch({ endpoint: e.target.value })} /></label>
        <label>{tr("Bucket 名称")}<Input value={draft.bucket} maxLength={63} spellCheck={false} disabled={busy || demo} onChange={(e) => patch({ bucket: e.target.value })} /></label>
        {draft.provider === 'oss' && <label>{tr("地域")}<Input value={draft.region} maxLength={80} spellCheck={false} disabled={busy || demo} onChange={(e) => patch({ region: e.target.value })} /></label>}
      </>}
      <label>{tr('保存目录')}<Input value={draft.prefix} maxLength={300} spellCheck={false} aria-describedby={draft.provider === 'webdav' ? 'cloud-directory-help' : undefined} disabled={busy || demo} onChange={(e) => patch({ prefix: e.target.value })} /></label>
      {draft.provider === 'webdav' && <p className="hint" id="cloud-directory-help">{tr('请先在服务器上创建此目录。')}</p>}
      </>}
      {(step === 2 || !configuring && saved?.profile && !status.unlocked && !passwordOnlyUnlock) && <>
      {isGitStorage ? credentialField(tr("{0} 访问令牌", [draft.provider === 'github' ? 'GitHub' : 'GitLab']), 'token') : draft.provider === 'webdav' ? <>
        {credentialField(tr('用户名'), 'username', 'text')}
        {credentialField(tr('应用密码'), 'appPassword')}
      </> : <>
        {credentialField('Access Key ID', 'accessKeyId', 'text')}
        {credentialField('Secret Access Key', 'secretAccessKey')}
        <Disclosure className="context-help" title={tr('临时安全令牌')}>{credentialField(tr("临时安全令牌"), 'sessionToken', 'password', true)}</Disclosure>
      </>}
      </>}
      {(step === 3 || !configuring && saved?.profile && !status.unlocked) && <>
      <label>{tr('同步密码')}<Input type="password" value={password} maxLength={1024} autoComplete={configuring ? 'new-password' : 'current-password'} aria-describedby={configuring ? 'cloud-password-help' : undefined} disabled={busy || demo} onChange={(e) => { setPassword(e.target.value); setFeedback(null); }} /></label>
      {configuring && <p className="hint" id="cloud-password-help">{tr('至少 12 个字符。其他设备使用同一密码。密码无法找回。')}</p>}
      </>}
      {step === 3 && <>
      <label className="check-label"><Switch checked={autoSync} disabled={busy || demo} onCheckedChange={(nextChecked) => setAutoSync(nextChecked)} />{tr('首次同步成功后自动同步')}</label>
      </>}
      {step === 2 && <Disclosure className="context-help" title={tr("连接要求")}>
      <p className="hint">{tr('测试检查所选存储的读取权限。')}</p>
      {draft.provider === 'r2' && <p className="hint">{tr("创建专用 Bucket，并使用仅限该 Bucket 对象读写的 API 凭据。")}</p>}
      {draft.provider === 'github' && <p className="hint">{tr("建议使用私有仓库及仅限该仓库 Contents 读写的令牌；同步会生成仓库提交。")}</p>}
      {draft.provider === 'gitlab' && <p className="hint">{tr("先创建私有项目和分支，使用具备 API 写权限的专用令牌；同步会生成仓库提交。")}</p>}
      {draft.provider === 'webdav' && <p className="hint">{tr('使用 HTTPS 地址和应用密码。')}</p>}
      {draft.provider === 'oss' && <p className="hint">{tr("使用从未开启版本控制的专用 Bucket；凭据需具备对象读写、列举及读取 Bucket 版本状态的权限。")}</p>}
      </Disclosure>}
      {demo ? <p className="hint" role="status">{tr("演示模式无法连接存储。")}</p> : !available && <p className="hint" role="status">{tr("请在 Chrome 或 Edge 扩展中连接存储。")}</p>}
      {saved?.profile && !configuring && <section className="cloud-settings-group" aria-labelledby="cloud-sync-heading">
        <h3 id="cloud-sync-heading">{tr('同步')}</h3>
        {(status.lastSync > 0 || status.pending > 0) && <div className="cloud-tool-sync-status">
          {status.lastSync > 0 && <span>{tr('上次成功 · {0}', [new Date(status.lastSync).toLocaleString(getLocale())])}</span>}
          {status.pending > 0 && <span>{tr('待同步：{0} 项', [status.pending])}</span>}
        </div>}
        {saved.autoSync && <p className="hint">{tr('自动同步已开启。')}</p>}
        {(runs.length > 0 || hasConflicts) && <Disclosure className="context-help cloud-sync-run-history" title={tr('同步记录')} defaultOpen>
          <ul className="cloud-sync-runs">
            {hasConflicts && !conflictRun && <li><strong>{tr('有冲突待处理')}</strong>{conflictChoice}</li>}
            {runs.map(run => <li key={run.id} data-sync-run-id={run.id}>
              <time dateTime={new Date(run.startedAt).toISOString()}>{new Date(run.startedAt).toLocaleString(getLocale())}</time>
              <strong>{run.outcome === 'conflict' || run.newConflictCount > 0 ? tr('有冲突') : run.outcome === 'success' ? tr('同步成功') : tr('同步失败')}</strong>
              {conflictRun?.id === run.id && conflictChoice}
            </li>)}
          </ul>
        </Disclosure>}
      </section>}
      {(step === 3 || saved?.profile && !configuring) && <Disclosure className="context-help" title={tr('同步内容与隐私')}>
        <p className="hint">{tr('导航、设置、便笺和图片等数据用同步密码加密后，上传到所选存储。')}</p>
        <p className="hint">{tr('访问凭据加密保存在本机。隐藏密码和隐藏状态也留在本机。')}</p>
        <p className="hint">{tr('同步在浏览器后台运行。重启浏览器后，解锁即可继续。')}</p>
      </Disclosure>}
      {saved?.profile && !configuring && <Disclosure className="context-help" title={tr('旧版导航历史')}>
        <p className="hint">{tr('这里保留升级前的导航历史。其他设备请更新 Covelet 后继续同步。')}</p>
        <CloudHistory disabled={busy || demo || !available} unlocked={status.unlocked} onBusyChange={(value) => { setBusy(value); onBusyChange(value); }} />
      </Disclosure>}
    </div>
    <div className="cloud-action-feedback" role="status" aria-live={toastVisible && visibleFeedback?.tone !== 'progress' ? 'off' : 'polite'} aria-atomic="true" data-tone={visibleFeedback?.tone}>
      {visibleFeedback && <>
        {visibleFeedback.tone === 'success' ? <CheckCircle size={18} aria-hidden="true" /> : visibleFeedback.tone === 'progress' ? <ArrowsClockwise size={18} aria-hidden="true" /> : <WarningCircle size={18} aria-hidden="true" />}
        <span>{visibleFeedback.message}</span>
      </>}
    </div>
    <div className="settings-footer cloud-sync-actions">
      <Button variant="ghost" type="button" className="button quiet" disabled={busy || !loaded} onClick={localOnly}>{tr('仅在本机使用')}</Button>
      {(step === 2 || !configuring && saved?.profile && !passwordOnlyUnlock) && <Button variant="secondary" type="button" className="button" disabled={busy || demo || !available} onClick={failedOperation === 'test' && editAfterError ? () => editConnection(true, visibleFeedback.code) : testConnection}>{recoveryLabel('test', tr('测试连接'))}</Button>}
      {configuring ? <>
        {step > 1 && <Button variant="secondary" type="button" className="button" disabled={busy} onClick={() => { setStep(step - 1); setFeedback(null); }}>{tr('上一步')}</Button>}
        {saved?.profile && <Button variant="secondary" type="button" className="button" disabled={busy} onClick={() => { setDraft({ ...blank, ...saved.profile }); setAutoSync(saved.autoSync); setSecrets(emptySecrets); setPassword(''); setStep(null); resetTest(); }}>{tr('取消修改')}</Button>}
        {step === 3 && <Button variant="secondary" type="button" className="button" disabled={busy || demo || !available} onClick={() => saveConnection(false)}>{tr('仅保存')}</Button>}
        <Button variant="default" type="submit" className="button primary" disabled={busy || demo || !available || step === 2 && !draftTest}>{step === 3 ? tr('保存并同步') : tr('下一步')}</Button>
      </> : saved?.profile ? <>
        {status.unlocked ? <>
          <Button variant="ghost" type="button" className="button quiet" disabled={busy} onClick={() => run(async () => setSaved(await lockCloudSync()))}><LockKey size={16} />{tr("锁定")}</Button>
          <Button variant="default" type="button" className="button primary" disabled={busy || demo || !available || !connectionMatches || hasConflicts && status.phase !== 'error'} onClick={failedOperation === 'sync' && editAfterError ? () => editConnection(true, visibleFeedback.code) : syncNow}>{!(failedOperation === 'sync' && editAfterError) && <ArrowsClockwise size={16} aria-hidden="true" />}{recoveryLabel('sync', tr('立即同步'))}</Button>
        </> : <Button variant="default" type="submit" className="button primary" disabled={busy || demo || !available || !connectionMatches}>{tr('解锁')}</Button>}
      </> : null}
    </div>
  </form>;
}

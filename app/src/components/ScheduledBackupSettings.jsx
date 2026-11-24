import { useEffect, useRef, useState } from 'react';
import { tr, getLocale } from '../i18n/index.js';
import { scheduledBackups } from '../lib/scheduled-backup.js';
import { validateBackupPassword } from '../lib/password-backup.js';
import { userErrorMessage } from '../lib/user-error.js';
import { Button } from './ui/button.jsx';
import { Input } from './ui/input.jsx';
import './scheduled-backup-settings.css';

const pickNativeDirectory = options => globalThis.showDirectoryPicker(options);
const sendNativeMessage = message => {
  if (!globalThis.chrome?.runtime?.id || !globalThis.chrome.runtime.sendMessage)
    return Promise.reject(new Error(tr('无法连接备份后台，请重新打开 Covelet。')));
  return globalThis.chrome.runtime.sendMessage(message);
};
const subscribeNativeStatus = listener => {
  const runtime = globalThis.chrome?.runtime;
  if (!runtime?.id || !runtime.onMessage) return () => {};
  const receive = (message, sender) => {
    if (sender?.id !== runtime.id || sender.url && !sender.url.startsWith(runtime.getURL(''))
      || sender.origin && sender.origin !== `chrome-extension://${runtime.id}` || message?.type !== 'covelet:backup:status') return;
    if (typeof message.status?.enabled === 'boolean' && Array.isArray(message.status.files)) listener(message.status);
    else if (message.status?.phase === 'error' && typeof message.status.lastError?.message === 'string') listener({ phase: 'error', lastError: message.status.lastError });
  };
  runtime.onMessage.addListener(receive);
  return () => runtime.onMessage.removeListener(receive);
};
const time = value => Number.isFinite(value) && value > 0 ? new Date(value).toLocaleString(getLocale()) : tr('尚未备份');
const permissionError = () => new Error(tr('备份目录需要重新授权，请在设置中重新选择目录。'));

export default function ScheduledBackupSettings({ disabled = false, beforeOperation, onBusyChange,
  scheduler = scheduledBackups, pickDirectory = pickNativeDirectory, sendMessage = sendNativeMessage, subscribeStatus = subscribeNativeStatus } = {}) {
  const [settings, setSettings] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false), [directory, setDirectory] = useState(null), [permission, setPermission] = useState(null);
  const [frequency, setFrequency] = useState('daily'), [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState('');
  const active = useRef(true), working = useRef(false), readGeneration = useRef(0), callback = useRef(onBusyChange);
  callback.current = onBusyChange;
  const supported = pickDirectory !== pickNativeDirectory || typeof globalThis.showDirectoryPicker === 'function';
  const running = settings?.phase === 'running';
  async function refresh() {
    const generation = ++readGeneration.current;
    try {
      const next = await scheduler.getSettings();
      if (active.current && generation === readGeneration.current) setSettings(next);
    } catch (reason) { if (active.current && generation === readGeneration.current) setError(userErrorMessage(reason)); }
  }
  useEffect(() => {
    active.current = true; refresh();
    const unsubscribe = subscribeStatus(next => { readGeneration.current++; if (active.current) setSettings(previous => ({ ...previous, ...next })); });
    globalThis.addEventListener?.('focus', refresh);
    return () => { active.current = false; readGeneration.current++; unsubscribe(); globalThis.removeEventListener?.('focus', refresh); if (working.current) callback.current?.(false); };
  }, [scheduler, subscribeStatus]);
  function clearDraft() { setEditing(false); setDirectory(null); setPermission(null); setPassword(''); setConfirmation(''); }
  async function notify(type) {
    const result = await sendMessage({ type });
    if (!result?.ok) throw Object.assign(new Error(result?.error?.message || tr('无法连接备份后台，请重新打开 Covelet。')), { code: result?.error?.code });
    if (active.current && result.status) setSettings(result.status);
  }
  async function run(action, { background = false } = {}) {
    if (working.current || disabled) return;
    working.current = true; setBusy(true); setError('');
    if (!background) callback.current?.(true);
    try { await action(); }
    catch (reason) { if (active.current && reason?.name !== 'AbortError') setError(userErrorMessage(reason, tr('定时备份操作未完成，已有文件已保留。'))); }
    finally {
      working.current = false;
      if (active.current) { setBusy(false); await refresh(); }
      if (!background) callback.current?.(false);
    }
  }
  function chooseDirectory() {
    if (working.current || disabled || !supported) return;
    // The native picker must be opened directly by this click, before an await.
    let selection;
    try { selection = pickDirectory({ mode: 'readwrite', id: 'covelet-scheduled-backups' }); }
    catch (reason) { if (reason?.name !== 'AbortError') setError(userErrorMessage(reason)); return; }
    run(async () => {
      const selected = await selection;
      const grant = await selected.queryPermission({ mode: 'readwrite' });
      if (!active.current) return;
      setDirectory(selected); setPermission(grant);
      if (grant !== 'granted') throw permissionError();
    });
  }
  function authorizeDirectory() {
    if (working.current || disabled || !directory?.requestPermission) return;
    // Permission prompts are restricted to this explicit foreground action.
    let request;
    try { request = directory.requestPermission({ mode: 'readwrite' }); }
    catch (reason) { setError(userErrorMessage(reason)); return; }
    run(async () => { const grant = await request; if (active.current) setPermission(grant); if (grant !== 'granted') throw permissionError(); });
  }
  function save(event) {
    event.preventDefault();
    if (working.current || disabled || running) return;
    try {
      validateBackupPassword(password);
      if (password !== confirmation) throw new Error(tr('两次输入的密码不一致。'));
      if (!directory || permission !== 'granted') throw permissionError();
    } catch (reason) { setError(userErrorMessage(reason)); return; }
    const secret = password, selected = directory, interval = frequency;
    setPassword(''); setConfirmation('');
    run(async () => {
      await beforeOperation?.();
      const next = await scheduler.configure({ directory: selected, frequency: interval, password: secret });
      if (active.current) { setSettings(next); clearDraft(); }
      await notify('covelet:backup:refresh');
    });
  }
  function runNow() {
    if (running) return;
    run(async () => { await beforeOperation?.(); await notify('covelet:backup:run'); }, { background: true });
  }
  function disableSchedule() {
    if (running) return;
    run(async () => {
      const next = await scheduler.disable();
      if (active.current) { setSettings(next); clearDraft(); }
      await notify('covelet:backup:refresh');
    });
  }
  return <section className="scheduled-backup-settings" aria-labelledby="scheduled-backup-heading" aria-busy={busy || running}>
    <div className="scheduled-backup-heading"><h3 id="scheduled-backup-heading">{tr('定时备份')}</h3>
      {!editing && <Button type="button" variant="secondary" disabled={disabled || busy || running || !settings || !supported} onClick={() => { setError(''); setFrequency(settings.frequency || 'daily'); setEditing(true); }}>{settings?.enabled ? tr('修改备份计划') : tr('设置定时备份')}</Button>}</div>
    <p className="hint">{tr('包含隐藏内容，仅保存加密的 .covelet 文件，保留最近 3 份。')}</p>
    {!supported && <p className="hint" role="status">{tr('此浏览器不支持所选目录的自动备份。')}</p>}
    {!settings && !error && <p className="hint" role="status">{tr('正在读取备份计划…')}</p>}
    {settings?.enabled && <>
      <dl className="scheduled-backup-status">
        <div><dt>{tr('备份目录')}</dt><dd dir="auto">{settings.directoryName}</dd></div>
        <div><dt>{tr('备份频率')}</dt><dd>{settings.frequency === 'weekly' ? tr('每周') : tr('每天')}</dd></div>
        <div><dt>{tr('上次备份')}</dt><dd>{time(settings.lastSuccess)}</dd></div>
        <div><dt>{tr('下次备份')}</dt><dd>{time(settings.nextDue)}</dd></div>
      </dl>
      {!error && !settings.lastError && (settings.permission === 'denied' || settings.permission === 'prompt' || settings.permission === 'unavailable') && <p className="form-error" role="status">{tr('备份目录需要重新授权，请在设置中重新选择目录。')}</p>}
      {running && <p className="hint" role="status">{tr('正在备份…')}</p>}
      <div className="recovery-actions"><Button type="button" variant="secondary" disabled={disabled || busy || running} onClick={runNow}>{tr('立即备份')}</Button><Button type="button" variant="ghost" disabled={disabled || busy || running} onClick={disableSchedule}>{tr('停用定时备份')}</Button></div>
      <p className="hint">{tr('停用会移除本机保存的目录记录和加密密钥，已有备份文件仍保留。')}</p>
      {settings.files?.length > 0 && <details className="scheduled-backup-files"><summary>{tr('已保留 {0} 份备份', [settings.files.length])}</summary><ul>{settings.files.map(file => <li key={file.name}><span dir="auto">{file.name}</span><time>{time(file.createdAt)}</time></li>)}</ul></details>}
    </>}
    {editing && <form className="scheduled-backup-form" aria-label={tr('设置定时备份')} onSubmit={save}>
      <p className="hint">{tr('备份密码须为 8–256 个字符，与同步密码分开设置且不会保存。请记住密码；丢失后无法在其他设备恢复。')}</p>
      <p className="hint">{tr('本机保存不可导出的加密密钥，供浏览器后台定时备份使用。')}</p>
      <div className="scheduled-backup-directory"><Button type="button" variant="secondary" disabled={disabled || busy || running} onClick={chooseDirectory}>{directory ? tr('重新选择目录') : tr('选择备份目录')}</Button>{directory && <span dir="auto">{directory.name}</span>}
        {directory && permission !== 'granted' && <Button type="button" variant="secondary" disabled={disabled || busy} onClick={authorizeDirectory}>{tr('授权目录')}</Button>}</div>
      <label>{tr('备份频率')}<select value={frequency} aria-label={tr('备份频率')} disabled={disabled || busy || running} onChange={event => setFrequency(event.target.value)}><option value="daily">{tr('每天')}</option><option value="weekly">{tr('每周')}</option></select></label>
      <label>{tr('备份密码')}<Input type="password" autoComplete="new-password" minLength={8} maxLength={256} required disabled={disabled || busy || running} value={password} onChange={event => { setPassword(event.target.value); setError(''); }} /></label>
      <label>{tr('确认备份密码')}<Input type="password" autoComplete="new-password" minLength={8} maxLength={256} required disabled={disabled || busy || running} value={confirmation} onChange={event => { setConfirmation(event.target.value); setError(''); }} /></label>
      <div className="recovery-actions"><Button type="button" variant="ghost" disabled={busy} onClick={clearDraft}>{tr('取消')}</Button><Button type="submit" disabled={disabled || busy || running || !directory || permission !== 'granted' || password.length < 8 || password !== confirmation}>{tr('保存备份计划')}</Button></div>
    </form>}
    {!error && settings?.lastError && <p className="form-error" role="alert">{userErrorMessage(settings.lastError, tr('定时备份操作未完成，已有文件已保留。'))}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}

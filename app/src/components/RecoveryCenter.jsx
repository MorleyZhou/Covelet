import { useEffect, useRef, useState } from 'react';
import { tr } from '../i18n/index.js';
import { recoveryCenter } from '../lib/recovery-center.js';
import { isEncryptedBackup } from '../lib/password-backup.js';
import { userErrorMessage } from '../lib/user-error.js';
import { Button } from './ui/button.jsx';
import { Input } from './ui/input.jsx';
import './recovery-center.css';

const incomplete = point => point && ['applying', 'needs-recovery'].includes(point.status);

export function downloadRecoveryFile(blob, name) {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function RecoveryCenter({ beforeOperation, onBusyChange, onRestored, disabled = false }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [preview, setPreview] = useState(null), [point, setPoint] = useState(undefined);
  const [passwordFlow, setPasswordFlow] = useState(null), [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState(''), [phase, setPhase] = useState(null);
  const input = useRef(null), restoreButton = useRef(null), exportButton = useRef(null), passwordInput = useRef(null), cancelButton = useRef(null), working = useRef(false);
  const generation = useRef(0), operation = useRef(null), busyCallback = useRef(onBusyChange), returnFocus = useRef(null);
  busyCallback.current = onBusyChange;

  useEffect(() => {
    let active = true;
    recoveryCenter.getRecoveryPoint().then(value => { if (active) setPoint(value); }).catch(reason => {
      if (active) { setPoint(null); setError(userErrorMessage(reason)); }
    });
    return () => { active = false; };
  }, []);
  useEffect(() => { if (preview && !busy) cancelButton.current?.focus(); }, [preview, busy]);
  useEffect(() => { if (passwordFlow && !busy) passwordInput.current?.focus(); }, [passwordFlow, busy]);
  useEffect(() => { if (!busy && returnFocus.current) { returnFocus.current.focus(); returnFocus.current = null; } }, [busy, passwordFlow, preview]);
  useEffect(() => () => {
    generation.current += 1; operation.current?.controller?.abort(); operation.current = null;
    if (working.current) busyCallback.current?.(false);
    working.current = false;
  }, []);

  async function run(action, { cancelable = false, phase: nextPhase = null } = {}) {
    if (working.current || disabled) return;
    const token = ++generation.current, controller = cancelable ? new AbortController() : null;
    const current = () => generation.current === token && !controller?.signal.aborted;
    operation.current = { token, controller, cancelable };
    working.current = true; setBusy(true); setPhase(nextPhase); onBusyChange?.(true); setError(''); setMessage('');
    try { await beforeOperation?.(); if (current()) await action({ signal: controller?.signal, current }); }
    catch (reason) {
      if (!current() || reason?.name === 'AbortError') return;
      if (reason?.code === 'REVISION_CONFLICT') setError(tr('数据已更新，请重新选择备份文件。'));
      else if (reason?.code === 'RECOVERY_REQUIRED') setError(tr('上次恢复未完成。请先恢复本机保留的副本。'));
      else setError(userErrorMessage(reason));
    } finally {
      if (operation.current?.token === token) {
        operation.current = null; working.current = false; setBusy(false); setPhase(null); onBusyChange?.(false);
      }
    }
  }

  function clearPasswordFlow() { setPasswordFlow(null); setPassword(''); setConfirmation(''); }
  function cancelRead() {
    if (working.current && !operation.current?.cancelable) return;
    returnFocus.current = passwordFlow?.kind === 'export' ? exportButton.current : restoreButton.current;
    generation.current += 1; operation.current?.controller?.abort(); operation.current = null; working.current = false;
    setBusy(false); setPhase(null); onBusyChange?.(false); clearPasswordFlow(); setPreview(null); setError(''); setMessage('');
  }
  function openEncryptedExport() {
    if (working.current || disabled) return;
    setPreview(null); setPassword(''); setConfirmation(''); setError(''); setMessage(''); setPasswordFlow({ kind: 'export' });
  }
  function submitPassword(event) {
    event.preventDefault();
    if (!passwordFlow || working.current || password.length < 8 || password.length > 256 || passwordFlow.kind === 'export' && password !== confirmation) return;
    const secret = password, flow = passwordFlow;
    setPassword(''); setConfirmation('');
    run(async ({ signal, current }) => {
      if (flow.kind === 'export') {
        const blob = await recoveryCenter.exportEncryptedBackup(secret, { signal });
        if (!current()) return;
        clearPasswordFlow(); returnFocus.current = exportButton.current;
        downloadRecoveryFile(blob, 'Covelet-complete-backup.covelet');
      } else {
        const plan = await recoveryCenter.previewEncryptedBackup(flow.file, secret, { signal });
        if (!current()) return;
        clearPasswordFlow(); setPreview({ plan, name: flow.file.name });
      }
    }, { cancelable: true, phase: flow.kind === 'export' ? 'encrypt' : 'decrypt' });
  }

  function chooseBackup() {
    clearPasswordFlow(); setError(''); setMessage('');
    if (!incomplete(point)) { input.current?.click(); return; }
    setPreview(null);
    run(async ({ current }) => { const plan = await recoveryCenter.previewRecoveryPoint(point.id); if (current()) setPreview({ plan, name: tr('恢复前副本') }); });
  }

  function selectFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || working.current || disabled) return;
    setPreview(null); clearPasswordFlow();
    run(async ({ current }) => {
      const encrypted = await isEncryptedBackup(file);
      if (!current()) return;
      if (encrypted) { setPasswordFlow({ kind: 'import', file }); return; }
      const plan = await recoveryCenter.preview(file);
      if (current()) setPreview({ plan, name: file.name });
    }, { cancelable: true, phase: 'inspect' });
  }

  function confirmRestore() {
    if (!preview || working.current) return;
    run(async ({ current }) => {
      try {
        const result = await recoveryCenter.restore(preview.plan);
        if (current()) await onRestored?.(result.state);
      } finally {
        if (current()) setPreview(null);
        await recoveryCenter.getRecoveryPoint().then((value) => { if (current()) setPoint(value); }).catch(() => {});
      }
      if (current()) setMessage(tr('恢复完成。'));
    }, { phase: 'restore' });
  }

  return <div className="form-stack recovery-center" aria-busy={busy}>
    <p className="hint">{tr('普通备份文件未加密，请妥善保管。')}</p>
    <div className="recovery-actions">
      <Button variant="secondary" disabled={disabled || busy} onClick={() => { clearPasswordFlow(); run(async ({ current }) => { const blob = await recoveryCenter.exportCompleteBackup(); if (current()) downloadRecoveryFile(blob, 'Covelet-complete-backup.json'); }); }}>{tr('导出备份')}</Button>
      <Button ref={exportButton} variant="secondary" disabled={disabled || busy} onClick={openEncryptedExport}>{tr('加密导出')}</Button>
      <Button ref={restoreButton} variant="secondary" disabled={disabled || busy || point === undefined} onClick={chooseBackup}>{tr('恢复备份')}</Button>
      <input ref={input} type="file" accept=".covelet,.json,.zip,application/octet-stream,application/json,application/zip" hidden onChange={selectFile} />
    </div>
    {passwordFlow && <form className="form-stack recovery-password-panel" aria-label={passwordFlow.kind === 'export' ? tr('加密导出备份') : tr('解锁备份')} onSubmit={submitPassword}>
      <strong>{passwordFlow.kind === 'export' ? tr('加密导出备份') : tr('解锁备份')}</strong>
      {passwordFlow.kind === 'import' && <span className="recovery-filename" dir="auto">{passwordFlow.file.name}</span>}
      <p className="hint">{passwordFlow.kind === 'export' ? tr('密码须为 8–256 个字符，不会保存。丢失密码将无法恢复。') : tr('请输入导出时使用的密码。')}</p>
      <label>{tr('备份密码')}<Input ref={passwordInput} type="password" autoComplete="off" spellCheck={false} minLength={8} maxLength={256} required value={password} disabled={busy || disabled} onChange={(event) => setPassword(event.target.value)} /></label>
      {passwordFlow.kind === 'export' && <label>{tr('确认备份密码')}<Input type="password" autoComplete="off" spellCheck={false} minLength={8} maxLength={256} required value={confirmation} disabled={busy || disabled} onChange={(event) => setConfirmation(event.target.value)} /></label>}
      {!busy && passwordFlow.kind === 'export' && confirmation && password !== confirmation && <p className="form-error" role="alert">{tr('两次输入的密码不一致。')}</p>}
      {busy && <p role="status" className="hint">{phase === 'encrypt' ? tr('正在加密备份…') : tr('正在解锁备份…')}</p>}
      <div className="recovery-actions"><Button type="button" variant="ghost" onClick={cancelRead}>{tr('取消')}</Button>
        <Button type="submit" disabled={busy || disabled || password.length < 8 || password.length > 256 || passwordFlow.kind === 'export' && password !== confirmation}>{passwordFlow.kind === 'export' ? tr('加密并下载') : tr('解锁并预览')}</Button></div>
    </form>}
    {busy && phase === 'inspect' && <div className="recovery-actions"><span role="status">{tr('正在读取备份…')}</span><Button type="button" variant="ghost" onClick={cancelRead}>{tr('取消')}</Button></div>}
    {!preview && incomplete(point) && !error && <p className="hint">{tr('上次恢复未完成。请先恢复本机保留的副本。')}</p>}
    {preview && <section className="form-stack recovery-preview" aria-label={tr('恢复预览')}>
      <strong className="recovery-filename" dir="auto">{preview.name}</strong>
      <p>{tr('恢复会替换此备份包含的内容。')}</p>
      <p className="hint">{tr('恢复前会在当前浏览器保留一份副本。')}</p>
      <div className="recovery-actions">
        <Button ref={cancelButton} variant="ghost" disabled={busy} onClick={() => { setPreview(null); setError(''); restoreButton.current?.focus(); }}>{tr('取消')}</Button>
        <Button disabled={busy} onClick={confirmRestore}>{busy ? tr('正在恢复…') : tr('确认恢复')}</Button>
      </div>
    </section>}
    {message && <p role="status">{message}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}

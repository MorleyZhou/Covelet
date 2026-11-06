import { useEffect, useRef, useState } from 'react';
import { tr } from '../i18n/index.js';
import { recoveryCenter } from '../lib/recovery-center.js';
import { userErrorMessage } from '../lib/user-error.js';
import { Button } from './ui/button.jsx';
import './recovery-center.css';

const incomplete = point => point && ['applying', 'needs-recovery'].includes(point.status);

export function downloadRecoveryFile(blob, name) {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function RecoveryCenter({ beforeOperation, onBusyChange, onRestored, disabled = false }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [preview, setPreview] = useState(null), [point, setPoint] = useState(undefined);
  const input = useRef(null), restoreButton = useRef(null), cancelButton = useRef(null), working = useRef(false);

  useEffect(() => {
    let active = true;
    recoveryCenter.getRecoveryPoint().then(value => { if (active) setPoint(value); }).catch(reason => {
      if (active) { setPoint(null); setError(userErrorMessage(reason)); }
    });
    return () => { active = false; };
  }, []);
  useEffect(() => { if (preview && !busy) cancelButton.current?.focus(); }, [preview, busy]);

  async function run(action) {
    if (working.current || disabled) return;
    working.current = true; setBusy(true); onBusyChange?.(true); setError(''); setMessage('');
    try { await beforeOperation?.(); await action(); }
    catch (reason) {
      if (reason?.code === 'REVISION_CONFLICT') setError(tr('数据已更新，请重新选择备份文件。'));
      else if (reason?.code === 'RECOVERY_REQUIRED') setError(tr('上次恢复未完成。请先恢复本机保留的副本。'));
      else setError(userErrorMessage(reason));
    } finally { working.current = false; setBusy(false); onBusyChange?.(false); }
  }

  function chooseBackup() {
    if (!incomplete(point)) { input.current?.click(); return; }
    setPreview(null);
    run(async () => setPreview({ plan: await recoveryCenter.previewRecoveryPoint(point.id), name: tr('恢复前副本') }));
  }

  function selectFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || working.current || disabled) return;
    setPreview(null);
    run(async () => setPreview({ plan: await recoveryCenter.preview(file), name: file.name }));
  }

  function confirmRestore() {
    if (!preview || working.current) return;
    run(async () => {
      try {
        const result = await recoveryCenter.restore(preview.plan);
        await onRestored?.(result.state);
      } finally {
        setPreview(null);
        await recoveryCenter.getRecoveryPoint().then(setPoint).catch(() => {});
      }
      setMessage(tr('恢复完成。'));
    });
  }

  return <div className="form-stack recovery-center" aria-busy={busy}>
    <p className="hint">{tr('导出的备份文件未加密，请妥善保管。')}</p>
    <div className="recovery-actions">
      <Button variant="secondary" disabled={disabled || busy} onClick={() => run(async () => downloadRecoveryFile(await recoveryCenter.exportCompleteBackup(), 'Covelet-complete-backup.json'))}>{tr('导出备份')}</Button>
      <Button ref={restoreButton} variant="secondary" disabled={disabled || busy || point === undefined} onClick={chooseBackup}>{tr('恢复备份')}</Button>
      <input ref={input} type="file" accept=".json,.zip,application/json,application/zip" hidden onChange={selectFile} />
    </div>
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

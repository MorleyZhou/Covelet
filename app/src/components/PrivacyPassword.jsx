import { useEffect, useId, useRef, useState } from 'react';
import { LockSimple } from '@phosphor-icons/react';
import { tr } from '../i18n/index.js';
import { userErrorMessage } from '../lib/user-error.js';
import { changePrivacyPassword, getPrivacyLockStatus, setPresentationMode } from '../lib/content-preferences.js';
import { validateNewPrivacyPassword } from '../lib/privacy-lock.js';
import { Button } from './ui/button.jsx';
import { Input } from './ui/input.jsx';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog.jsx';
import { useFloatingContainer } from './DialogSurface.jsx';
import './ui/ui.css';
import './privacy-password.css';

export function PrivacyPasswordForm({ purpose = 'unlock', onDone, onCancel, disabled = false, Heading = 'h2', onBusyChange }) {
  const [mode, setMode] = useState(purpose), [ready, setReady] = useState(false);
  const [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState(''), [current, setCurrent] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submitting = useRef(false), firstInput = useRef(null), errorId = useId(), hintId = useId();
  useEffect(() => {
    let active = true;
    getPrivacyLockStatus().then(({ configured }) => {
      if (!active) return;
      setMode(!configured ? 'setup' : purpose === 'setup' ? 'unlock' : purpose); setReady(true);
    }).catch((reason) => { if (active) setError(userErrorMessage(reason)); });
    return () => { active = false; };
  }, [purpose]);
  useEffect(() => { if (ready && !busy && !disabled) firstInput.current?.focus({ preventScroll: true }); }, [ready, mode, busy, disabled]);
  const creating = mode !== 'unlock';
  const blocked = busy || disabled || !ready;
  const title = mode === 'setup' ? tr('设置隐藏密码') : mode === 'change' ? tr('修改隐藏密码') : tr('解锁隐藏内容');
  return <form className="form-stack privacy-password-form" aria-busy={busy || undefined} onSubmit={async (event) => {
    event.preventDefault(); event.stopPropagation();
    if (blocked || submitting.current) return;
    submitting.current = true; setBusy(true); onBusyChange?.(true); setError('');
    try {
      if (creating) {
        validateNewPrivacyPassword(password);
        if (confirmation !== password) throw Error(tr('两次输入的密码不一致。'));
      }
      if (mode === 'change') await changePrivacyPassword(current, password);
      else await setPresentationMode(mode === 'setup', { password, setup: mode === 'setup' });
      setPassword(''); setConfirmation(''); setCurrent('');
      // Older installations can already be hidden without a verifier. Setting
      // one upgrades that state without revealing anything before authentication.
      if (mode === 'setup' && purpose === 'unlock') setMode('unlock');
      else onDone?.();
    } catch (reason) {
      setError(userErrorMessage(reason, tr('无法切换隐藏状态，请重试。')));
      if (reason.code === 'PRIVACY_CONFIGURED') { setMode('unlock'); setPassword(''); setConfirmation(''); }
      if (reason.code === 'PRIVACY_PASSWORD') { if (mode === 'change') setCurrent(''); else setPassword(''); }
      firstInput.current?.focus({ preventScroll: true });
    } finally { submitting.current = false; setBusy(false); onBusyChange?.(false); }
  }}>
    <span className="privacy-password-emblem" aria-hidden="true"><LockSimple size={27} /></span>
    <Heading className="privacy-password-title">{title}</Heading>
    <p className="hint privacy-password-description" id={hintId}>{mode === 'setup'
      ? tr('首次开启隐藏需要设置密码。以后关闭隐藏时，均需输入此密码。')
      : mode === 'change' ? tr('输入当前密码，再设置新的隐藏密码。') : tr('输入密码以查看隐藏内容。')}</p>
    {mode === 'change' && <label>{tr('当前密码')}<Input ref={firstInput} type="password" autoComplete="current-password" required maxLength={256} disabled={blocked}
      value={current} onChange={(event) => setCurrent(event.target.value)} aria-invalid={Boolean(error) || undefined} aria-describedby={error ? errorId : hintId} /></label>}
    <label>{creating ? tr('新密码') : tr('隐藏密码')}<Input ref={mode === 'change' ? undefined : firstInput} type="password" autoComplete={creating ? 'new-password' : 'current-password'} required maxLength={256} minLength={creating ? 8 : undefined} disabled={blocked}
      value={password} onChange={(event) => setPassword(event.target.value)} aria-invalid={Boolean(error) || undefined} aria-describedby={error ? errorId : hintId} /></label>
    {creating && <><label>{tr('确认密码')}<Input type="password" autoComplete="new-password" required minLength={8} maxLength={256} disabled={blocked}
      value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
      <p className="hint privacy-password-note">{tr('隐藏密码只用于控制本机内容显示，不随备份或同步传输。请妥善保管，忘记后无法找回。')}</p></>}
    {error && <p id={errorId} className="form-error" role="alert">{error}</p>}
    <div className="privacy-password-actions">
      {onCancel && <Button variant="secondary" type="button" disabled={busy || disabled} onClick={onCancel}>{tr('取消')}</Button>}
      <Button type="submit" disabled={blocked}>{busy ? tr('处理中…') : mode === 'setup' ? tr('设置并隐藏') : mode === 'change' ? tr('保存密码') : tr('解锁')}</Button>
    </div>
  </form>;
}

export default function PrivacyPasswordDialog({ purpose, onClose }) {
  const container = useFloatingContainer(), [busy, setBusy] = useState(false);
  const opener = useRef(globalThis.document?.activeElement);
  return container && <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent container={container} className="privacy-password-dialog" aria-describedby={undefined}
      onOpenAutoFocus={(event) => event.preventDefault()}
      onCloseAutoFocus={(event) => { event.preventDefault(); if (opener.current?.isConnected && !opener.current.matches(':disabled')) opener.current.focus({ preventScroll: true }); }}
      onEscapeKeyDown={(event) => { event.stopPropagation(); if (busy) event.preventDefault(); }}
      onInteractOutside={(event) => { if (busy) event.preventDefault(); }}
      onKeyDown={(event) => event.stopPropagation()} onContextMenu={(event) => event.stopPropagation()}>
      <PrivacyPasswordForm purpose={purpose} Heading={DialogTitle} onDone={onClose} onCancel={onClose} onBusyChange={setBusy} />
    </DialogContent>
  </Dialog>;
}

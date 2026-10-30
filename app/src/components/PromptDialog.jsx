import { useEffect, useRef, useState } from 'react';
import { tr } from '../i18n/index.js';
import { useFloatingContainer } from './DialogSurface.jsx';
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogCancel } from './ui/alert-dialog.jsx';
import { Button } from './ui/button.jsx';
import './prompt-dialog.css';

const stop = (event) => event.stopPropagation();

export default function PromptDialog({ children, title = tr('确认操作'), action, onConfirm, onCancel, busy = false, confirmDisabled = false, destructive = false, privacySafe = false }) {
  const surface = useFloatingContainer(), cancel = useRef(null);
  const container = privacySafe && surface?.closest('[inert]') ? surface.closest('dialog,[data-ui-modal]') || surface : surface;
  const opener = useRef(globalThis.document?.activeElement);
  const dismiss = () => { if (!busy) onCancel(); };
  return container && <AlertDialog open onOpenChange={(open) => { if (!open) dismiss(); }}>
    <AlertDialogContent container={container} className="prompt-dialog" aria-busy={busy || undefined}
      onOpenAutoFocus={(event) => { event.preventDefault(); cancel.current?.focus({ preventScroll: true }); }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        if (container.isConnected && opener.current?.isConnected && !opener.current.matches(':disabled')) opener.current.focus({ preventScroll: true });
      }}
      onEscapeKeyDown={(event) => { event.stopPropagation(); if (busy) event.preventDefault(); }}
      onContextMenu={stop} onKeyDown={stop}>
      <AlertDialogTitle>{title}</AlertDialogTitle>
      <AlertDialogDescription asChild><div className="prompt-dialog-message">{children}</div></AlertDialogDescription>
      <div className="prompt-dialog-actions">
        <AlertDialogCancel asChild><Button ref={cancel} type="button" variant={onConfirm ? 'ghost' : 'default'} disabled={busy}>{onConfirm ? tr('取消') : tr('关闭')}</Button></AlertDialogCancel>
        {onConfirm && <Button type="button" variant={destructive ? 'destructive' : 'default'} disabled={busy || confirmDisabled} onClick={onConfirm}>{action}</Button>}
      </div>
    </AlertDialogContent>
  </AlertDialog>;
}

// A persistent error can be dismissed until a new attempt produces a new message.
export function MessageDialog({ message, title = tr('提示'), onClose }) {
  const [dismissed, setDismissed] = useState(null);
  useEffect(() => { if (!message) setDismissed(null); }, [message]);
  if (!message || dismissed === message) return null;
  return <PromptDialog title={title} onCancel={() => { setDismissed(message); onClose?.(); }}><p>{tr(message)}</p></PromptDialog>;
}

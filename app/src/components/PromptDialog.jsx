import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { tr } from '../i18n/index.js';
import { useDialogSurface } from './DialogSurface.jsx';
import './prompt-dialog.css';

const stop = (event) => event.stopPropagation();

// Use another native top-layer dialog so a confirmation never changes its
// owner's layout or escapes the owner's theme/keyboard event boundary.
export default function PromptDialog({ children, title = tr('确认操作'), action, onConfirm, onCancel, busy = false, confirmDisabled = false, destructive = false }) {
  const surface = useDialogSurface();
  const container = surface === null ? null : surface || globalThis.document?.body;
  const dialog = useRef(null), cancel = useRef(null), outside = useRef(false);
  const titleId = useId(), messageId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!element || !container) return;
    const owner = container.closest('dialog'), document = element.ownerDocument;
    let opener = null;
    const show = () => {
      if (!element.isConnected || element.open || owner && !owner.open) return;
      opener = document.activeElement;
      element.showModal();
      cancel.current?.focus({ preventScroll: true });
    };
    // An error may already exist when the owning modal first mounts. Wait
    // until that modal opens so it cannot cover this prompt in the top layer.
    const observer = owner ? new MutationObserver(show) : null;
    observer?.observe(owner, { attributes: true, attributeFilter: ['open'] });
    show();
    return () => {
      observer?.disconnect();
      if (element.open) element.close();
      if (opener?.isConnected && !opener.matches(':disabled') && (!owner || owner.open)) opener.focus({ preventScroll: true });
    };
  }, [container]);
  const dismiss = () => { if (!busy) onCancel(); };
  return container && createPortal(<dialog ref={dialog} className="prompt-dialog" role="alertdialog" aria-modal="true"
    aria-labelledby={titleId} aria-describedby={messageId} aria-busy={busy || undefined}
    onCancel={(event) => { event.preventDefault(); event.stopPropagation(); dismiss(); }} onClose={stop}
    onPointerDown={(event) => {
      event.stopPropagation();
      const box = event.currentTarget.getBoundingClientRect();
      outside.current = event.target === event.currentTarget && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom);
    }} onPointerMove={stop} onPointerUp={stop} onContextMenu={stop} onKeyDown={stop}
    onClick={(event) => {
      event.stopPropagation();
      if (event.target !== event.currentTarget || !outside.current) return;
      const box = event.currentTarget.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dismiss();
    }}>
    <h2 id={titleId}>{title}</h2>
    <div className="prompt-dialog-message" id={messageId}>{children}</div>
    <div className="prompt-dialog-actions">
      <button ref={cancel} type="button" className={`button ${onConfirm ? 'quiet' : 'primary'}`} disabled={busy} onClick={dismiss}>{onConfirm ? tr('取消') : tr('关闭')}</button>
      {onConfirm && <button type="button" className={`button ${destructive ? 'danger' : 'primary'}`} disabled={busy || confirmDisabled} onClick={onConfirm}>{action}</button>}
    </div>
  </dialog>, container);
}

// Keep persistent errors dismissible without repeatedly reopening on every
// render. Clearing the message permits a later attempt to report it again.
export function MessageDialog({ message, title = tr('提示'), onClose }) {
  const [dismissed, setDismissed] = useState(null);
  useEffect(() => { if (!message) setDismissed(null); }, [message]);
  if (!message || dismissed === message) return null;
  return <PromptDialog title={title} onCancel={() => { setDismissed(message); onClose?.(); }}><p>{tr(message)}</p></PromptDialog>;
}

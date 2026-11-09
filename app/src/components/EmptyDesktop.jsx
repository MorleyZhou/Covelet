import { useEffect, useRef, useState } from 'react';
import { tr } from '../i18n/index.js';
import { localData } from '../lib/local-data.js';
import { userErrorMessage } from '../lib/user-error.js';
import { Button } from './ui/button.jsx';
import './empty-desktop.css';

const KEY = 'covelet.empty-desktop-dismissed.v1';

export default function EmptyDesktop({ onAdd, onImport, onDismiss }) {
  const [dismissed, setDismissed] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const working = useRef(false);

  useEffect(() => {
    let active = true, receivedUpdate = false;
    const stop = localData.subscribe((changes) => {
      if (!changes[KEY]) return;
      receivedUpdate = true;
      setDismissed(changes[KEY].newValue === true);
    });
    localData.get(KEY).then((values) => {
      if (active && !receivedUpdate) setDismissed(values[KEY] === true);
    }).catch(() => {
      if (active && !receivedUpdate) setDismissed(false);
    });
    return () => { active = false; stop(); };
  }, []);

  async function dismiss() {
    if (working.current) return;
    working.current = true;
    setBusy(true); setError('');
    try {
      await localData.set({ [KEY]: true });
      setDismissed(true);
      onDismiss?.();
    } catch (reason) {
      setError(userErrorMessage(reason, tr('数据未能保存，请重试。')));
    } finally { working.current = false; setBusy(false); }
  }

  if (dismissed !== false) return null;
  return <div className="empty-desktop" data-layout-control>
    <div className="empty-desktop-actions">
      <Button type="button" disabled={busy} onClick={onAdd}>{tr('添加常用网站')}</Button>
      <Button type="button" variant="secondary" disabled={busy} onClick={onImport}>{tr('导入书签')}</Button>
    </div>
    <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={dismiss}>{tr('空白开始')}</Button>
    {error && <p className="form-error" role="alert">{tr(error)}</p>}
  </div>;
}

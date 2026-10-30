import { useRef, useState } from 'react';
import { tr } from '../../i18n/index.js';
import { MessageDialog } from '../PromptDialog.jsx';
export { useAppData } from '../../lib/app-data.js';
export { Button } from '../ui/button.jsx';
export { Input } from '../ui/input.jsx';
export { Textarea } from '../ui/textarea.jsx';
export { default as Select } from '../Select.jsx';

export function Field({ label, children }) { return <label className="app-field"><span>{label}</span>{children}</label>; }
export function AppError({ message, onClose }) { return <MessageDialog message={message} onClose={onClose || (() => {})} />; }
export function useAppAction() {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''); const running = useRef(false);
  const run = async (action) => {
    if (running.current) return;
    running.current = true; setBusy(true); setError('');
    try { return await action(); } catch (reason) { if (reason.name !== 'AbortError') setError(reason.message || tr('操作失败，请重试。')); }
    finally { running.current = false; setBusy(false); }
  };
  return { busy, error, run, setError };
}
export function downloadBlob(blob, name = 'covelet-export') {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export async function readTextFile(file, maxBytes = 2 * 1024 * 1024) {
  if (!file || !file.size || file.size > maxBytes) throw Error(tr('文件为空或超过大小限制。'));
  return file.text();
}

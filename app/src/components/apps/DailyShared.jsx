import { useEffect, useMemo } from 'react';
import { tr } from '../../i18n/index.js';
import PromptDialog from '../PromptDialog.jsx';
import { Textarea } from '../ui/textarea.jsx';
import { useAppData, useAppAction, AppError, Button, Input, Select, Field, downloadBlob, readTextFile } from './shared.jsx';
import { validateDailyDocument } from '../../lib/daily-apps.js';
import './daily-apps.css';
export { tr, Button, Input, Select, Field, downloadBlob, readTextFile };
export function useDailyData(id, defaults, props) {
  const store = useAppData(id, defaults), action = useAppAction();
  const invalid = useMemo(() => { try { validateDailyDocument(id, store.data); return ''; } catch (reason) { return reason.message; } }, [id, store.data]);
  useEffect(() => { props.onBusyChange?.(action.busy); return () => props.onBusyChange?.(false); }, [action.busy, props.onBusyChange]);
  return { ...store, data: invalid ? defaults : store.data, unavailable: !store.loaded || Boolean(invalid), error: invalid || store.error,
    update: (transform, options) => store.update((current) => { validateDailyDocument(id, current); return validateDailyDocument(id, transform(current)); }, options), action };
}
export function useDirty(dirty, callback) {
  useEffect(() => { callback?.(dirty); return () => callback?.(false); }, [dirty, callback]);
}
export function DailyError({ error, action }) { return <AppError message={error || action.error} onClose={() => action.setError('')} />; }
export function DeletePrompt({ target, title, action, onCancel, onConfirm }) {
  return target ? <PromptDialog title={tr('确认删除')} action={tr('删除')} destructive busy={action.busy} onCancel={onCancel} onConfirm={onConfirm}>
    {title || tr('删除“{0}”？', [target.title || target.name || target.term])}
  </PromptDialog> : null;
}
export function DiscardPrompt({ pending, onCancel, onConfirm }) {
  return pending ? <PromptDialog action={tr('放弃修改')} onCancel={onCancel} onConfirm={onConfirm}>{tr('当前内容尚未保存，放弃修改？')}</PromptDialog> : null;
}
export function TextArea({ label, ...props }) { return <Field label={label}><Textarea className="app-textarea" {...props} /></Field>; }
export function Loading({ loading }) { return loading ? <p className="app-muted" role="status">{tr('正在加载…')}</p> : null; }
export const shortDate = (value) => value ? new Intl.DateTimeFormat(document.documentElement.lang || undefined, { dateStyle: 'medium' }).format(new Date(value)) : '';

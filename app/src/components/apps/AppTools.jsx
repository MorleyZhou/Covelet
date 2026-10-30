import { lazy, Suspense, useState } from 'react';
import { CheckSquare, CodeBlock, Toolbox, Image, FilePdf, Rss, ChatCircle, Translate, ChartLine, CurrencyDollar, Wallet, Graph, MusicNotes, Airplane, Package, Basketball, ForkKnife } from '@phosphor-icons/react';
import { tr } from '../../i18n/index.js';
import { appDefinition } from '../../lib/app-catalog.js';
import { useAppData } from '../../lib/app-data.js';
import { MARKET_DEFAULTS } from '../../lib/market-apps.js';
import { Button, useAppAction, AppError } from './shared.jsx';
import DesktopWidgetContent from './DesktopWidgetContent.jsx';
import Confirm from '../PromptDialog.jsx';
import './apps.css';

const DailyApps = lazy(() => import('./DailyApps.jsx'));
const ProcessingApps = lazy(() => import('./ProcessingApps.jsx'));
const MarketApps = lazy(() => import('./MarketApps.jsx'));
const ConnectedApps = lazy(() => import('./ConnectedApps.jsx'));
const icons = { CheckSquare, CodeBlock, Toolbox, Image, FilePdf, Rss, ChatCircle, Translate, ChartLine, CurrencyDollar, Wallet, Graph, MusicNotes, Airplane, Package, Basketball, ForkKnife };
export function AppIcon({ appId, size = 28 }) { const Icon = icons[appDefinition(appId)?.icon] || Toolbox; return <Icon size={size} aria-hidden="true" />; }

export function AppPanel(props) {
  const Component = ['tasks', 'snippets', 'language', 'travel', 'meals'].includes(props.appId) ? DailyApps
    : ['online-tools', 'images', 'pdf', 'media', 'canvas'].includes(props.appId) ? ProcessingApps
      : ['stocks', 'currency', 'ledger', 'orders', 'sports'].includes(props.appId) ? MarketApps : ConnectedApps;
  return <Suspense fallback={<p className="app-empty" role="status">{tr('正在加载…')}</p>}><Component key={props.appId} {...props} /></Suspense>;
}

export function AppToolWindow({ appId, widgetId, Dialog, onClose, onOpenApp, initialContext }) {
  const [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false), [discarding, setDiscarding] = useState(false), [pendingApp, setPendingApp] = useState(null);
  const app = appDefinition(appId);
  const close = () => { if (busy) return; setPendingApp(null); if (dirty) setDiscarding(true); else onClose(); };
  const openApp = (id, context) => { if (busy) return; if (dirty) { setPendingApp({ id, context }); setDiscarding(true); } else onOpenApp?.(id, context); };
  return <Dialog title={app.name} privacyKeys={widgetId ? [`widget:${widgetId}`] : []} wide maximizable className={`app-tools-modal app-window-${appId}`} closeDisabled={busy} onClose={close}>
    <AppPanel appId={appId} onDirtyChange={setDirty} onBusyChange={setBusy} onOpenApp={openApp} initialContext={initialContext} />
    {discarding && <Confirm privacySafe action={tr('放弃修改')} onCancel={() => { setDiscarding(false); setPendingApp(null); }} onConfirm={() => { if (pendingApp) onOpenApp?.(pendingApp.id, pendingApp.context); else onClose(); }}>{tr('当前内容尚未保存，放弃修改？')}</Confirm>}
  </Dialog>;
}

function widgetMetric(appId, data) {
  if (appId === 'tasks') return (data.tasks || []).filter((item) => !item.completed).length;
  if (appId === 'snippets') return (data.items || []).length;
  if (appId === 'subscriptions') return (data.items || []).filter((item) => !item.read).length;
  if (appId === 'language') return (data.words || []).filter((item) => item.dueAt <= Date.now()).length;
  return '';
}
export default function AppWidget({ entry, open, onOpen }) {
  const { data, update, loaded, loading, error } = useAppData(entry.extensionId, MARKET_DEFAULTS[entry.extensionId] || {}), action = useAppAction();
  const app = appDefinition(entry.extensionId), mini = entry.config.size === 'mini';
  if (mini) return <Button variant="unstyled" size="unstyled" type="button" data-widget-launcher data-widget-surface id={`widget-title-${entry.id}`} className={`personal-widget personal-widget-mini app-widget app-widget-${entry.extensionId}`} onClick={() => onOpen()} aria-haspopup="dialog" aria-expanded={open} aria-label={app.name}><AppIcon appId={entry.extensionId} size={28} /></Button>;
  const metric = loaded ? widgetMetric(entry.extensionId, data) : '';
  return <><article data-widget-surface data-app-widget={entry.extensionId} id={`widget-title-${entry.id}`} tabIndex={-1} className={`personal-widget personal-widget-${entry.config.size} app-widget app-widget-${entry.extensionId} app-widget-content`} aria-busy={loading || action.busy}>
    <Button variant="unstyled" size="unstyled" type="button" data-widget-launcher className="app-widget-open-cover" onClick={() => onOpen()} aria-label={app.name} aria-haspopup="dialog" aria-expanded={open} />
    <header className="app-widget-header" aria-hidden="true"><AppIcon appId={entry.extensionId} size={14} /><strong>{app.name}</strong>{metric !== '' && <small>{metric}</small>}</header>
    <div className="app-widget-body">{loaded ? <DesktopWidgetContent appId={entry.extensionId} data={data} onOpen={onOpen} update={update} action={action} /> : <span className="app-widget-hint">{error ? tr('暂时无法读取内容') : ''}</span>}</div>
  </article><AppError message={action.error} onClose={() => action.setError('')} /></>;
}

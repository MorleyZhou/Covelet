import { useContext, useRef, useState } from 'react';
import { ListBullets } from '@phosphor-icons/react';
import { tr, formatNumber } from '../i18n/index.js';
import { resolveReferencedWidget } from '../lib/referenced-widgets.js';
import { getSavedViews, resolveSavedView } from '../lib/saved-views.js';
import { pinContentWidget } from '../lib/pin-widget.js';
import { PresentationContext } from '../lib/presentation.js';
import { PinDesktopContext } from './PinToDesktopDialog.jsx';
import { userErrorMessage } from '../lib/user-error.js';
import Select from './Select.jsx';
import { Button } from './ui/button.jsx';
import './saved-view-widget.css';

export default function SavedViewWidget({ entry, navigation, tools, preferences, hiddenKeys, today, resolution, onOpenContent, onOpenList, onConfigure }) {
  const result = resolution || resolveReferencedWidget(entry, { navigation, tools, preferences, hiddenKeys, today });
  const mini = entry.config.size === 'mini';
  const label = result.status === 'ready' ? result.target.name : result.status === 'unconfigured' ? tr('选择动态清单')
    : result.status === 'missing' ? tr('清单已移除') : result.status === 'hidden' ? tr('已隐藏') : tr('清单条件已失效');
  const open = () => result.status === 'ready' ? onOpenList(result.target) : onConfigure();
  if (mini || result.status !== 'ready') return <Button type="button" variant="unstyled" size="unstyled" data-widget-launcher data-widget-surface id={`widget-title-${entry.id}`}
    className={`personal-widget personal-widget-${entry.config.size} saved-view-widget`} aria-label={label} onClick={open}>
    <span className="personal-widget-heading"><ListBullets size={mini ? 25 : 20} /><span>{label}</span>{result.status === 'ready' && <b>{formatNumber(result.rows.length)}</b>}</span>
  </Button>;
  return <section data-widget-surface className={`personal-widget personal-widget-${entry.config.size} saved-view-widget`} aria-label={label}>
    <Button type="button" variant="unstyled" size="unstyled" data-widget-launcher id={`widget-title-${entry.id}`} className="personal-widget-heading saved-view-heading" onClick={open}>
      <ListBullets size={20} /><strong>{label}</strong><b>{formatNumber(result.rows.length)}</b>
    </Button>
    <div className="personal-widget-body saved-view-results">{result.rows.slice(0, entry.config.size === 'large' ? 7 : 3).map((row) => <Button key={row.key} type="button" variant="unstyled" size="unstyled"
      className="saved-view-result" onClick={() => onOpenContent(row)}><strong>{row.title}</strong><small>{row.subtitle}</small></Button>)}
      {!result.rows.length && <span className="personal-widget-empty">{tr('没有匹配的内容')}</span>}
    </div>
  </section>;
}

export function SavedViewTargetDialog({ entry, navigation, tools, preferences, hiddenKeys, Dialog, onClose, onBusyChange }) {
  const desktop = useContext(PinDesktopContext), snapshot = useRef(navigation), original = useRef(structuredClone(entry));
  const presentation = useContext(PresentationContext);
  const [selected, setSelected] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), gate = useRef(false);
  const environment = { navigation, tools, preferences, hiddenKeys };
  const views = getSavedViews(preferences, { navigation, tools, hiddenKeys }).filter((view) => resolveSavedView(view, environment).status === 'ready');
  const chosen = selected && preferences.library?.views?.find((view) => view.id === selected.id);
  const shielded = preferences.presentation && chosen && resolveSavedView(chosen, environment).status === 'hidden';
  const selectedReady = selected && views.some((view) => view.id === selected.id && view.revision === selected.revision);
  return <Dialog title={tr('选择动态清单')} closeDisabled={busy} onClose={onClose} privacyKeys={[`widget:${entry.id}`, ...(selected ? [`view:${selected.id}`] : [])]}>
    {shielded && <div className="presentation-dialog-shield"><p>{tr('清单包含隐藏条件，请先解锁。')}</p><Button type="button" variant="secondary" onClick={presentation.requestUnlock}>{tr('输入密码查看隐藏内容')}</Button></div>}
    <form className="form-stack saved-view-target-form" style={shielded ? { display: 'none' } : undefined} inert={shielded || undefined} aria-hidden={shielded || undefined} onSubmit={async (event) => {
      event.preventDefault(); if (!selected || gate.current || event.nativeEvent.isComposing) return;
      gate.current = true; setBusy(true); onBusyChange?.(true); setError('');
      try {
        const result = await pinContentWidget({ kind: 'view', recordId: selected.id, expectedRecordRevision: selected.revision,
          expectedPreferencesRevision: selected.preferencesRevision, expectedNavigationRevision: snapshot.current.revision,
          size: original.current.config.size, widgetId: original.current.id, expectedConfig: original.current.config });
        desktop.onPinned(result); onClose();
      } catch (reason) { setError(userErrorMessage(reason)); }
      finally { gate.current = false; setBusy(false); onBusyChange?.(false); }
    }}>
      <Select label={tr('动态清单')} value={selected?.id || ''} placeholder={tr('选择动态清单')} disabled={busy} options={views.map((view) => ({ value: view.id, label: view.name }))}
        onChange={(id) => { const view = views.find((item) => item.id === id); if (view) setSelected({ id, revision: view.revision, preferencesRevision: preferences.revision }); }} />
      {!views.length && <p className="hint">{tr('还没有动态清单')}</p>}
      {selected && !selectedReady && !shielded && <p className="form-error" role="status">{tr('所选项目已发生变化，请重新选择。')}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-footer"><Button type="button" variant="secondary" disabled={busy} onClick={onClose}>{tr('取消')}</Button><Button type="submit" disabled={busy || !selectedReady}>{tr('保存')}</Button></div>
    </form>
  </Dialog>;
}

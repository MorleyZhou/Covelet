import { tr } from '../i18n/index.js';
import { useEffect, useRef, useState } from 'react';
import { SquaresFour, Code, ArrowsClockwise, GithubLogo, MagnifyingGlass, X, Clock, NotePencil, BookOpen, ChartLine, Package } from '@phosphor-icons/react';
import { BUNDLED_EXTENSIONS, EXTENSION_CATEGORIES, extensionMetadata, extensionsForCatalog } from '../lib/extensions.js';
import { WIDGET_SIZE_OPTIONS } from '../lib/widget-model.js';
import { WIDGET_SIZES } from '../lib/desktop-layout.js';
import { AppIcon } from './apps/AppTools.jsx';
import { AppError, useAppAction } from './apps/shared.jsx';
import Confirm from './PromptDialog.jsx';
import Select from './Select.jsx';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs.jsx';
import { Input } from './ui/input.jsx';
import { Button } from './ui/button.jsx';
import './extensions.css';

const catalogTabs = [{ id: 'all', get label() { return tr('全部扩展'); }, Icon: SquaresFour }, ...EXTENSION_CATEGORIES.map((category) => ({
  id: category.id, get label() { return category.label; }, Icon: ({ development: Code, time: Clock, productivity: NotePencil, learning: BookOpen, finance: ChartLine, creative: SquaresFour, life: Package })[category.id] || ArrowsClockwise,
}))];
function ExtensionIcon({ extension }) {
  if (extension.app) return <span className={`extension-item-icon extension-${extension.id}-icon`}><AppIcon appId={extension.id} size="54%" /></span>;
  const Icon = ({ clock: Clock, notes: NotePencil, 'read-later': BookOpen, 'github-contributions': GithubLogo })[extension.id] || ArrowsClockwise;
  return <span className={`extension-item-icon extension-${extension.id}-icon`}><Icon size="54%" aria-hidden="true" /></span>;
}
// Management only: no app panel, content data, or provider configuration here.
function WidgetSettings({ extension, entry, onSave, onRemove, onBusyChange, onDirtyChange }) {
  const initialSize = entry?.config.size || (extension.id === 'github-contributions' ? 'medium' : 'small');
  const [size, setSize] = useState(initialSize), action = useAppAction(), footprint = WIDGET_SIZES[size];
  useEffect(() => { onBusyChange(action.busy); }, [action.busy, onBusyChange]);
  useEffect(() => { onDirtyChange(size !== initialSize); }, [size, initialSize, onDirtyChange]);
  const save = () => action.run(() => onSave({ ...(entry?.config || (extension.id === 'clock' ? { style: 'analog' } : extension.id === 'github-contributions' ? { username: '' } : {})), size }, entry, extension.id));
  return <div className="extension-component-settings" data-catalog-settings={extension.id}>
    <div className="extension-component-heading"><ExtensionIcon extension={extension} /><div><h3>{extension.name}</h3><p>{extension.description}</p></div></div>
    <div className="extension-size-layout"><figure className="extension-size-preview" aria-label={tr('组件预览')}>
      <div className="extension-preview-grid" aria-hidden="true">{Array.from({ length: 16 }, (_, at) => <span key={at} style={{ gridColumn: at % 4 + 1, gridRow: Math.floor(at / 4) + 1 }} />)}
        <div className={`extension-preview-widget is-${size}`} style={{ gridColumn: `1 / span ${footprint.columns}`, gridRow: `1 / span ${footprint.rows}` }}><ExtensionIcon extension={extension} />{size !== 'mini' && <strong>{extension.name}</strong>}</div>
      </div><figcaption>{WIDGET_SIZE_OPTIONS.find((item) => item.value === size).label}</figcaption>
    </figure><div className="extension-size-controls"><Select label={tr('桌面尺寸')} value={size} onChange={setSize} disabled={action.busy} options={WIDGET_SIZE_OPTIONS} />
      <div className="extension-size-actions"><Button type="button" disabled={action.busy} onClick={save}>{entry && !entry.detached ? tr('保存') : tr('添加到桌面')}</Button>
      {entry && !entry.detached && <Button type="button" variant="ghost" disabled={action.busy} onClick={() => action.run(() => onRemove(entry))}>{tr('从桌面移除')}</Button>}</div></div></div>
    <AppError message={action.error} onClose={() => action.setError('')} />
  </div>;
}
export default function ExtensionCenter({ Dialog, state, initialExtension, editingId, onUseWidget, onRemoveWidget, onConfigureFunctional, onClose }) {
  const initial = BUNDLED_EXTENSIONS.find((item) => item.id === initialExtension && item.type === 'widget');
  const [category, setCategory] = useState(initial?.category || 'all'), [query, setQuery] = useState(''), [selected, setSelected] = useState(initial || null);
  const [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false), [pending, setPending] = useState(null);
  const [compact, setCompact] = useState(() => matchMedia('(max-width: 620px)').matches);
  const searchRef = useRef(null), opener = useRef(null), scrollPosition = useRef(0), focusIntent = useRef(null);
  const findWidget = (id) => state.entries.find((item) => item.type === 'widget' && item.extensionId === id && (!(editingId && initial?.id === id) || item.id === editingId));
  const currentCategory = catalogTabs.find((item) => item.id === category) || catalogTabs[0], extensions = extensionsForCatalog(currentCategory.id, query);
  const guarded = (callback) => { if (busy) return; if (dirty) setPending(() => callback); else callback(); };
  useEffect(() => {
    if (!focusIntent.current) return;
    if (!selected) { const panel = document.getElementById('extensions-panel'); if (panel) panel.scrollTop = scrollPosition.current; }
    document.getElementById(focusIntent.current)?.focus({ preventScroll: true }); focusIntent.current = null;
  }, [selected, category]);
  useEffect(() => { const media = matchMedia('(max-width: 620px)'), update = () => setCompact(media.matches); media.addEventListener('change', update); return () => media.removeEventListener('change', update); }, []);
  const chooseCategory = (value) => guarded(() => { focusIntent.current = `extensions-tab-${value}`; setCategory(value); setQuery(''); setSelected(null); setDirty(false); });
  const open = (extension, event) => {
    if (extension.type === 'functional') { onConfigureFunctional(extension.id); return; }
    opener.current = event.currentTarget; scrollPosition.current = document.getElementById('extensions-panel')?.scrollTop || 0; setSelected(extension);
  };
  const back = () => guarded(() => { focusIntent.current = opener.current?.id || `extension-${selected.id}`; setSelected(null); setDirty(false); });
  const editing = selected && findWidget(selected.id);
  return <Dialog title={selected?.name || tr('扩展')} onClose={() => guarded(onClose)} closeDisabled={busy} onBack={selected ? back : undefined} backLabel={tr('返回扩展')}
    privacyKeys={editing ? [`widget:${editing.id}`] : []} className={`settings-modal extension-modal ${selected ? 'extension-detail-modal' : ''}`} wide maximizable>
    {pending && <Confirm privacySafe action={tr('放弃修改')} onCancel={() => setPending(null)} onConfirm={() => { const next = pending; setPending(null); setDirty(false); next(); }}>{tr('当前内容尚未保存，放弃修改？')}</Confirm>}
    <Tabs className={`extension-layout ${selected ? 'has-detail' : ''}`} value={currentCategory.id} orientation={compact ? 'horizontal' : 'vertical'} onValueChange={chooseCategory}>
      <aside className="extension-sidebar"><TabsList className="extension-categories" aria-label={tr('扩展分类')}>{catalogTabs.map((item) => <TabsTrigger key={item.id} value={item.id} disabled={busy} id={`extensions-tab-${item.id}`} aria-controls="extensions-panel"><item.Icon size={19} aria-hidden="true" />{item.label}</TabsTrigger>)}</TabsList></aside>
      <TabsContent value={currentCategory.id} asChild><section className={`extension-content ${selected ? 'extension-detail' : 'extension-catalog'}`} id="extensions-panel" tabIndex={selected ? -1 : 0}>
        {selected ? <WidgetSettings key={selected.id} extension={selected} entry={editing} onSave={onUseWidget} onRemove={onRemoveWidget} onBusyChange={setBusy} onDirtyChange={setDirty} /> : <div className="extension-catalog-scroll">
          <div className="extension-catalog-heading"><h2>{currentCategory.label}</h2><div className="extension-search"><MagnifyingGlass size={16} aria-hidden="true" /><Input unstyled ref={searchRef} type="search" aria-label={tr('搜索扩展')} placeholder={tr('搜索扩展')} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (!event.nativeEvent.isComposing && event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); setQuery(''); } }} />{query && <Button variant="unstyled" size="unstyled" type="button" aria-label={tr('清除搜索')} onClick={() => { setQuery(''); searchRef.current?.focus(); }}><X size={14} /></Button>}</div></div>
          <div className="extension-grid" aria-label={tr('扩展列表')}>{extensions.map((extension) => { const widget = findWidget(extension.id); return <Button variant="unstyled" size="unstyled" type="button" className="extension-item" key={extension.id} id={`extension-${extension.id}`} onClick={(event) => open(extension, event)}><ExtensionIcon extension={extension} /><span className="extension-item-content"><strong>{extension.name}</strong><span className="extension-item-description">{extension.description}</span><span className="extension-item-meta">{extensionMetadata(extension)}</span></span><span className="extension-item-action">{extension.type === 'functional' ? tr('设置') : widget && !widget.detached ? tr('调整') : tr('添加')}</span></Button>; })}</div>
          {!extensions.length && <div className="extension-no-results" role="status">{tr('没有找到扩展')}</div>}
        </div>}
      </section></TabsContent>
    </Tabs>
  </Dialog>;
}

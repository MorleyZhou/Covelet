import { tr, getLocale } from "../i18n/index.js";
import { useEffect, useRef, useState } from 'react';
import { SquaresFour, Code, ArrowsClockwise, GithubLogo, MagnifyingGlass, X, Clock, NotePencil, BookOpen, Browser } from '@phosphor-icons/react';
import { BUNDLED_EXTENSIONS, EXTENSION_CATEGORIES, extensionMetadata, extensionsForCatalog } from '../lib/extensions.js';
import CloudSyncSettings, { CloudSyncSummary } from './CloudSyncSettings.jsx';
import { GitHubWidgetSettings, GitHubWidgetPreview } from './GitHubWidget.jsx';
import { ClockWidgetSettings, ClockWidgetPreview } from './ClockWidget.jsx';
import { PersonalWidgetSettings, PersonalWidgetPreview, TabSnapshotTools } from './PersonalTools.jsx';
import './extensions.css';

const catalogTabs = [{ id: 'all', get label() { return tr("全部扩展"); }, Icon: SquaresFour }, ...EXTENSION_CATEGORIES.map((category) => ({
  id: category.id, get label() { return category.label; }, Icon: ({ development: Code, time: Clock, productivity: NotePencil, browsing: Browser })[category.id] || ArrowsClockwise,
}))];

function ExtensionIcon({ extension }) {
  const Icon = ({ clock: Clock, notes: NotePencil, 'read-later': BookOpen, 'tab-snapshots': Browser, 'github-contributions': GithubLogo })[extension.id] || ArrowsClockwise;
  return <span className={`extension-item-icon extension-${({ 'github-contributions': 'github', 'custom-storage-sync': 'sync' })[extension.id] || extension.id}-icon`}>
    <Icon size="54%" weight={extension.id === 'github-contributions' ? 'fill' : 'regular'} aria-hidden="true" />
  </span>;
}

function ExtensionIntroduction({ extension }) {
  return <div className="extension-introduction">
    <div className="extension-product"><ExtensionIcon extension={extension} />
      <div><h3>{extension.name}</h3><p>{extension.description}</p></div>
    </div>
    <dl className="extension-facts">
      <div><dt>{tr("分类")}</dt><dd>{EXTENSION_CATEGORIES.find((item) => item.id === extension.category)?.label}</dd></div>
      <div><dt>{tr("类型")}</dt><dd>{extension.type === 'widget' ? tr("桌面组件") : tr("功能扩展")}</dd></div>
      <div><dt>{extension.type === 'widget' ? tr("尺寸（行 × 列）") : extension.id === 'custom-storage-sync' ? tr("存储服务") : tr("保存位置")}</dt><dd>{extension.type === 'widget' ? '1×1、2×2、2×4、4×4' : extension.id === 'custom-storage-sync' ? tr("GitHub 等 5 项") : tr("本机")}</dd></div>
    </dl>
    {extension.type === 'widget' && <details className="extension-preview-disclosure"><summary>{tr("组件预览")}</summary>{extension.id === 'clock' ? <ClockWidgetPreview /> : extension.id === 'github-contributions' ? <GitHubWidgetPreview /> : <PersonalWidgetPreview extensionId={extension.id} />}</details>}
  </div>;
}

export default function ExtensionCenter({ Dialog, demo = false, state, initialExtension, editingId, onUseWidget, onClose }) {
  const initial = BUNDLED_EXTENSIONS.find((item) => item.id === initialExtension);
  const [category, setCategory] = useState(initial?.category || 'all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(initial || null);
  const findWidget = (id) => state.entries.find((item) => item.type === 'widget' && item.extensionId === id
    && (!(editingId && initial?.id === id) || item.id === editingId));
  const [editing, setEditing] = useState(() => initial?.type === 'widget' ? structuredClone(findWidget(initial.id) || null) : null);
  const [busy, setBusy] = useState(false);
  const [compact, setCompact] = useState(() => matchMedia('(max-width: 620px)').matches);
  const opener = useRef(null), searchRef = useRef(null), scrollPosition = useRef(0), focusIntent = useRef(null);
  const currentCategory = catalogTabs.find((item) => item.id === category) || catalogTabs[0];
  const extensions = extensionsForCatalog(currentCategory.id, query);
  useEffect(() => {
    const id = focusIntent.current;
    if (!id) return;
    focusIntent.current = null;
    const panel = document.getElementById('extensions-panel');
    if (!selected && panel) panel.scrollTop = scrollPosition.current;
    document.getElementById(id)?.focus({ preventScroll: true });
  }, [selected, category]);
  useEffect(() => {
    const media = matchMedia('(max-width: 620px)');
    const change = () => setCompact(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);

  function open(extension, event) {
    opener.current = event.currentTarget;
    scrollPosition.current = event.currentTarget.closest('.extension-catalog')?.scrollTop || 0;
    if (extension.type === 'widget') setEditing(structuredClone(findWidget(extension.id) || null));
    setSelected(extension);
  }
  function back() {
    if (busy) return;
    focusIntent.current = opener.current?.id || `extension-${selected.id}`;
    setSelected(null);
  }
  function changeCategory(index) {
    if (busy) return;
    if (category === catalogTabs[index].id && !selected) {
      setQuery('');
      document.getElementById(`extensions-tab-${catalogTabs[index].id}`)?.focus();
      return;
    }
    focusIntent.current = `extensions-tab-${catalogTabs[index].id}`;
    scrollPosition.current = 0;
    setCategory(catalogTabs[index].id); setQuery(''); setSelected(null);
  }

  return <Dialog title={selected?.name || tr("扩展")} onClose={onClose} closeDisabled={busy}
    onBack={selected ? back : undefined} backLabel={tr("返回扩展")}
    className={`settings-modal extension-modal ${selected ? 'extension-detail-modal' : ''}`} wide maximizable>
    <div className={`extension-layout ${selected ? 'has-detail' : ''}`}>
      <aside className="extension-sidebar">
        <div className="extension-categories" role="tablist" aria-label={tr("扩展分类")} aria-orientation={compact ? 'horizontal' : 'vertical'}>
          {catalogTabs.map((item, index) => <button key={item.id} type="button" role="tab" disabled={busy}
            id={`extensions-tab-${item.id}`} aria-controls="extensions-panel" aria-selected={currentCategory.id === item.id}
            tabIndex={currentCategory.id === item.id ? 0 : -1} onClick={() => changeCategory(index)}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              changeCategory(event.key === 'Home' ? 0 : event.key === 'End' ? catalogTabs.length - 1
                : (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + catalogTabs.length) % catalogTabs.length);
            }}><item.Icon size={19} weight="regular" aria-hidden="true" />{item.label}</button>)}
        </div>
      </aside>
      <section className={`extension-content ${selected ? 'extension-detail' : 'extension-catalog'}`} role="tabpanel" id="extensions-panel"
        aria-labelledby={`extensions-tab-${currentCategory.id}`} tabIndex={selected ? -1 : 0}>
        {selected?.id === 'custom-storage-sync'
          ? <CloudSyncSettings demo={demo} onBusyChange={setBusy} introduction={<ExtensionIntroduction extension={selected} />} />
          : selected?.id === 'clock'
            ? <ClockWidgetSettings key={editing?.id || 'clock-new'} entry={editing} onUse={onUseWidget} onBusyChange={setBusy}
                introduction={<ExtensionIntroduction extension={selected} />} />
          : selected?.id === 'github-contributions'
            ? <GitHubWidgetSettings key={editing?.id || 'new'} entry={editing} onUse={onUseWidget} onBusyChange={setBusy}
                introduction={<ExtensionIntroduction extension={selected} />} />
          : ['notes', 'read-later'].includes(selected?.id)
            ? <PersonalWidgetSettings key={editing?.id || selected.id} extensionId={selected.id} entry={editing} onUse={onUseWidget} onBusyChange={setBusy} introduction={<ExtensionIntroduction extension={selected} />} />
          : selected?.id === 'tab-snapshots'
            ? <TabSnapshotTools onBusyChange={setBusy} introduction={<ExtensionIntroduction extension={selected} />} />
            : <div className="extension-catalog-scroll">
              <div className="extension-catalog-heading"><h2>{currentCategory.label}</h2>
                <div className="extension-search"><MagnifyingGlass size={16} aria-hidden="true" />
                  <input ref={searchRef} type="search" aria-label={tr("搜索扩展")} placeholder={tr("搜索扩展")} value={query}
                    onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
                      if (!event.nativeEvent.isComposing && event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); setQuery(''); }
                    }} />
                  {query && <button type="button" aria-label={tr("清除搜索")} onClick={() => { setQuery(''); searchRef.current?.focus(); }}><X size={14} aria-hidden="true" /></button>}
                </div>
              </div>
              <div className="extension-grid" aria-label={tr("扩展列表")}>
                {extensions.map((extension) => {
                  const widget = findWidget(extension.id);
                  return extension.id === 'custom-storage-sync'
                  ? <CloudSyncSummary key={extension.id} id={`extension-${extension.id}`} extension={extension}
                      metadata={extensionMetadata(extension)} demo={demo} onOpen={(event) => open(extension, event)} />
                  : <button type="button" className="extension-item" key={extension.id} id={`extension-${extension.id}`} onClick={(event) => open(extension, event)}>
                    <ExtensionIcon extension={extension} />
                    <span className="extension-item-content"><strong>{extension.name}</strong><span className="extension-item-description">{extension.description}</span>
                      <span className="extension-item-meta">{extensionMetadata(extension)}{widget?.config.username ? ` · ${widget.config.username}` : ''}</span></span>
                    <span className="extension-item-action">{extension.type === 'functional' ? tr("打开") : widget && !widget.detached ? tr("配置") : tr("使用")}</span>
                  </button>;
                })}
              </div>
              {!extensions.length && <div className="extension-no-results" role="status">{tr("没有找到扩展")}</div>}
            </div>}
      </section>
    </div>
  </Dialog>;
}

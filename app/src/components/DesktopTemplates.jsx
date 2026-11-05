import { useEffect, useMemo, useRef, useState } from 'react';
import NavigationIconStatus from './NavigationIconStatus.jsx';
import { BookOpen, Check, Clock, DownloadSimple, FileArrowUp, FloppyDisk, NotePencil, Trash } from '@phosphor-icons/react';
import { tr, formatNumber } from '../i18n/index.js';
import { layoutDesktop, DESKTOP_ROWS } from '../lib/desktop-layout.js';
import { userErrorMessage } from '../lib/user-error.js';
import { letterIcon } from '../lib/model.js';
import { WIDGET_NAMES } from '../lib/widget-model.js';
import { BUILTIN_DESKTOP_TEMPLATES, DESKTOP_TEMPLATE_MAX_BYTES, createDesktopTemplate, inspectDesktopTemplate, applyDesktopTemplate,
  loadSavedDesktopTemplates, saveDesktopTemplate, deleteDesktopTemplate } from '../lib/desktop-templates.js';
import { Button } from './ui/button.jsx';
import { Input } from './ui/input.jsx';
import { Checkbox } from './ui/checkbox.jsx';
import { Disclosure } from './ui/disclosure.jsx';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs.jsx';
import PromptDialog from './PromptDialog.jsx';
import Select from './Select.jsx';
import './desktop-templates.css';

const widgetIcon = (extensionId) => extensionId === 'clock' ? Clock : extensionId === 'notes' ? NotePencil : BookOpen;
function TemplatePreview({ template, compact = false, caption }) {
  const entries = [
    ...template.widgets.map((widget, index) => ({ ...widget, id: `widget-${index}`, type: 'widget', name: WIDGET_NAMES[widget.extensionId], parentId: null, order: index })),
    ...template.sites.map((site, index) => ({ ...site, id: `site-${index}`, type: 'site', parentId: null, order: template.widgets.length + index, icon: letterIcon(site.name) })),
  ];
  const pages = [...new Set(entries.map((entry) => entry.page))].sort((a, b) => a - b);
  const screens = layoutDesktop(entries, template.appearance.columns, null, pages.length ? pages : [0]), screen = screens[0];
  const background = template.appearance.background;
  const surface = ['color', 'gradient'].includes(background.kind) ? background.value : '#e4ebf3';
  return <figure className={`desktop-template-preview${compact ? ' is-compact' : ''}`} aria-label={tr('桌面布局示意')}>
    <div className="desktop-template-preview-grid" style={{ background: surface, gridTemplateColumns: `repeat(${template.appearance.columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${DESKTOP_ROWS}, minmax(0, 1fr))` }}>
      {screen.items.map((entry) => {
        const position = screen.placements.get(entry.id), Icon = entry.type === 'widget' ? widgetIcon(entry.extensionId) : null;
        return <span className={`desktop-template-preview-tile ${entry.type}`} key={entry.id} style={{ gridRow: `${position.row} / span ${position.rows}`, gridColumn: `${position.column} / span ${position.columns}` }}>
          {Icon ? <Icon size={compact ? 12 : 18} aria-hidden="true" /> : <b>{entry.name.slice(0, 1)}</b>}
          {!compact && <small>{entry.name}</small>}
        </span>;
      })}
      {!entries.length && Array.from({ length: Math.min(8, template.appearance.columns) }, (_, index) => <span className="desktop-template-preview-placeholder" aria-hidden="true" key={index} style={{ gridRow: 2, gridColumn: index + 1 }} />)}
    </div>
    {!compact && (caption || entries.length > 0) && <figcaption>{caption || tr('共 {0} 屏', [formatNumber(screens.length)])}</figcaption>}
  </figure>;
}

export default function DesktopTemplates({ state, privateEntryIds = [], iconProgress, onApply, onClose, onBusyChange }) {
  const builtinNames = [tr('纯净导航'), tr('阅读记录'), tr('时区协作')];
  const [panel, setPanel] = useState('apply');
  const [template, setTemplate] = useState(BUILTIN_DESKTOP_TEMPLATES[0]), [selectedId, setSelectedId] = useState('builtin-0');
  const [saved, setSaved] = useState([]), [appearance, setAppearance] = useState(true), [widgets, setWidgets] = useState(false), [sites, setSites] = useState(false);
  const [name, setName] = useState(tr('我的桌面方案')), [publicIds, setPublicIds] = useState(new Set()), [siteFilter, setSiteFilter] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [pendingDelete, setPendingDelete] = useState(null);
  const fileInput = useRef(null), active = useRef(true), gate = useRef(false), openedRevision = useRef(state.revision);
  const changed = state.revision !== openedRevision.current;
  useEffect(() => {
    active.current = true;
    loadSavedDesktopTemplates().then((items) => { if (active.current) setSaved(items); }).catch((reason) => { if (active.current) setError(userErrorMessage(reason)); });
    return () => { active.current = false; };
  }, []);
  async function run(action) {
    if (gate.current) return;
    gate.current = true; setBusy(true); setError(''); onBusyChange?.(true);
    try { return await action(); }
    catch (reason) { if (active.current) setError(userErrorMessage(reason)); }
    finally { gate.current = false; if (active.current) setBusy(false); onBusyChange?.(false); }
  }
  const choose = (next, id) => { setTemplate(next); setSelectedId(id); setWidgets(false); setSites(false); setError(''); setPendingDelete(null); };
  const prepared = useMemo(() => {
    try { return applyDesktopTemplate(state, template, { appearance, widgets, sites }); }
    catch (reason) { return { error: userErrorMessage(reason) }; }
  }, [state, template, appearance, widgets, sites]);
  const counts = useMemo(() => {
    const available = new Map();
    for (const entry of state.entries) if (entry.type === 'widget') available.set(entry.extensionId, (available.get(entry.extensionId) || 0) + 1);
    let moved = 0, added = 0;
    for (const widget of template.widgets) {
      const count = available.get(widget.extensionId) || 0;
      if (count > 0) { moved++; available.set(widget.extensionId, count - 1); } else added++;
    }
    return { moved, added };
  }, [state, template]);
  const privateIds = new Set(privateEntryIds);
  const shareSites = state.entries.filter((entry) => entry.type === 'site' && !privateIds.has(entry.id) && !privateIds.has(entry.parentId));
  const filteredSites = shareSites.filter((entry) => !siteFilter.trim() || `${entry.name} ${entry.url}`.toLocaleLowerCase().includes(siteFilter.trim().toLocaleLowerCase()));
  const selectedPublicIds = shareSites.filter((entry) => publicIds.has(entry.id)).map((entry) => entry.id);
  const currentTemplate = () => createDesktopTemplate(state, { name, publicSiteIds: selectedPublicIds, privateEntryIds });
  let capturePreview = null, captureError = '';
  try { capturePreview = createDesktopTemplate(state, { name: name.trim() || tr('我的桌面方案'), publicSiteIds: selectedPublicIds, privateEntryIds }); }
  catch (reason) { captureError = userErrorMessage(reason); }
  const localSelection = saved.some((item) => item.id === selectedId);
  const selectedName = selectedId.startsWith('builtin-') ? builtinNames[Number(selectedId.slice(8))] : template.name;
  async function reloadSaved() { const items = await loadSavedDesktopTemplates(); if (active.current) setSaved(items); }
  const readFile = (event) => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    run(async () => {
      if (file.size > DESKTOP_TEMPLATE_MAX_BYTES) throw Error(tr('桌面方案不能超过 256 KB。'));
      const imported = inspectDesktopTemplate(await file.text()); choose(imported, 'imported');
    });
  };
  return <Tabs className="desktop-templates" value={panel} onValueChange={(value) => { if (!busy) { setPanel(value); setError(''); } }}>
    <TabsList className="desktop-template-tabs" aria-label={tr('方案操作')}>
      <TabsTrigger value="apply" disabled={busy}>{tr('选用方案')}</TabsTrigger>
      <TabsTrigger value="share" disabled={busy}>{tr('保存与分享')}</TabsTrigger>
    </TabsList>
    <Input ref={fileInput} type="file" hidden accept="application/json,.json" onChange={readFile} />
    <TabsContent value="apply" className="desktop-template-use-pane">
      <aside className="desktop-template-library" aria-label={tr('内置桌面方案')}>
        <div className="desktop-template-library-content">
          <section>
            <h3 className="desktop-template-section-title">{tr('内置桌面方案')}</h3>
            <div className="desktop-template-builtins">
              {BUILTIN_DESKTOP_TEMPLATES.map((item, index) => <Button key={index} type="button" variant="unstyled" size="unstyled" disabled={busy} aria-label={builtinNames[index]} aria-pressed={selectedId === `builtin-${index}`} className={`desktop-template-card${selectedId === `builtin-${index}` ? ' is-selected' : ''}`} onClick={() => choose(item, `builtin-${index}`)}>
                <TemplatePreview template={item} compact />
                <span className="desktop-template-card-label"><strong>{builtinNames[index]}</strong><small>{tr('{0} 个组件 · {1} 个网址', [formatNumber(item.widgets.length), formatNumber(item.sites.length)])}</small></span>
                {selectedId === `builtin-${index}` && <Check className="desktop-template-card-check" size={14} aria-hidden="true" />}
              </Button>)}
            </div>
          </section>
          <section className="desktop-template-local">
            <Select label={tr('我的方案')} value={localSelection ? selectedId : ''} disabled={busy || !saved.length} placeholder={saved.length ? tr('选择方案') : tr('还没有保存的方案')} onChange={(id) => { const item = saved.find((record) => record.id === id); if (item) choose(item.template, id); }} options={saved.map((item) => ({ value: item.id, label: item.name }))} />
          </section>
        </div>
        <div className="desktop-template-library-footer"><Button type="button" variant="outline" disabled={busy} onClick={() => fileInput.current?.click()}><FileArrowUp size={16} />{tr('导入方案')}</Button></div>
      </aside>
      <section className="desktop-template-inspector" aria-label={tr('所选方案预览')}>
        <div className="desktop-template-selected-heading">
          <div><span className="desktop-template-eyebrow">{selectedId.startsWith('builtin-') ? tr('内置桌面方案') : localSelection ? tr('我的方案') : tr('导入方案')}</span><h3>{selectedName}</h3></div>
          {localSelection && <Button type="button" variant="ghost" size="icon" disabled={busy} aria-label={tr('删除方案')} onClick={() => setPendingDelete(selectedId)}><Trash size={17} /></Button>}
        </div>
        <TemplatePreview template={template} />
        <fieldset className="desktop-template-scopes"><legend>{tr('应用范围')}</legend>
          <label className={`desktop-template-option${appearance ? ' is-checked' : ''}`}><Checkbox checked={appearance} disabled={busy} onCheckedChange={(value) => setAppearance(value === true)} /><span><strong>{tr('应用外观')}</strong><small>{tr('主题、背景和密度设置；列数变化会调整桌面显示。')}</small></span></label>
          <label className={`desktop-template-option${widgets ? ' is-checked' : ''}`} data-disabled={!template.widgets.length || undefined}><Checkbox checked={widgets} disabled={busy || !template.widgets.length} onCheckedChange={(value) => setWidgets(value === true)} /><span><strong>{tr('应用组件布局')}</strong><small>{template.widgets.length ? tr('将 {0} 个现有组件移至新屏幕，新增 {1} 个组件。保留现有组件的内容、时区和样式。', [formatNumber(counts.moved), formatNumber(counts.added)]) : tr('此方案不包含组件')}</small></span></label>
          <label className={`desktop-template-option${sites ? ' is-checked' : ''}`} data-disabled={!template.sites.length || undefined}><Checkbox checked={sites} disabled={busy || !template.sites.length} onCheckedChange={(value) => setSites(value === true)} /><span><strong>{tr('添加方案中的网址')}</strong><small>{template.sites.length ? tr('方案包含 {0} 个网址，将加入新屏幕；已有的完整网址会跳过。', [formatNumber(template.sites.length)]) : tr('此方案不包含网址')}</small></span></label>
        </fieldset>
        {template.sites.length > 0 && <Disclosure className="desktop-template-public-preview" title={tr('查看方案中的网址')}><ul>{template.sites.map((site, index) => <li key={index}><strong>{site.name}</strong><small>{site.url}</small></li>)}</ul></Disclosure>}
        {!selectedId.startsWith('builtin-') && !localSelection && <Button className="desktop-template-save-import" type="button" variant="secondary" disabled={busy} onClick={() => run(async () => { const record = await saveDesktopTemplate(template.name, template); await reloadSaved(); choose(record.template, record.id); })}><FloppyDisk size={16} />{tr('保存方案')}</Button>}
      </section>
    </TabsContent>
    <TabsContent value="share" className="desktop-template-share-pane">
      <section className="desktop-template-capture-form" aria-label={tr('保存与分享当前桌面')}>
        <label className="desktop-template-name"><span>{tr('方案名称')}</span><Input value={name} maxLength={200} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
        <div className="desktop-template-share-heading"><h3 className="desktop-template-section-title">{tr('选择公开网址')}</h3><span>{tr('已选 {0} 项', [formatNumber(selectedPublicIds.length)])}</span></div>
        <p className="hint">{tr('只分享勾选的网址；已标记为私密的网址不会显示。')}</p>
        <Input value={siteFilter} disabled={busy} aria-label={tr('筛选可分享的网址')} placeholder={tr('按名称或完整网址筛选')} onChange={(event) => setSiteFilter(event.target.value)} />
        <div className="desktop-template-share-list" aria-label={tr('选择公开网址')}>
          {filteredSites.map((entry) => <label key={entry.id} className="desktop-template-share-row"><Checkbox checked={publicIds.has(entry.id)} disabled={busy} aria-label={tr('公开分享 {0}', [entry.name])} onCheckedChange={(value) => setPublicIds((current) => { const next = new Set(current); if (value === true) next.add(entry.id); else next.delete(entry.id); return next; })} /><span><strong>{entry.name}</strong><small>{entry.url}</small></span></label>)}
          {!filteredSites.length && <p className="hint desktop-template-empty">{tr('没有可选择的公开网址')}</p>}
        </div>
      </section>
      <aside className="desktop-template-capture-summary" aria-label={tr('导出预览')}>
        <h3 className="desktop-template-section-title">{tr('导出预览')}</h3>
        {capturePreview && <TemplatePreview template={capturePreview} caption={tr('仅包含外观、组件布局和已选公开网址。')} />}
        <p className="desktop-template-share-total">{tr('包含 {0} 个网址，不包含自定义图标。', [formatNumber(selectedPublicIds.length)])}</p>
        <Disclosure title={tr('分享内容说明')} className="desktop-template-sharing-help"><p className="hint">{tr('不包含账号信息、文件夹名称、便笺正文和阅读内容。最多可保存 20 份方案。')}</p></Disclosure>
      </aside>
    </TabsContent>
    <div className="desktop-template-feedback" aria-live="polite">
      <NavigationIconStatus report={iconProgress} busy={busy} />
      {(error || changed || (panel === 'apply' ? prepared.error : captureError)) && <p className="form-error" role="alert">{changed ? tr('桌面已在其他页面更新，请关闭后重新打开方案。') : error || (panel === 'apply' ? prepared.error : captureError)}</p>}
    </div>
    <footer className="desktop-template-footer">
      {panel === 'apply' && <p className="desktop-template-footer-note">{!prepared.error && (widgets || sites) ? tr('本次新增 {0} 个组件、移动 {1} 个组件、追加 {2} 个网址，跳过 {3} 个重复网址。', [formatNumber(prepared.addedWidgets), formatNumber(prepared.movedWidgets), formatNumber(prepared.addedSites), formatNumber(prepared.skippedDuplicates)]) : tr('可撤销本次应用。')}</p>}
      <div className="desktop-template-footer-actions" style={{ marginInlineStart: 'auto' }}>
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{tr('取消')}</Button>
        {panel === 'apply' ? <Button type="button" disabled={busy || changed || Boolean(prepared.error) || (!appearance && !widgets && !sites)} onClick={() => run(async () => { if (!prepared.error && !changed) await onApply(prepared); })}>{busy ? tr('正在应用…') : tr('应用所选方案')}</Button> : <>
          <Button type="button" variant="secondary" disabled={busy || changed || !name.trim() || Boolean(captureError)} onClick={() => run(() => {
            const value = currentTemplate(), blob = new Blob([JSON.stringify(value)], { type: 'application/json' });
            if (blob.size > DESKTOP_TEMPLATE_MAX_BYTES) throw Error(tr('桌面方案不能超过 256 KB。'));
            const url = URL.createObjectURL(blob), anchor = document.createElement('a');
            anchor.href = url; anchor.download = `${value.name.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').slice(0, 80)}.json`; anchor.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          })}><DownloadSimple size={16} />{tr('导出分享文件')}</Button>
          <Button type="button" disabled={busy || changed || !name.trim() || Boolean(captureError)} onClick={() => run(async () => { const record = await saveDesktopTemplate(name, currentTemplate()); await reloadSaved(); choose(record.template, record.id); })}><FloppyDisk size={16} />{tr('保存当前桌面')}</Button>
        </>}
      </div>
    </footer>
    {pendingDelete && <PromptDialog title={tr('删除方案')} action={tr('确认删除')} destructive busy={busy} onCancel={() => setPendingDelete(null)} onConfirm={() => run(async () => { await deleteDesktopTemplate(pendingDelete); await reloadSaved(); choose(BUILTIN_DESKTOP_TEMPLATES[0], 'builtin-0'); })}><p>{tr('删除此方案？当前桌面不会改变。')}</p></PromptDialog>}
  </Tabs>;
}

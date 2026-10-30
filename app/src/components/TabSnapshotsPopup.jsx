import { useEffect, useMemo, useRef, useState } from 'react';
import { CaretRight, MagnifyingGlass, PencilSimple, PushPin, Trash, X } from '@phosphor-icons/react';
import { tr, getLocale, formatNumber } from '../i18n/index.js';
import usePersonalTools from '../lib/use-personal-tools.js';
import { deletePersonalRecord, renameTabSnapshot } from '../lib/personal-tools.js';
import { captureSnapshotFromPopup, restoreSnapshotFromPopup } from '../lib/tab-snapshot-runtime.js';
import PromptDialog, { MessageDialog } from './PromptDialog.jsx';
import { Button } from './ui/button.jsx';
import { Checkbox } from './ui/checkbox.jsx';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible.jsx';
import { Input } from './ui/input.jsx';
import { ScrollArea } from './ui/scroll-area.jsx';
import './ui/ui.css';

const date = (value) => new Date(value).toLocaleString(getLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const firstIndices = (item) => item.tabs.slice(0, 50).map((_, index) => index);

export default function TabSnapshotsPopup({ onBusyChange }) {
  const { data, core, error: loadError } = usePersonalTools();
  const [name, setName] = useState(''), [query, setQuery] = useState(''), [expanded, setExpanded] = useState(() => new Set());
  const [selection, setSelection] = useState(null), [prompt, setPrompt] = useState(null), [rename, setRename] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const gate = useRef(false), active = useRef(true), search = useRef(null);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const snapshots = useMemo(() => [...(data?.snapshots || [])].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    .filter((item) => !query.trim() || core?.contains(item.title, query.trim())
      || item.tabs.some((tab) => core?.contains(`${tab.title}\n${tab.url}`, query.trim()))), [data, core, query]);
  const selected = data?.snapshots.find((item) => item.id === selection?.id);
  const staleSelection = Boolean(data && selection && (!selected || selected.revision !== selection.revision));
  const target = data?.snapshots.find((item) => item.id === prompt?.id);
  const stalePrompt = Boolean(data && prompt && (!target || target.revision !== prompt.revision));
  useEffect(() => {
    if (busy || !staleSelection && !stalePrompt) return;
    setSelection(null); setPrompt(null); setError(tr('快照已在其他页面更新。'));
  }, [busy, staleSelection, stalePrompt]);
  async function run(operation) {
    if (gate.current) return;
    gate.current = true; setBusy(true); setError(''); onBusyChange(true);
    try { await operation(); }
    catch (reason) { if (active.current) { setPrompt(null); setError(reason.message || tr('快照操作未完成，请重试。')); } }
    finally { gate.current = false; if (active.current) { setBusy(false); onBusyChange(false); } }
  }
  function setSnapshotExpanded(id, open) {
    setExpanded((current) => { const next = new Set(current); if (open) next.add(id); else next.delete(id); return next; });
  }
  function selectSnapshot(item) {
    setSelection(selection?.id === item.id && selection.indices.length ? null : { id: item.id, revision: item.revision, indices: firstIndices(item) });
    setExpanded((current) => new Set(current).add(item.id));
  }
  function selectTab(item, index, checked) {
    const indices = selection?.id === item.id && selection.revision === item.revision ? selection.indices : [];
    if (checked && indices.length >= 50) return;
    setSelection({ id: item.id, revision: item.revision,
      indices: checked ? [...indices, index].sort((a, b) => a - b) : indices.filter((value) => value !== index) });
  }
  function edit(item) {
    setRename(item.title); setPrompt({ kind: 'rename', id: item.id, revision: item.revision, title: item.title });
  }
  function confirm() {
    if (!prompt || stalePrompt) return;
    run(async () => {
      if (prompt.kind === 'delete') await deletePersonalRecord('snapshots', prompt.id, prompt.revision);
      else if (prompt.kind === 'rename') await renameTabSnapshot(prompt.id, prompt.revision, rename);
      else await restoreSnapshotFromPopup(prompt.id, prompt.revision, prompt.indices);
      if (active.current) { setPrompt(null); setSelection(null); }
    });
  }
  return <section className="popup-snapshots" aria-label={tr('标签快照')}>
    <form className="popup-snapshot-capture" onSubmit={(event) => {
      event.preventDefault(); if (event.nativeEvent.isComposing) return;
      run(async () => {
        const item = await captureSnapshotFromPopup(name);
        if (active.current) { setName(''); setExpanded((current) => new Set(current).add(item.id)); }
      });
    }}>
      <label className="visually-hidden" htmlFor="popup-snapshot-name">{tr('快照名称')}</label>
      <Input id="popup-snapshot-name" value={name} maxLength={200} disabled={busy || !data} placeholder={tr('快照名称')} onChange={(event) => setName(event.target.value)} />
      <Button size="sm" type="submit" disabled={busy || !data}>{tr('保存当前窗口')}</Button>
    </form>
    <div className="popup-snapshot-search">
      <MagnifyingGlass size={16} aria-hidden="true" />
      <Input ref={search} type="search" value={query} maxLength={100} aria-label={tr('搜索标签快照')} placeholder={tr('搜索快照')} disabled={busy} onChange={(event) => { setQuery(event.target.value); setSelection(null); }} />
      {query && <Button variant="ghost" size="icon" aria-label={tr('清除搜索')} disabled={busy} onClick={() => { setQuery(''); setSelection(null); search.current?.focus(); }}><X size={14} /></Button>}
    </div>
    <ScrollArea className="popup-snapshot-scroll" hideScrollbars aria-busy={!data} viewportProps={{ role: 'region', 'aria-label': tr('快照列表') }}>
      {data ? <ul className="popup-snapshot-tree" aria-label={tr('快照列表')}>{snapshots.map((item) => {
        const indices = selection?.id === item.id && selection.revision === item.revision ? selection.indices : [];
        const open = expanded.has(item.id), all = indices.length > 0 && indices.length === Math.min(50, item.tabs.length);
        const selectionLabel = indices.length ? tr('取消选择') : item.tabs.length > 50 ? tr('选择前 50 个') : tr('全选');
        return <Collapsible key={item.id} asChild open={open} disabled={busy} onOpenChange={(next) => setSnapshotExpanded(item.id, next)}>
          <li className="popup-snapshot-group">
            <div className="popup-snapshot-row" data-selected={indices.length > 0}>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="icon" className="popup-snapshot-disclosure" aria-label={`${tr('快照内容')} ${item.title}`}><CaretRight size={13} weight="bold" /></Button>
              </CollapsibleTrigger>
              <Checkbox checked={all ? true : indices.length ? 'indeterminate' : false} disabled={busy} aria-label={`${selectionLabel} · ${item.title}`} title={selectionLabel} onCheckedChange={() => selectSnapshot(item)} />
              <CollapsibleTrigger asChild>
                <Button variant="ghost" className="popup-snapshot-title">
                  <strong title={item.title}>{item.title}</strong>
                  <small><span>{tr('{0} 个标签', [formatNumber(item.tabs.length)])}</span><time dateTime={new Date(item.createdAt).toISOString()} title={date(item.createdAt)}>{date(item.createdAt)}</time></small>
                </Button>
              </CollapsibleTrigger>
              <div className="popup-snapshot-row-actions">
                <Button variant="ghost" size="icon" disabled={busy} aria-label={`${tr('编辑')} · ${item.title}`} title={tr('编辑')} onClick={() => edit(item)}><PencilSimple size={15} /></Button>
                <Button variant="ghost" size="icon" disabled={busy} aria-label={`${tr('删除快照')} · ${item.title}`} title={tr('删除快照')} onClick={() => setPrompt({ kind: 'delete', id: item.id, revision: item.revision, title: item.title })}><Trash size={15} /></Button>
              </div>
            </div>
            <CollapsibleContent asChild>
              <ul className="popup-snapshot-tabs" aria-label={item.title}>{open && item.tabs.map((tab, index) => {
                const checked = indices.includes(index), disabled = busy || indices.length >= 50 && !checked;
                const host = new URL(tab.url).hostname, titleId = `snapshot-tab-title-${item.id}-${index}`, checkboxId = `snapshot-tab-${item.id}-${index}`;
                return <li key={index}>
                  <label className="popup-snapshot-tab" htmlFor={checkboxId} title={tab.url} data-selected={checked} data-disabled={disabled}>
                    <Checkbox id={checkboxId} checked={checked} disabled={disabled} aria-labelledby={titleId} onCheckedChange={(next) => selectTab(item, index, next === true)} />
                    <span className="popup-snapshot-tab-copy"><strong id={titleId}>{tab.title || host}</strong><small>{host}</small></span>
                    {tab.pinned && <PushPin className="popup-snapshot-pin" size={12} aria-hidden="true" />}
                  </label>
                </li>;
              })}</ul>
            </CollapsibleContent>
          </li>
        </Collapsible>;
      })}</ul> : <div className="popup-snapshot-loading" aria-hidden="true"><i /><i /><i /></div>}
      {data && !snapshots.length && <p className="popup-snapshot-empty">{query ? tr('无搜索结果') : tr('暂无快照')}</p>}
    </ScrollArea>
    <footer className="popup-snapshot-footer">
      <span aria-live="polite">{selection?.indices.length ? tr('{0} 个已选', [formatNumber(selection.indices.length)]) : ''}</span>
      <Button size="sm" disabled={busy || staleSelection || !selection?.indices.length} onClick={() => setPrompt({ kind: 'restore', ...selection })}>{tr('恢复所选')}</Button>
    </footer>
    {prompt && <PromptDialog title={prompt.kind === 'rename' ? tr('编辑') : prompt.kind === 'delete' ? tr('删除快照') : tr('确认恢复')}
      action={prompt.kind === 'rename' ? tr('保存') : prompt.kind === 'delete' ? tr('删除') : tr('打开')} busy={busy} destructive={prompt.kind === 'delete'}
      confirmDisabled={stalePrompt || prompt.kind === 'rename' && !rename.trim()} onCancel={() => setPrompt(null)} onConfirm={confirm}>
      {prompt.kind === 'rename' ? <div className="form-stack"><label>{tr('快照名称')}<Input value={rename} maxLength={200} disabled={busy} onChange={(event) => setRename(event.target.value)} onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing && rename.trim()) { event.preventDefault(); confirm(); }
      }} /></label></div> : <p>{prompt.kind === 'delete' ? tr('删除“{0}”？已打开的标签不受影响。', [prompt.title]) : tr('在新窗口打开所选 {0} 个标签？', [formatNumber(prompt.indices.length)])}</p>}
    </PromptDialog>}
    <MessageDialog message={loadError || error} onClose={() => setError('')} />
  </section>;
}

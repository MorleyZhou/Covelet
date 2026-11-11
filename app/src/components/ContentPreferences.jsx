import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { tr, getLocale } from '../i18n/index.js';
import { deleteContentTag, getContentMetadata, getContentTags, getPrivacyLockStatus, loadContentPreferences, renameContentTag, saveContentSettings } from '../lib/content-preferences.js';
import { PresentationContext } from '../lib/presentation.js';
import { userErrorMessage } from '../lib/user-error.js';
import ContentMetadataEditor from './ContentMetadataEditor.jsx';
import PrivacyPasswordDialog from './PrivacyPassword.jsx';
import PromptDialog from './PromptDialog.jsx';
import { Button } from './ui/button.jsx';
import { Input } from './ui/input.jsx';
import Select from './Select.jsx';
import { Checkbox } from './ui/checkbox.jsx';

function contentSettings(preferences, key) {
  return { alias: preferences.aliases[key] || '', private: preferences.privateKeys.includes(key), ...getContentMetadata(preferences, key) };
}
const sameSettings = (left, right) => left.alias === right.alias && left.private === right.private
  && left.description === right.description && left.tagIds.length === right.tagIds.length && left.tagIds.every((id) => right.tagIds.includes(id));

function ContentTagManager({ preferences, disabled, onBusyChange, onPreferencesChange }) {
  const tags = getContentTags(preferences);
  const [selected, setSelected] = useState(''), [draft, setDraft] = useState(null), [deleting, setDeleting] = useState(false), [error, setError] = useState('');
  const pending = useRef(false), tag = tags.find((item) => item.id === selected), name = draft?.name ?? tag?.name ?? '';
  async function update(remove = false) {
    if (!tag || disabled || pending.current || !remove && !name.trim()) return;
    pending.current = true; onBusyChange(true); setError('');
    try {
      const current = await loadContentPreferences(), currentTag = getContentTags(current).find((item) => item.id === selected);
      const originalName = remove ? deleting.name : draft?.originalName ?? tag.name;
      if (!currentTag || currentTag.name !== originalName) throw Error(tr('此标签已在其他页面更新，请重新选择。'));
      const next = remove ? await deleteContentTag(selected, { expectedRevision: current.revision })
        : await renameContentTag(selected, name.trim(), { expectedRevision: current.revision });
      onPreferencesChange(next, remove ? { deletedTagId: selected } : undefined); setDraft(null); setDeleting(false);
      if (remove) setSelected('');
    } catch (reason) { setError(userErrorMessage(reason)); }
    finally { pending.current = false; onBusyChange(false); }
  }
  return <details className="content-tag-manager">
    <summary>{tr('管理标签')}</summary>
    <div className="form-stack">
      <Select label={tr('选择标签')} value={tag ? selected : ''} options={[{ value: '', label: tr('选择标签') }, ...tags.map((item) => ({ value: item.id, label: item.name }))]}
        disabled={disabled} onChange={(value) => { setSelected(value); setDraft(null); setDeleting(false); setError(''); }} />
      {tag && <>
        <label>{tr('标签名称')}<Input value={name} maxLength={60} disabled={disabled} onChange={(event) => setDraft({ name: event.target.value, originalName: draft?.originalName ?? tag.name })}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); update(); } }} /></label>
        <div className="content-tag-manager-actions">
          <Button type="button" variant="secondary" disabled={disabled || !name.trim() || name.trim() === tag.name} onClick={() => update()}>{tr('重命名标签')}</Button>
          <Button type="button" variant="ghost" disabled={disabled} onClick={() => setDeleting({ name: tag.name })}>{tr('删除标签')}</Button>
        </div>
      </>}
      {error && !deleting && <p className="form-error" role="alert">{error}</p>}
    </div>
    {deleting && tag && <PromptDialog title={tr('删除标签')} action={tr('删除')} destructive busy={disabled} onCancel={() => setDeleting(false)} onConfirm={() => update(true)}>
      <p>{tr('删除此标签及所有内容中的关联？')}</p>
      {error && <p className="form-error" role="alert">{error}</p>}
    </PromptDialog>}
  </details>;
}

export default function ContentPreferences({ navigation, tools, preferences, initialKey, onClose, onBusyChange, onDirtyChange }) {
  const [query, setQuery] = useState(''), [selected, setSelected] = useState(initialKey || ''), [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false), [childBusy, setChildBusy] = useState(false), [error, setError] = useState('');
  const [ownPreferences, setOwnPreferences] = useState(null), [pendingSelection, setPendingSelection] = useState(null);
  const [passwordConfigured, setPasswordConfigured] = useState(false), [passwordDialog, setPasswordDialog] = useState(false);
  const presentation = useContext(PresentationContext), pending = useRef(false), busy = saving || childBusy;
  const currentPreferences = ownPreferences && ownPreferences.revision > preferences.revision ? ownPreferences : preferences;
  const locked = presentation.active || currentPreferences.presentation;
  useEffect(() => { let active = true; getPrivacyLockStatus().then(({ configured }) => { if (active) setPasswordConfigured(configured); }).catch((reason) => { if (active) setError(userErrorMessage(reason)); }); return () => { active = false; }; }, [presentation.active]);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  const items = useMemo(() => [
    ...navigation.entries.map((item) => ({ key: `${item.type}:${item.id}`, title: item.name, type: item.type === 'site' ? tr('网站') : item.type === 'folder' ? tr('文件夹') : tr('桌面组件') })),
    ...(tools?.notes || []).map((item) => ({ key: `note:${item.id}`, title: item.title, type: tr('便笺') })),
    ...(tools?.reading || []).map((item) => ({ key: `reading:${item.id}`, title: item.title, type: tr('稍后读') })),
  ], [navigation, tools, getLocale()]);
  const visibleItems = locked ? items.filter((item) => !presentation.hiddenKeys.has(item.key) && !currentPreferences.privateKeys.includes(item.key)) : items;
  const selectedHidden = locked && (presentation.hiddenKeys.has(selected) || currentPreferences.privateKeys.includes(selected));
  useEffect(() => { if (selectedHidden) { setQuery(''); setError(''); setPendingSelection(null); } }, [selectedHidden]);
  const matches = visibleItems.filter((item) => !query || `${item.title} ${item.type}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const selectedItem = visibleItems.find((item) => item.key === selected);
  const options = [{ value: '', label: tr('选择内容') }, ...[...(selectedItem && !matches.includes(selectedItem) ? [selectedItem] : []), ...matches].map((item) => ({ value: item.key, label: `${item.type} · ${item.title}` }))];
  const original = contentSettings(currentPreferences, selected);
  const current = draft?.key === selected ? draft : { key: selected, value: original, original };
  const dirty = !sameSettings(current.value, current.original);
  const metadataSupported = /^(site|note|reading):/.test(selected);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  function patch(value) { setDraft({ ...current, value: { ...current.value, ...value } }); }
  function receivePreferences(next, { deletedTagId } = {}) {
    setOwnPreferences(next);
    if (deletedTagId) setDraft((previous) => previous && { ...previous,
      value: { ...previous.value, tagIds: previous.value.tagIds.filter((id) => id !== deletedTagId) },
      original: { ...previous.original, tagIds: previous.original.tagIds.filter((id) => id !== deletedTagId) } });
  }
  function choose(value) { setSelected(value); setDraft(null); setError(''); }
  function close() { if (dirty) setPendingSelection({ close: true }); else onClose(); }
  return <form className="form-stack" onSubmit={async (event) => {
    event.preventDefault();
    if (!selectedItem || busy || pending.current || passwordDialog || selectedHidden) return;
    pending.current = true; setSaving(true); setError('');
    try {
      const latest = await loadContentPreferences();
      if (!sameSettings(contentSettings(latest, selected), current.original)) throw Error(tr('此内容已在其他页面更新，请重新打开。'));
      const value = metadataSupported ? current.value : { alias: current.value.alias, private: current.value.private };
      await saveContentSettings(selected, value, { expectedRevision: latest.revision,
        ...(metadataSupported ? { expectedMetadata: { description: current.original.description, tagIds: current.original.tagIds } } : {}) });
      onClose();
    } catch (reason) { setError(userErrorMessage(reason)); }
    finally { pending.current = false; setSaving(false); onBusyChange?.(false); }
  }}>
    <label>{tr('筛选内容')}<Input value={query} maxLength={100} disabled={busy} onChange={(event) => setQuery(event.target.value)} /></label>
    <Select label={tr('选择内容')} value={selectedHidden ? '' : selected} options={options} disabled={busy}
      onChange={(value) => { if (dirty) setPendingSelection({ key: value }); else choose(value); }} />
    {selectedHidden ? <Button type="button" variant="secondary" onClick={() => setPasswordDialog('unlock')}>{tr('输入密码查看隐藏内容')}</Button> : <>
      <label>{tr('搜索别名')}<Input value={current.value.alias} maxLength={200} disabled={!selectedItem || selected.startsWith('widget:') || busy}
        placeholder={tr('例如：报销 财务 bx')} onChange={(event) => patch({ alias: event.target.value })} /></label>
      {selectedItem && metadataSupported && <ContentMetadataEditor key={selected} contentKey={selected} preferences={currentPreferences}
        value={current.value} allowDescription={!selected.startsWith('note:')} disabled={busy} onChange={patch}
        onBusyChange={setChildBusy} onPreferencesChange={receivePreferences} />}
      <label className="content-private-check"><Checkbox checked={current.value.private} disabled={!selectedItem || busy} onCheckedChange={(value) => patch({ private: value === true })} />{tr('开启隐藏时锁定此内容')}</label>
    </>}
    {locked ? <Button type="button" variant="ghost" disabled={busy} onClick={() => setPasswordDialog('unlock')}>{tr('解锁后管理标签')}</Button>
      : <ContentTagManager preferences={currentPreferences} disabled={busy} onBusyChange={setChildBusy} onPreferencesChange={receivePreferences} />}
    <div className="content-privacy-password"><p className="hint">{tr('首次开启隐藏需设置密码，关闭隐藏需验证密码。')}</p>
      {passwordConfigured && <Button variant="secondary" type="button" disabled={busy} onClick={() => setPasswordDialog('change')}>{tr('修改隐藏密码')}</Button>}</div>
    {error && !selectedHidden && <p className="form-error" role="alert">{error}</p>}
    <div className="modal-footer"><Button variant="secondary" type="button" className="button" disabled={busy} onClick={close}>{tr('取消')}</Button><Button type="submit" className="button primary" disabled={!selectedItem || busy || selectedHidden}>{tr('保存')}</Button></div>
    {passwordDialog && <PrivacyPasswordDialog purpose={passwordDialog} onClose={() => setPasswordDialog(false)} />}
    {pendingSelection && <PromptDialog title={tr('放弃修改')} action={tr('放弃修改')} destructive busy={busy} onCancel={() => setPendingSelection(null)} onConfirm={() => {
      if (pendingSelection.close) onClose(); else choose(pendingSelection.key);
      setPendingSelection(null);
    }}><p>{tr('当前内容尚未保存，放弃修改？')}</p></PromptDialog>}
  </form>;
}

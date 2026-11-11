import { useContext, useEffect, useId, useRef, useState } from 'react';
import { Tag } from '@phosphor-icons/react';
import { tr } from '../i18n/index.js';
import { createContentTag, getContentMetadata, getContentTags, loadContentPreferences, saveContentMetadata } from '../lib/content-preferences.js';
import { PresentationContext } from '../lib/presentation.js';
import { userErrorMessage } from '../lib/user-error.js';
import { Button } from './ui/button.jsx';
import { Checkbox } from './ui/checkbox.jsx';
import { Input } from './ui/input.jsx';
import { Textarea } from './ui/textarea.jsx';
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover.jsx';
import { useFloatingContainer } from './DialogSurface.jsx';
import './content-metadata.css';

const emptyMetadata = { description: '', tagIds: [] };

export function ContentTagFilter({ preferences, selectedTagIds = [], onChange, availableTagIds, disabled = false, onReturnFocus }) {
  const presentation = useContext(PresentationContext), container = useFloatingContainer(), [open, setOpen] = useState(false);
  const locked = presentation.active || preferences.presentation;
  const tags = getContentTags({ ...preferences, presentation: locked }, { hiddenKeys: locked ? presentation.hiddenKeys : undefined })
    .filter((tag) => !availableTagIds || availableTagIds.includes(tag.id));
  const visibleIds = tags.map((tag) => tag.id), visibleKey = visibleIds.join('\0');
  useEffect(() => {
    const selected = selectedTagIds.filter((id) => visibleIds.includes(id));
    if (selected.length !== selectedTagIds.length) onChange(selected);
    if (disabled || !visibleIds.length) setOpen(false);
  }, [visibleKey, selectedTagIds, disabled, onChange]);
  if (!tags.length && !selectedTagIds.length) return null;
  return <Popover open={open && !disabled} onOpenChange={setOpen}>
    <PopoverTrigger asChild><Button type="button" variant="ghost" size="sm" className="content-tag-filter-trigger" disabled={disabled}
      data-active={selectedTagIds.length > 0 || undefined} aria-label={selectedTagIds.length ? tr('标签筛选已开启') : tr('标签筛选')}>
      <Tag size={16} aria-hidden="true" />{tr('标签')}
    </Button></PopoverTrigger>
    {container && <PopoverContent container={container} className="content-tag-filter-panel" aria-label={tr('标签筛选')}
      onCloseAutoFocus={(event) => { if (onReturnFocus) { event.preventDefault(); onReturnFocus(); } }}
      onEscapeKeyDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
      <fieldset className="content-tag-filter" disabled={disabled}>
        <legend>{tr('标签')}</legend>
        <p className="hint">{tr('同时包含所选标签')}</p>
        <div className="content-tag-options">
          {tags.map((tag) => <label className="content-tag-option" key={tag.id}>
            <Checkbox checked={selectedTagIds.includes(tag.id)} onCheckedChange={(checked) => onChange(checked === true
              ? [...selectedTagIds, tag.id] : selectedTagIds.filter((id) => id !== tag.id))} />
            <span>{tag.name}</span>
          </label>)}
        </div>
        {selectedTagIds.length > 0 && <Button type="button" variant="ghost" size="sm" onClick={() => onChange([])}>{tr('清除标签筛选')}</Button>}
      </fieldset>
    </PopoverContent>}
  </Popover>;
}

export default function ContentMetadataEditor({ preferences, value = emptyMetadata, onChange, contentKey,
  allowDescription = true, disabled = false, onBusyChange, onPreferencesChange }) {
  const presentation = useContext(PresentationContext), descriptionId = useId(), tagNameId = useId();
  const [name, setName] = useState(''), [creating, setCreating] = useState(false), [error, setError] = useState('');
  const [createdPreferences, setCreatedPreferences] = useState(null), pending = useRef(false), nameInput = useRef(null);
  const [createdTags, setCreatedTags] = useState([]);
  const current = createdPreferences && createdPreferences.revision > preferences.revision ? createdPreferences : preferences;
  const locked = presentation.active || current.presentation;
  const hidden = locked && contentKey && (presentation.hiddenKeys.has(contentKey) || current.privateKeys.includes(contentKey));
  const visibleTags = getContentTags({ ...current, presentation: locked }, { hiddenKeys: locked ? presentation.hiddenKeys : undefined });
  const tags = [...visibleTags, ...createdTags.filter((tag) => current.library?.tags.some((item) => item.id === tag.id)
    && !visibleTags.some((item) => item.id === tag.id))];
  const tagIds = value.tagIds || [], blocked = disabled || creating || hidden;
  const knownTagIds = (current.library?.tags || []).map((tag) => tag.id), knownTagKey = knownTagIds.join('\0');
  useEffect(() => {
    if (blocked || pending.current) return;
    const remaining = tagIds.filter((id) => knownTagIds.includes(id));
    if (remaining.length !== tagIds.length) {
      onChange({ ...value, tagIds: remaining });
      onPreferencesChange?.(current);
    }
  }, [knownTagKey, tagIds, blocked, onChange, onPreferencesChange]);
  async function createTag() {
    if (blocked || pending.current || !name.trim() || tagIds.length >= 20) return;
    pending.current = true; setCreating(true); onBusyChange?.(true); setError('');
    try {
      const tag = await createContentTag(name.trim());
      const next = await loadContentPreferences();
      setCreatedTags((currentTags) => [...currentTags.filter((item) => item.id !== tag.id), tag]);
      setCreatedPreferences(next); onPreferencesChange?.(next);
      onChange({ ...value, tagIds: [...new Set([...tagIds, tag.id])] });
      setName('');
    } catch (reason) { setError(userErrorMessage(reason)); }
    finally { pending.current = false; setCreating(false); onBusyChange?.(false); setTimeout(() => nameInput.current?.focus({ preventScroll: true }), 0); }
  }
  if (hidden) return null;
  return <div className="content-metadata-editor" aria-busy={creating || undefined}>
    {allowDescription && <div className="content-metadata-description"><label htmlFor={descriptionId}>{tr('备注')}</label>
      <Textarea id={descriptionId} value={value.description || ''} maxLength={1000} rows={3} disabled={blocked}
        onChange={(event) => onChange({ ...value, description: event.target.value })} />
    </div>}
    <fieldset className="content-tag-picker" disabled={blocked}>
      <legend>{tr('标签')}</legend>
      {tags.length > 0 && <div className="content-tag-options">
        {tags.map((tag) => <label className="content-tag-option" key={tag.id}>
          <Checkbox checked={tagIds.includes(tag.id)} disabled={!tagIds.includes(tag.id) && tagIds.length >= 20}
            onCheckedChange={(checked) => onChange({ ...value, tagIds: checked === true
              ? [...tagIds, tag.id] : tagIds.filter((id) => id !== tag.id) })} />
          <span>{tag.name}</span>
        </label>)}
      </div>}
      <div className="content-tag-create">
        <Input ref={nameInput} id={tagNameId} value={name} maxLength={60} placeholder={tr('新标签名称')} aria-label={tr('新标签名称')}
          disabled={blocked || tagIds.length >= 20} onChange={(event) => { setName(event.target.value); setError(''); }} onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              event.preventDefault(); event.stopPropagation(); createTag();
            }
          }} />
        <Button type="button" variant="secondary" disabled={blocked || !name.trim() || tagIds.length >= 20} onClick={createTag}>{tr('添加标签')}</Button>
      </div>
      {tagIds.length >= 20 && <p className="hint">{tr('每项内容最多使用 20 个标签。')}</p>}
    </fieldset>
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}

export function SavedContentMetadataEditor({ contentKey, preferences, allowDescription = true, onClose, onBusyChange }) {
  const presentation = useContext(PresentationContext);
  const locked = presentation.active || preferences.presentation;
  const metadata = getContentMetadata({ ...preferences, presentation: locked }, contentKey, { hiddenKeys: locked ? presentation.hiddenKeys : undefined });
  const [draft, setDraft] = useState({ key: contentKey, value: metadata, original: metadata });
  const [saving, setSaving] = useState(false), [creatingTag, setCreatingTag] = useState(false), [error, setError] = useState('');
  const pending = useRef(false), busy = saving || creatingTag;
  const current = draft.key === contentKey ? draft : { key: contentKey, value: metadata, original: metadata };
  const hidden = locked && (presentation.hiddenKeys.has(contentKey) || preferences.privateKeys.includes(contentKey));
  function tagBusy(value) { setCreatingTag(value); onBusyChange?.(value); }
  return <form className="form-stack" onSubmit={async (event) => {
    event.preventDefault(); event.stopPropagation();
    if (busy || pending.current || hidden) return;
    pending.current = true; setSaving(true); onBusyChange?.(true); setError('');
    try {
      const latest = await loadContentPreferences(), before = getContentMetadata(latest, contentKey);
      if (before.description !== current.original.description || before.tagIds.length !== current.original.tagIds.length
        || before.tagIds.some((id) => !current.original.tagIds.includes(id))) throw Error(tr('此内容已在其他页面更新，请重新打开。'));
      await saveContentMetadata(contentKey, current.value, { expectedRevision: latest.revision, expectedMetadata: current.original });
      onClose?.();
    } catch (reason) { setError(userErrorMessage(reason)); }
    finally { pending.current = false; setSaving(false); onBusyChange?.(false); }
  }}>
    {hidden ? <Button type="button" variant="secondary" onClick={presentation.requestUnlock}>{tr('输入密码查看隐藏内容')}</Button>
      : <ContentMetadataEditor contentKey={contentKey} preferences={preferences} value={current.value} allowDescription={allowDescription} disabled={busy}
        onChange={(value) => setDraft({ ...current, value })} onBusyChange={tagBusy} />}
    {error && !hidden && <p className="form-error" role="alert">{error}</p>}
    <div className="modal-footer">
      <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>{tr('取消')}</Button>
      <Button type="submit" disabled={busy || hidden}>{tr('保存')}</Button>
    </div>
  </form>;
}

import { useContext, useEffect, useMemo, useState } from 'react';
import { tr, getLocale } from '../i18n/index.js';
import { getPrivacyLockStatus, saveContentSettings } from '../lib/content-preferences.js';
import { PresentationContext } from '../lib/presentation.js';
import PrivacyPasswordDialog from './PrivacyPassword.jsx';
import { Button } from './ui/button.jsx';
import { Input } from './ui/input.jsx';
import Select from './Select.jsx';
import { Checkbox } from './ui/checkbox.jsx';

export default function ContentPreferences({ navigation, tools, preferences, initialKey, onClose, onBusyChange }) {
  const [query, setQuery] = useState(''), [selected, setSelected] = useState(initialKey || ''), [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [privateDraft, setPrivateDraft] = useState(null);
  const [passwordConfigured, setPasswordConfigured] = useState(false), [passwordDialog, setPasswordDialog] = useState(false);
  const presentation = useContext(PresentationContext);
  useEffect(() => { let active = true; getPrivacyLockStatus().then(({ configured }) => { if (active) setPasswordConfigured(configured); }).catch((reason) => { if (active) setError(reason.message); }); return () => { active = false; }; }, [presentation.active]);
  const items = useMemo(() => [
    ...navigation.entries.map((item) => ({ key: `${item.type}:${item.id}`, title: item.name, type: item.type === 'site' ? tr('网站') : item.type === 'folder' ? tr('文件夹') : tr('桌面组件') })),
    ...(tools?.notes || []).map((item) => ({ key: `note:${item.id}`, title: item.title, type: tr('便笺') })),
    ...(tools?.reading || []).map((item) => ({ key: `reading:${item.id}`, title: item.title, type: tr('稍后读') })),
  ], [navigation, tools, getLocale()]);
  const visibleItems = presentation.active ? items.filter((item) => !presentation.hiddenKeys.has(item.key)) : items;
  const selectedHidden = presentation.active && presentation.hiddenKeys.has(selected);
  const matches = visibleItems.filter((item) => !query || `${item.title} ${item.type}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const selectedItem = visibleItems.find((item) => item.key === selected);
  const options = [{ value: '', label: tr('选择内容') }, ...[...(selectedItem && !matches.includes(selectedItem) ? [selectedItem] : []), ...matches].map((item) => ({ value: item.key, label: `${item.type} · ${item.title}` }))];
  const alias = draft ?? preferences.aliases[selected] ?? '';
  const privateValue = privateDraft ?? preferences.privateKeys.includes(selected);
  return <form className="form-stack" onSubmit={async (event) => {
    event.preventDefault(); if (!selected || busy || passwordDialog || selectedHidden) return;
    setBusy(true); onBusyChange?.(true); setError('');
    try { await saveContentSettings(selected, { alias, private: privateValue }); onClose(); } catch (reason) { setError(reason.message); } finally { setBusy(false); onBusyChange?.(false); }
  }}>
    <label>{tr('筛选内容')}<Input value={query} maxLength={100} disabled={busy} onChange={(event) => setQuery(event.target.value)} /></label>
    <Select label={tr('选择内容')} value={selected} options={options} disabled={busy} onChange={(value) => { setSelected(value); setDraft(null); setPrivateDraft(null); }} />
    {selectedHidden && <Button type="button" variant="secondary" onClick={() => setPasswordDialog('unlock')}>{tr('输入密码查看隐藏内容')}</Button>}
    <div className="form-stack" style={{ display: selectedHidden ? 'none' : 'contents' }} inert={selectedHidden || undefined} aria-hidden={selectedHidden || undefined}>
    <label>{tr('搜索别名')}<Input value={alias} maxLength={200} disabled={!selected || selected.startsWith('widget:') || busy} placeholder={tr('例如：报销 财务 bx')} onChange={(event) => setDraft(event.target.value)} /></label>
    <label className="content-private-check"><Checkbox checked={privateValue} disabled={!selected || busy} onCheckedChange={(value) => setPrivateDraft(value === true)} />{tr('开启隐藏时锁定此内容')}</label>
    </div>
    <div className="content-privacy-password"><p className="hint">{tr('首次开启隐藏需设置密码，关闭隐藏需验证密码。')}</p>
      {passwordConfigured && <Button variant="secondary" type="button" disabled={busy} onClick={() => setPasswordDialog('change')}>{tr('修改隐藏密码')}</Button>}</div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="modal-footer"><Button variant="secondary" type="button" className="button" disabled={busy} onClick={onClose}>{tr('取消')}</Button><Button type="submit" className="button primary" disabled={!selected || busy || selectedHidden}>{tr('保存')}</Button></div>
    {passwordDialog && <PrivacyPasswordDialog purpose={passwordDialog} onClose={() => setPasswordDialog(false)} />}
  </form>;
}

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatNumber, tr } from '../i18n/index.js';
import { folderLaunchSites, launchFolderSites, MAX_FOLDER_LAUNCH } from '../lib/folder-launch.js';
import { Button } from './ui/button.jsx';
import { Checkbox } from './ui/checkbox.jsx';
import './folder-launch.css';

export default function FolderLaunchDialog({ Dialog, folderId, entries, hiddenKeys, onClose }) {
  const choices = useMemo(() => folderLaunchSites(entries, folderId, hiddenKeys), [entries, folderId, hiddenKeys]);
  const currentChoices = useRef(choices);
  useLayoutEffect(() => { currentChoices.current = choices; }, [choices]);
  const [selected, setSelected] = useState(() => new Map(choices.slice(0, MAX_FOLDER_LAUNCH).map(({ id, url }) => [id, url])));
  const [openedIds, setOpenedIds] = useState(() => new Set());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false), opening = useRef(false);
  const pending = choices.filter(({ id }) => !openedIds.has(id));
  const selection = pending.filter(({ id, url }) => selected.get(id) === url);

  function toggle(site, checked) {
    setError('');
    setSelected((previous) => {
      const next = new Map(pending.filter(({ id, url }) => previous.get(id) === url).map(({ id, url }) => [id, url]));
      if (checked && next.size < MAX_FOLDER_LAUNCH) next.set(site.id, site.url);
      if (!checked) next.delete(site.id);
      return next;
    });
  }

  async function confirm() {
    if (opening.current || !selection.length) return;
    opening.current = true;
    setBusy(true);
    setError('');
    const { opened, failed } = await launchFolderSites(selection, (tab) => chrome.tabs.create(tab),
      (site) => currentChoices.current.some(({ id, url }) => id === site.id && url === site.url));
    opening.current = false;
    setBusy(false);
    if (!failed.length) { onClose(); return; }
    setOpenedIds((previous) => new Set([...previous, ...opened]));
    setError(tr('已打开 {0} 个网站，{1} 个未打开。', [formatNumber(opened.length), formatNumber(failed.length)]));
  }

  return <Dialog title={tr('批量打开网站')} className="folder-launch-dialog" privacyKeys={[`folder:${folderId}`]} onClose={onClose} closeDisabled={busy}>
    <div className="folder-launch-content" aria-busy={busy}>
      {pending.length ? <>
        <div className="folder-launch-summary">
          <p className="hint">{tr('最多打开 {0} 个网站。', [formatNumber(MAX_FOLDER_LAUNCH)])}</p>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => {
            setError('');
            setSelected(selection.length ? new Map() : new Map(pending.slice(0, MAX_FOLDER_LAUNCH).map(({ id, url }) => [id, url])));
          }}>{selection.length ? tr('清除选择') : pending.length <= MAX_FOLDER_LAUNCH ? tr('全选') : tr('选择前 {0} 个', [formatNumber(MAX_FOLDER_LAUNCH)])}</Button>
        </div>
        <ul className="folder-launch-list">
          {pending.map((site) => {
            const checked = selected.get(site.id) === site.url;
            return <li key={site.id}><label className="folder-launch-row">
              <Checkbox aria-label={tr('选择 {0}', [site.name])} checked={checked}
                disabled={busy || (!checked && selection.length >= MAX_FOLDER_LAUNCH)}
                onCheckedChange={(value) => toggle(site, value === true)} />
              <span className="folder-launch-site"><strong dir="auto">{site.name}</strong><small dir="ltr" title={site.url}>{new URL(site.url).host}</small></span>
            </label></li>;
          })}
        </ul>
      </> : <p className="hint">{tr('没有可打开的网站。')}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-footer folder-launch-footer">
        <Button type="button" variant="secondary" data-autofocus disabled={busy} onClick={onClose}>{tr('取消')}</Button>
        <Button type="button" disabled={busy || !selection.length} onClick={confirm}>
          {busy ? tr('处理中…') : tr('打开 {0} 个网站', [formatNumber(selection.length)])}
        </Button>
      </div>
    </div>
  </Dialog>;
}

import { tr, getLocale } from "../i18n/index.js";
import { useEffect, useRef, useState } from 'react';
import { beginDesktopEdit, addDesktopScreen, removeDesktopScreen } from './desktop-edit.js';

export function useLayoutEdit(options) {
  const [session, setSession] = useState(null), [selectedIds, setSelectedIds] = useState([]);
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  const current = useRef(null), working = useRef(false), latest = useRef(options);
  latest.current = options;
  const update = (next) => { current.current = next; setSession(next); };
  const failed = (reason) => { setError(reason.message || tr("无法更新布局。")); return false; };

  function begin() {
    if (current.current || !latest.current.state || working.current) return;
    try {
      const { state, columns, activeKey } = latest.current, captured = beginDesktopEdit(state, columns);
      update({ draft: captured.state, revision: state.revision, previousKey: activeKey });
      setSelectedIds([]); setError(''); latest.current.onBegin?.();
      latest.current.onActiveChange(captured.keys.get(activeKey) || '0:0');
    } catch (reason) { latest.current.onError?.(reason.message); }
  }
  function replaceDraft(next, selection = selectedIds) {
    const original = current.current;
    if (!original || working.current) return;
    update({ ...original, draft: next }); setError('');
    setSelectedIds(selection.filter((id) => next.entries.some((entry) => entry.id === id && entry.parentId === null && !entry.detached)));
  }
  function addPage(requested) {
    const original = current.current;
    if (!original || working.current) return;
    if (requested !== undefined && original.draft.settings.pages.includes(requested)) {
      latest.current.onActiveChange(`${requested}:0`); return;
    }
    try {
      const { state, page } = addDesktopScreen(original.draft, latest.current.columns);
      replaceDraft(state); latest.current.onActiveChange(`${page}:0`);
    } catch (reason) { failed(reason); }
  }
  function removePage(key) {
    if (!current.current || working.current) return;
    try {
      const result = removeDesktopScreen(current.current.draft, key, latest.current.columns);
      replaceDraft(result.state); latest.current.onActiveChange(result.key);
    } catch (reason) { failed(reason); }
  }
  function cancel() {
    const original = current.current;
    if (!original || working.current) return;
    latest.current.onCancelDrag?.(); update(null); setSelectedIds([]); setError('');
    latest.current.onActiveChange(original.previousKey); latest.current.onEnd?.();
  }
  async function save() {
    const original = current.current;
    if (!original || working.current) return;
    if (latest.current.state.revision !== original.revision) { failed(Error(tr("导航已在其他页面更新，请退出编辑后重试。"))); return; }
    working.current = true; setSaving(true); setError(''); latest.current.onCancelDrag?.();
    try {
      await latest.current.onSave(original.draft, original.revision);
      update(null); setSelectedIds([]); latest.current.onEnd?.();
    } catch (reason) { failed(reason); }
    finally { working.current = false; setSaving(false); }
  }
  const actions = useRef({}); actions.current = { save, cancel };
  useEffect(() => {
    if (!session) return;
    const keydown = (event) => {
      if (event.defaultPrevented || event.isComposing || latest.current.blocked
        || event.target?.closest?.('input,textarea,select,[contenteditable=true],dialog,[data-popover]')) return;
      if (event.key === 'Enter' && event.target?.closest?.('[data-layout-control]')) return;
      if (!['Enter', 'Escape'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'Escape') actions.current.cancel(); else actions.current.save();
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [Boolean(session)]);
  const conflict = session && options.state?.revision !== session.revision;
  return { editing: Boolean(session), draft: session?.draft, selectedIds, setSelectedIds, saving,
    error: conflict ? tr("导航已在其他页面更新，请退出编辑后重试。") : error,
    conflict, begin, replaceDraft, addPage, removePage, cancel, save };
}

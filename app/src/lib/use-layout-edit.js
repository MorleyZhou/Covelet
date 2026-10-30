import { tr } from "../i18n/index.js";
import { useEffect, useRef, useState } from 'react';
import { beginDesktopEdit, addDesktopScreen, removeDesktopScreen } from './desktop-edit.js';
import { createLayoutHistory, updateLayoutHistoryView, recordLayoutHistory, undoLayoutHistory, redoLayoutHistory,
  layoutHistoryScreen, layoutHistoryShortcut } from './layout-history.js';

export function useLayoutEdit(options) {
  const [session, setSession] = useState(null), [selectedIds, setSelectedIds] = useState([]);
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  const current = useRef(null), working = useRef(false), latest = useRef(options), selection = useRef([]);
  latest.current = options;
  const update = (next) => { current.current = next; setSession(next); };
  const failed = (reason) => { setError(reason.message || tr("无法更新布局。")); return false; };
  function selectIds(value) {
    const next = typeof value === 'function' ? value(selection.current) : value;
    selection.current = next; setSelectedIds(next);
  }
  function mutableSession() {
    if (!current.current || working.current) return null;
    if (latest.current.state?.revision !== current.current.revision) {
      failed(Error(tr("导航已在其他页面更新，请退出编辑后重试。"))); return null;
    }
    return current.current;
  }
  function currentView() { return { selectedIds: selection.current, activeKey: latest.current.activeKey }; }
  function restore(original, history) {
    const frame = history.present, key = layoutHistoryScreen(frame.draft, frame.activeKey, latest.current.columns);
    update({ ...original, draft: frame.draft, history: updateLayoutHistoryView(history, { activeKey: key }) });
    selectIds(frame.selectedIds); setError(''); latest.current.onActiveChange(key);
  }

  function begin() {
    if (current.current || !latest.current.state || working.current) return;
    try {
      const { state, columns, activeKey } = latest.current, captured = beginDesktopEdit(state, columns);
      const key = captured.keys.get(activeKey) || '0:0';
      const history = createLayoutHistory({ draft: captured.state, selectedIds: [], activeKey: key });
      update({ draft: history.present.draft, history, revision: state.revision, previousKey: activeKey });
      selectIds([]); setError(''); latest.current.onBegin?.();
      latest.current.onActiveChange(key);
    } catch (reason) { latest.current.onError?.(reason.message); }
  }
  function replaceDraft(next, selected = selection.current, activeKey = latest.current.activeKey) {
    const original = mutableSession();
    if (!original) return;
    const history = recordLayoutHistory(updateLayoutHistoryView(original.history, currentView()), { draft: next, selectedIds: selected, activeKey });
    restore(original, history);
  }
  function addPage(requested) {
    const original = mutableSession();
    if (!original) return;
    if (requested !== undefined && original.draft.settings.pages.includes(requested)) {
      latest.current.onActiveChange(`${requested}:0`); return;
    }
    try {
      const { state, page } = addDesktopScreen(original.draft, latest.current.columns);
      replaceDraft(state, selection.current, `${page}:0`);
    } catch (reason) { failed(reason); }
  }
  function removePage(key) {
    const original = mutableSession();
    if (!original) return;
    try {
      const result = removeDesktopScreen(original.draft, key, latest.current.columns);
      replaceDraft(result.state, selection.current, result.key);
    } catch (reason) { failed(reason); }
  }
  function moveHistory(direction) {
    const original = mutableSession();
    if (!original) return;
    const next = (direction === 'undo' ? undoLayoutHistory : redoLayoutHistory)(original.history, currentView());
    if (next === original.history) return;
    latest.current.onCancelDrag?.(); restore(original, next);
  }
  function undo() { moveHistory('undo'); }
  function redo() { moveHistory('redo'); }
  function cancel() {
    const original = current.current;
    if (!original || working.current) return;
    latest.current.onCancelDrag?.(); update(null); selectIds([]); setError('');
    latest.current.onActiveChange(original.previousKey); latest.current.onEnd?.();
  }
  async function save() {
    const original = current.current;
    if (!original || working.current) return;
    if (latest.current.state.revision !== original.revision) { failed(Error(tr("导航已在其他页面更新，请退出编辑后重试。"))); return; }
    working.current = true; setSaving(true); setError(''); latest.current.onCancelDrag?.();
    try {
      await latest.current.onSave(original.draft, original.revision);
      update(null); selectIds([]); latest.current.onEnd?.();
    } catch (reason) { failed(reason); }
    finally { working.current = false; setSaving(false); }
  }
  const actions = useRef({}); actions.current = { save, cancel, undo, redo };
  useEffect(() => {
    if (!session) return;
    const keydown = (event) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || latest.current.blocked
        || event.target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],dialog,[data-ui-modal],[data-popover]')) return;
      const historyAction = layoutHistoryShortcut(event);
      if (historyAction) { event.preventDefault(); event.stopPropagation(); actions.current[historyAction](); return; }
      if (event.key === 'Enter' && event.target?.closest?.('[data-layout-control]')) return;
      if (!['Enter', 'Escape'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'Escape') actions.current.cancel(); else actions.current.save();
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [Boolean(session)]);
  const conflict = session && options.state?.revision !== session.revision;
  return { editing: Boolean(session), draft: session?.draft, selectedIds, setSelectedIds: selectIds, saving,
    error: conflict ? tr("导航已在其他页面更新，请退出编辑后重试。") : error,
    conflict, canUndo: Boolean(session?.history.past.length) && !saving && !conflict,
    canRedo: Boolean(session?.history.future.length) && !saving && !conflict,
    begin, replaceDraft, addPage, removePage, undo, redo, cancel, save };
}

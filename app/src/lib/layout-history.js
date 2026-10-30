import { sameJson } from './json-equal.js';
import { layoutDesktop } from './desktop-layout.js';

export const LAYOUT_HISTORY_LIMIT = 50;

function selectionFor(draft, selectedIds = []) {
  const roots = new Set(draft.entries.filter((entry) => entry.parentId === null && !entry.detached).map((entry) => entry.id));
  return [...new Set(selectedIds)].filter((id) => roots.has(id));
}

function frameWithView(frame, view = {}) {
  return { draft: frame.draft, selectedIds: selectionFor(frame.draft, view.selectedIds ?? frame.selectedIds),
    activeKey: view.activeKey ?? frame.activeKey ?? '0:0' };
}

function capture(frame) {
  return frameWithView({ ...frame, draft: structuredClone(frame.draft) });
}

// History is deliberately scoped to one unsaved layout transaction. It never
// writes storage, runtime/widget records, sync operations or navigation revisions.
export function createLayoutHistory(frame, limit = LAYOUT_HISTORY_LIMIT) {
  return { past: [], present: capture(frame), future: [],
    limit: Math.max(1, Math.min(LAYOUT_HISTORY_LIMIT, Math.floor(limit) || LAYOUT_HISTORY_LIMIT)) };
}

export function updateLayoutHistoryView(history, view) {
  return { ...history, present: frameWithView(history.present, view) };
}

export function recordLayoutHistory(history, frame) {
  // Selection and screen navigation alone are not undo steps. In particular, a
  // structurally equal drop must not erase the redo branch.
  const before = { ...history.present.draft, revision: 0 }, after = { ...frame.draft, revision: 0 };
  if (sameJson(before, after)) return updateLayoutHistoryView(history, frame);
  return { ...history, past: [...history.past, history.present].slice(-history.limit), present: capture(frame), future: [] };
}

export function undoLayoutHistory(history, view) {
  if (!history.past.length) return history;
  const current = frameWithView(history.present, view);
  return { ...history, past: history.past.slice(0, -1), present: history.past.at(-1), future: [current, ...history.future] };
}

export function redoLayoutHistory(history, view) {
  if (!history.future.length) return history;
  const current = frameWithView(history.present, view);
  return { ...history, past: [...history.past, current].slice(-history.limit), present: history.future[0], future: history.future.slice(1) };
}

export function layoutHistoryScreen(draft, activeKey, columns) {
  const screens = layoutDesktop(draft.entries, columns, null, draft.settings.pages);
  if (screens.some((screen) => screen.key === activeKey)) return activeKey;
  const page = Number(String(activeKey).split(':')[0]);
  return screens.find((screen) => screen.page === page)?.key || screens[0]?.key || '0:0';
}

export function layoutHistoryShortcut(event) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey || !(event.ctrlKey || event.metaKey)
    || event.target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],dialog,[data-ui-modal],[data-popover]')) return null;
  const key = event.key?.toLowerCase();
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
  if (key === 'y' && event.ctrlKey && !event.metaKey && !event.shiftKey) return 'redo';
  return null;
}

import { tr, getLocale } from "../i18n/index.js";
import { migrateNavigationState, combineSelectedEntries, moveEntry } from './model.js';
import { DESKTOP_ROWS, MAX_DESKTOP_PAGE, desktopFootprint, layoutDesktop, freezeDesktopPositions, placeDesktopEntries, nextDesktopPage } from './desktop-layout.js';
import { remapDesktopPages, withDesktopPageIdentity } from './desktop-pages.js';

const visibleRoot = (entry) => entry.parentId === null && !entry.detached;
const copy = (value) => structuredClone(value);
const cellsFor = (anchor, size, columns) => Array.from({ length: size.rows }, (_, row) =>
  Array.from({ length: size.columns }, (_, column) => (anchor.row + row) * columns + anchor.column + column)).flat();

function seat(size, taken, columns, start = 0) {
  for (let slot = Math.max(0, start); slot < columns * DESKTOP_ROWS; slot++) {
    const anchor = { row: Math.floor(slot / columns), column: slot % columns };
    if (anchor.column + size.columns <= columns && anchor.row + size.rows <= DESKTOP_ROWS
      && cellsFor(anchor, size, columns).every((cell) => !taken.has(cell))) return anchor;
  }
  return null;
}

function folderPages(entries) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const entry of entries) if (entry.parentId && byId.has(entry.parentId)) {
    entry.page = byId.get(entry.parentId).page ?? 0;
    delete entry.position;
  }
}

function normalizeDraft(input, columns) {
  const state = copy(input);
  state.settings.pages = [...new Set([...state.settings.pages,
    ...state.entries.filter(visibleRoot).map((entry) => entry.page ?? 0)])].sort((a, b) => a - b);
  const roots = layoutDesktop(state.entries, columns, null, state.settings.pages).flatMap((screen) => screen.items);
  roots.push(...state.entries.filter((entry) => entry.parentId === null && entry.detached).sort((a, b) => a.order - b.order));
  roots.forEach((entry, order) => { state.entries.find((item) => item.id === entry.id).order = order; });
  folderPages(state.entries);
  return migrateNavigationState(state);
}

// Capture exactly the displayed screens once when entering the transaction.
// This also gives responsive overflow screens their own editable page identity.
export function beginDesktopEdit(input, columns) {
  const state = copy(input), byId = new Map(state.entries.map((entry) => [entry.id, entry]));
  const screens = layoutDesktop(state.entries, columns, null, state.settings.pages), keys = new Map();
  const mapping = new Map();
  if (screens.length > MAX_DESKTOP_PAGE + 1) throw Error(tr("主屏幕数量已达上限。"));
  screens.forEach((screen, page) => {
    keys.set(screen.key, `${page}:0`);
    if (screen.key === `${screen.page}:0`) mapping.set(screen.page, page);
    for (const item of screen.items) {
      const entry = byId.get(item.id), placement = screen.placements.get(item.id);
      entry.page = page; entry.position = { row: placement.row - 1, column: placement.column - 1 };
    }
  });
  state.settings.pages = screens.map((_, index) => index);
  remapDesktopPages(state.settings, mapping);
  folderPages(state.entries);
  return { state: normalizeDraft(state, columns), keys };
}

export function renameDesktopPage(input, page, title) {
  if (!input.settings.pages.includes(page)) throw Error(tr('这一屏已发生变化，请重新打开屏幕管理。'));
  if (typeof title !== 'string' || title.length > 200 || /[\u0000-\u001f\u007f]/u.test(title)) throw Error(tr('名称无效'));
  const name = title.trim();
  if ((input.settings.desktopPages?.[page]?.name || '') === name) return input;
  const state = copy(input);
  state.settings = withDesktopPageIdentity(state.settings, page);
  if (name) state.settings.desktopPages[page].name = name;
  else delete state.settings.desktopPages[page].name;
  return migrateNavigationState(state);
}

export function addDesktopScreen(input, columns) {
  const state = copy(input), page = nextDesktopPage(state.entries, state.settings.pages);
  if (page === null) throw Error(tr("主屏幕数量已达上限。"));
  state.settings.pages.push(page);
  return { state: normalizeDraft(state, columns), page };
}

// Trash is a draft-only deletion. Folder contents are included explicitly in
// the confirmation; no widget runtime or persistent configuration is touched.
export function deleteDesktopEntries(input, ids, columns) {
  const roots = new Set(ids.filter((id) => input.entries.some((entry) => entry.id === id && visibleRoot(entry))));
  if (!roots.size) throw Error(tr("所选项目已发生变化，请重新选择。"));
  return normalizeDraft({ ...copy(input), entries: input.entries.filter((entry) => !roots.has(entry.id) && !roots.has(entry.parentId)) }, columns);
}

// Removing a page unplaces widgets rather than deleting their record or data.
// Sites/folders append after the final navigation tile, without backfilling old
// holes before it. Only a full tail creates another page.
export function removeDesktopScreen(input, key, columns) {
  const captured = beginDesktopEdit(input, columns), state = captured.state;
  const screenKey = captured.keys.get(key);
  if (!screenKey) throw Error(tr("这一屏已发生变化，请重新打开屏幕管理。"));
  const page = Number(screenKey.split(':')[0]), pages = state.settings.pages;
  if (pages.length < 2) throw Error(tr("至少保留一屏。"));
  const source = state.entries.filter((entry) => visibleRoot(entry) && entry.page === page)
    .sort((a, b) => a.position.row - b.position.row || a.position.column - b.position.column);
  const moving = source.filter((entry) => entry.type !== 'widget'), movingIds = new Set(moving.map((entry) => entry.id));
  for (const widget of source.filter((entry) => entry.type === 'widget')) {
    widget.detached = true; widget.page = 0; delete widget.position;
  }
  const remaining = pages.filter((value) => value !== page), mapping = new Map(remaining.map((value, index) => [value, index]));
  for (const entry of state.entries) if (visibleRoot(entry) && !movingIds.has(entry.id)) entry.page = mapping.get(entry.page ?? 0) ?? 0;
  state.settings.pages = remaining.map((_, index) => index);
  remapDesktopPages(state.settings, mapping);
  let destination = state.settings.pages.at(-1);
  const tail = state.entries.filter((entry) => visibleRoot(entry) && !movingIds.has(entry.id) && entry.page === destination);
  let taken = new Set(tail.flatMap((entry) => cellsFor(entry.position, desktopFootprint(entry, columns), columns)));
  let cursor = Math.max(-1, ...tail.filter((entry) => entry.type !== 'widget').map((entry) => entry.position.row * columns + entry.position.column)) + 1;
  for (const entry of moving) {
    let anchor = seat({ rows: 1, columns: 1 }, taken, columns, cursor);
    if (!anchor) {
      if (destination >= MAX_DESKTOP_PAGE) throw Error(tr("主屏幕数量已达上限。"));
      destination = state.settings.pages.at(-1) + 1;
      state.settings.pages.push(destination); taken = new Set(); cursor = 0; anchor = { row: 0, column: 0 };
    }
    entry.page = destination; entry.position = anchor;
    taken.add(anchor.row * columns + anchor.column); cursor = anchor.row * columns + anchor.column + 1;
  }
  const focusPage = Math.min(page, remaining.length - 1);
  return { state: normalizeDraft(state, columns), key: `${focusPage}:0` };
}

function placeGroup(state, ids, target, columns) {
  state.entries = placeDesktopEntries(state.entries, ids, target.page, target, columns, { pageIds: state.settings.pages });
  return state;
}

export function applyDesktopDrop(input, ids, target, columns, makeId) {
  const selected = [...new Set(ids)], source = input.entries.find((entry) => entry.id === selected[0]);
  if (!source || !selected.length) throw Error(tr("没有可移动的项目，请重新选择。"));
  if (selected.length > 1 && selected.some((id) => !input.entries.some((entry) => entry.id === id && visibleRoot(entry)))) throw Error(tr("只能多选桌面上的项目。"));
  const destination = input.entries.find((entry) => entry.id === target.id);
  const pages = new Set([...selected.map((id) => input.entries.find((entry) => entry.id === id)?.page ?? 0), destination?.page ?? target.page ?? 0]);
  const frozen = freezeDesktopPositions(input.entries, columns, pages, input.settings.pages);
  let state = { ...copy(input), entries: frozen.entries };
  state.settings.pages = [...new Set([...state.settings.pages, ...frozen.pageMap.values()])].sort((a, b) => a - b);
  const page = frozen.pageMap.get(target.key) ?? target.page ?? destination?.page ?? 0;
  let revealId = selected[0];
  if (target.kind === 'combine') {
    if (selected.includes(target.id) || selected.some((id) => state.entries.find((entry) => entry.id === id)?.type !== 'site')) throw Error(tr("只有网站可以合并到文件夹。"));
    const folderId = destination?.type === 'folder' ? destination.id : makeId();
    state = combineSelectedEntries(state, selected, target.id, { folderId });
    revealId = folderId;
  } else if (selected.length === 1) {
    if (target.kind === 'place') {
      // A root's original seat is needed for insertion/rotation. moveEntry
      // deliberately removes it, so use that container transition only when
      // taking a site out of a folder.
      if (source.parentId !== null) state = moveEntry(state, source.id, { parentId: null, page });
      state.entries = placeDesktopEntries(state.entries, selected, page, target, columns, { pageIds: state.settings.pages });
    } else state = moveEntry(state, source.id, { parentId: target.parentId, index: target.index, page });
  } else if (target.parentId) {
    for (const id of selected) state = moveEntry(state, id, { parentId: target.parentId });
  } else {
    let anchor = target;
    if (target.kind !== 'place') {
      const screen = layoutDesktop(state.entries.filter((entry) => !selected.includes(entry.id)), columns, null, state.settings.pages).find((item) => item.page === page);
      const taken = new Set((screen?.items || []).flatMap((entry) => {
        const position = screen.placements.get(entry.id);
        return cellsFor({ row: position.row - 1, column: position.column - 1 }, desktopFootprint(entry, columns), columns);
      }));
      anchor = seat(desktopFootprint(source, columns), taken, columns) || { row: 0, column: 0 };
    }
    state = placeGroup(state, selected, { ...anchor, page }, columns);
  }
  return { state: normalizeDraft(state, columns), revealId };
}

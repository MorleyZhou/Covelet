import { tr, getLocale } from "../i18n/index.js";
export const DESKTOP_ROWS = 6;
export const MAX_DESKTOP_PAGE = 1999;
// Dimensions are rows × columns, matching the size picker.
export const WIDGET_SIZES = Object.freeze({
  mini: Object.freeze({ rows: 1, columns: 1 }),
  small: Object.freeze({ rows: 2, columns: 2 }),
  medium: Object.freeze({ rows: 2, columns: 4 }),
  large: Object.freeze({ rows: 4, columns: 4 }),
});

export function desktopFootprint(entry, columns) {
  const size = entry.type === 'widget' ? WIDGET_SIZES[entry.config.size] : { rows: 1, columns: 1 };
  return { rows: size.rows, columns: Math.min(columns, size.columns) };
}

// A page is saved on the entry. Narrow windows can create temporary overflow
// screens without rewriting the user's page assignments or column preference.
// Explicit positions reserve their cells first. Unpositioned legacy/new items
// fill available cells; resizing only changes rendering, never saved positions.
export function layoutDesktop(entries, columns, draftPage = null, pageIds = []) {
  if (!Number.isInteger(columns) || columns < 1 || columns > 12) throw new Error(tr("桌面列数无效。"));
  const roots = entries.filter((entry) => entry.parentId === null && !entry.detached).sort((a, b) => a.order - b.order);
  const groups = new Map((pageIds.length ? pageIds : [0]).map((page) => [page, []]));
  for (const entry of roots) {
    const page = entry.page ?? 0;
    if (!Number.isInteger(page) || page < 0 || page > MAX_DESKTOP_PAGE) throw new Error(tr("主屏幕位置无效。"));
    if (!groups.has(page)) groups.set(page, []);
    groups.get(page).push(entry);
  }
  if (draftPage !== null && Number.isInteger(draftPage) && draftPage >= 0 && draftPage <= MAX_DESKTOP_PAGE && !groups.has(draftPage)) groups.set(draftPage, []);
  const screens = [];
  for (const [page, items] of [...groups].sort(([a], [b]) => a - b)) {
    let part = 0;
    let screen = { key: `${page}:0`, page, items: [], placements: new Map(), occupied: new Set() };
    screens.push(screen);
    const fits = (screen, slot, size) => slot >= 0 && slot % columns + size.columns <= columns
      && Math.floor(slot / columns) + size.rows <= DESKTOP_ROWS
      && Array.from({ length: size.rows }, (_, row) => Array.from({ length: size.columns }, (_, col) => slot + row * columns + col))
        .flat().every((value) => !screen.occupied.has(value));
    const put = (screen, entry, slot, size) => {
      for (let row = 0; row < size.rows; row++) for (let col = 0; col < size.columns; col++) screen.occupied.add(slot + row * columns + col);
      screen.items.push(entry);
      screen.placements.set(entry.id, { row: Math.floor(slot / columns) + 1, column: slot % columns + 1, ...size });
    };
    const pending = [];
    for (const entry of items) {
      const size = desktopFootprint(entry, columns);
      const position = entry.position;
      const slot = position ? position.row * columns + position.column : -1;
      if (position && position.column < columns && fits(screen, slot, size)) put(screen, entry, slot, size);
      else pending.push(entry);
    }
    for (const entry of pending) {
      const size = desktopFootprint(entry, columns);
      let slot = 0;
      while (slot < columns * DESKTOP_ROWS && !fits(screen, slot, size)) slot++;
      if (slot >= columns * DESKTOP_ROWS) {
        screen = { key: `${page}:${++part}`, page, items: [], placements: new Map(), occupied: new Set() };
        screens.push(screen); slot = 0;
      }
      put(screen, entry, slot, size);
    }
  }
  for (const screen of screens) {
    delete screen.occupied;
    screen.items.sort((a, b) => {
      const first = screen.placements.get(a.id), second = screen.placements.get(b.id);
      return first.row - second.row || first.column - second.column || a.order - b.order;
    });
  }
  return screens;
}

// On an intentional edit, capture displayed positions on the involved screens.
// Temporary responsive overflow becomes an ordinary page only at that point.
export function freezeDesktopPositions(entries, columns, pages, pageIds = []) {
  const result = structuredClone(entries), byId = new Map(result.map((entry) => [entry.id, entry]));
  const pageMap = new Map();
  let last = Math.max(0, ...pages, ...pageIds, ...result.filter((entry) => !entry.detached).map((entry) => entry.page ?? 0));
  for (const screen of layoutDesktop(entries, columns, null, pageIds)) {
    if (!pages.has(screen.page)) continue;
    let page = screen.page;
    if (!screen.key.endsWith(':0')) {
      if (last >= MAX_DESKTOP_PAGE) throw Error(tr("主屏幕数量已达上限。"));
      page = ++last;
    }
    pageMap.set(screen.key, page);
    for (const item of screen.items) {
      const entry = byId.get(item.id), placement = screen.placements.get(item.id);
      entry.page = page; entry.position = { row: placement.row - 1, column: placement.column - 1 };
    }
  }
  for (const entry of result) if (entry.parentId && byId.has(entry.parentId)) { entry.page = byId.get(entry.parentId).page ?? 0; delete entry.position; }
  return { entries: result, pageMap };
}

export function placeDesktopEntry(entries, id, page, position, columns, { lockedIds = [] } = {}) {
  const result = structuredClone(entries), entry = result.find((item) => item.id === id);
  if (!entry || entry.parentId !== null) throw Error(tr("只能在桌面放置图标和组件。"));
  const size = desktopFootprint(entry, columns);
  const wanted = { row: Math.max(0, Math.min(DESKTOP_ROWS - size.rows, position.row)), column: Math.max(0, Math.min(columns - size.columns, position.column)) };
  entry.page = page; entry.position = wanted;
  const occupied = new Set();
  const cells = (position, size) => Array.from({ length: size.rows }, (_, row) => Array.from({ length: size.columns }, (_, col) => (position.row + row) * columns + position.column + col)).flat();
  cells(wanted, size).forEach((slot) => occupied.add(slot));
  const locked = new Set(lockedIds);
  for (const item of result) if (item.id !== id && locked.has(item.id) && item.parentId === null && !item.detached && (item.page ?? 0) === page && item.position) {
    cells(item.position, desktopFootprint(item, columns)).forEach((slot) => occupied.add(slot));
  }
  const displaced = [];
  const neighbors = result.filter((item) => item.id !== id && !locked.has(item.id) && !item.detached && item.parentId === null && (item.page ?? 0) === page).sort((a, b) => a.order - b.order);
  for (const item of neighbors) {
    const footprint = desktopFootprint(item, columns), anchor = item.position;
    if (anchor && anchor.column + footprint.columns <= columns && anchor.row + footprint.rows <= DESKTOP_ROWS
      && cells(anchor, footprint).every((slot) => !occupied.has(slot))) cells(anchor, footprint).forEach((slot) => occupied.add(slot));
    else displaced.push(item);
  }
  let overflowPage = Math.max(0, ...result.map((item) => item.page ?? 0)), overflowOccupied = null;
  const findSeat = (footprint, taken) => {
    for (let slot = 0; slot < columns * DESKTOP_ROWS; slot++) {
      const possible = { row: Math.floor(slot / columns), column: slot % columns };
      if (possible.column + footprint.columns <= columns && possible.row + footprint.rows <= DESKTOP_ROWS
        && cells(possible, footprint).every((cell) => !taken.has(cell))) return possible;
    }
    return null;
  };
  for (const item of displaced) {
    const footprint = desktopFootprint(item, columns);
    const anchor = findSeat(footprint, occupied);
    if (anchor) { item.position = anchor; cells(anchor, footprint).forEach((slot) => occupied.add(slot)); }
    else {
      let overflowAnchor = overflowOccupied && findSeat(footprint, overflowOccupied);
      if (!overflowAnchor) {
        if (overflowPage >= MAX_DESKTOP_PAGE) throw Error(tr("主屏幕数量已达上限。"));
        overflowPage++; overflowOccupied = new Set(); overflowAnchor = { row: 0, column: 0 };
      }
      item.page = overflowPage; item.position = overflowAnchor;
      cells(overflowAnchor, footprint).forEach((slot) => overflowOccupied.add(slot));
    }
  }
  const byId = new Map(result.map((item) => [item.id, item]));
  for (const item of result) if (item.parentId && byId.has(item.parentId)) { item.page = byId.get(item.parentId).page ?? 0; delete item.position; }
  return result;
}

export function nextDesktopPage(entries, pageIds = []) {
  const last = Math.max(0, ...pageIds, ...entries.filter((entry) => entry.parentId === null && !entry.detached).map((entry) => entry.page ?? 0));
  return last < MAX_DESKTOP_PAGE ? last + 1 : null;
}

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

export function placeDesktopEntry(entries, id, page, position, columns, { lockedIds = [], pageIds = [] } = {}) {
  return placeDesktopEntries(entries, [id], page, position, columns, { lockedIds, pageIds });
}

// A same-page icon insertion rotates the occupied seats between source and
// destination. Larger widgets and deliberately empty cells retain their seats.
// Other drops push the stable visual sequence forward, never into the source's
// first empty cell (which would turn insertion into a two-icon swap).
export function placeDesktopEntries(entries, ids, page, position, columns, { lockedIds = [], pageIds = [] } = {}) {
  const result = structuredClone(entries), selected = new Set(ids), locked = new Set(lockedIds.filter((id) => !selected.has(id)));
  const root = (item) => item.parentId === null && !item.detached;
  const slotOf = (item) => item.position ? item.position.row * columns + item.position.column : Number.MAX_SAFE_INTEGER;
  const spatial = (a, b) => (a.page ?? 0) - (b.page ?? 0) || slotOf(a) - slotOf(b) || a.order - b.order;
  const moving = result.filter((item) => selected.has(item.id)).sort(spatial);
  if (!moving.length || moving.length !== selected.size || moving.some((item) => !root(item))) throw Error(tr("只能在桌面放置图标和组件。"));
  const cells = (anchor, size) => Array.from({ length: size.rows }, (_, row) => Array.from({ length: size.columns }, (_, col) => (anchor.row + row) * columns + anchor.column + col)).flat();
  const size = desktopFootprint(moving[0], columns);
  const wanted = { row: Math.max(0, Math.min(DESKTOP_ROWS - size.rows, position.row)), column: Math.max(0, Math.min(columns - size.columns, position.column)) };
  const wantedSlot = wanted.row * columns + wanted.column;
  const onDestination = result.filter((item) => root(item) && (item.page ?? 0) === page);
  const isUnit = (item) => { const size = desktopFootprint(item, columns); return size.rows === 1 && size.columns === 1; };
  const unitTarget = onDestination.find((item) => !selected.has(item.id) && isUnit(item) && slotOf(item) === wantedSlot);
  const fixedCollision = onDestination.some((item) => !selected.has(item.id) && !isUnit(item) && item.position
    && cells(item.position, desktopFootprint(item, columns)).includes(wantedSlot));
  if (moving.length === 1 && !locked.size && (moving[0].page ?? 0) === page && moving[0].position && isUnit(moving[0]) && unitTarget && !fixedCollision) {
    const icons = onDestination.filter((item) => isUnit(item) && item.position).sort(spatial);
    const seats = icons.map((item) => ({ ...item.position }));
    const sourceIndex = icons.findIndex((item) => item.id === moving[0].id), targetIndex = icons.findIndex((item) => item.id === unitTarget.id);
    const [source] = icons.splice(sourceIndex, 1); icons.splice(targetIndex, 0, source);
    icons.forEach((item, index) => { item.position = seats[index]; });
  } else {
    const occupied = new Map([[page, new Set()]]), overflowPages = [];
    let lastPage = Math.max(page, ...pageIds, ...result.map((item) => item.page ?? 0));
    const taken = (value) => { if (!occupied.has(value)) occupied.set(value, new Set()); return occupied.get(value); };
    const fits = (anchor, footprint, reserved) => anchor.row >= 0 && anchor.column >= 0
      && anchor.column + footprint.columns <= columns && anchor.row + footprint.rows <= DESKTOP_ROWS
      && cells(anchor, footprint).every((cell) => !reserved.has(cell));
    const findSeat = (footprint, reserved, start) => {
      for (let slot = Math.max(0, start); slot < columns * DESKTOP_ROWS; slot++) {
        const anchor = { row: Math.floor(slot / columns), column: slot % columns };
        if (fits(anchor, footprint, reserved)) return anchor;
      }
      return null;
    };
    const addPage = () => {
      if (lastPage >= MAX_DESKTOP_PAGE) throw Error(tr("主屏幕数量已达上限。"));
      const next = ++lastPage; overflowPages.push(next); taken(next); return next;
    };
    const put = (item, destination, anchor) => {
      item.page = destination; item.position = anchor;
      cells(anchor, desktopFootprint(item, columns)).forEach((cell) => taken(destination).add(cell));
    };
    for (const item of onDestination) if (locked.has(item.id) && item.position) cells(item.position, desktopFootprint(item, columns)).forEach((cell) => taken(page).add(cell));
    let destination = page, cursor = wantedSlot;
    // Reserve the entire selected stack before reflowing colliding neighbors.
    for (const [index, item] of moving.entries()) {
      const footprint = desktopFootprint(item, columns);
      let anchor = index === 0 && fits(wanted, footprint, taken(destination)) ? wanted : findSeat(footprint, taken(destination), cursor);
      if (!anchor) { destination = addPage(); anchor = { row: 0, column: 0 }; }
      put(item, destination, anchor); cursor = anchor.row * columns + anchor.column + footprint.columns;
    }
    const neighbors = onDestination.filter((item) => !selected.has(item.id) && !locked.has(item.id)).sort(spatial);
    let overflow = null, neighborCursor = 0, overflowIndex = 0;
    for (const item of neighbors) {
      const footprint = desktopFootprint(item, columns), originalSlot = slotOf(item);
      let anchor = overflow === null ? findSeat(footprint, taken(page), Math.max(neighborCursor, originalSlot === Number.MAX_SAFE_INTEGER ? neighborCursor : originalSlot)) : null;
      if (anchor) { put(item, page, anchor); neighborCursor = anchor.row * columns + anchor.column + 1; continue; }
      // Once a neighbor spills, later neighbors continue after it; they cannot
      // jump back into a small earlier hole and reverse the visual order.
      if (overflow === null) { overflow = overflowPages[overflowIndex] ?? addPage(); neighborCursor = 0; }
      anchor = findSeat(footprint, taken(overflow), neighborCursor);
      while (!anchor) {
        overflowIndex++; overflow = overflowPages[overflowIndex] ?? addPage(); neighborCursor = 0;
        anchor = findSeat(footprint, taken(overflow), neighborCursor);
      }
      put(item, overflow, anchor); neighborCursor = anchor.row * columns + anchor.column + 1;
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

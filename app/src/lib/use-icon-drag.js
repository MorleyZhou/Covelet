import { tr, getLocale } from "../i18n/index.js";
import { useEffect, useRef, useState } from 'react';
import { desktopFootprint, DESKTOP_ROWS } from './desktop-layout.js';
import { captureWidgetPreview } from './drag-preview.js';

// Pointer gestures keep links and controls intact. Icon centers group sites;
// other desktop areas accept free placement, while folders retain ordering.
export function useIconDrag({ state, page = 0, screenKey = `${page}:0`, editing = false, selectedIds = [], onSelect, onDrop, onCancel, onPageHover }) {
  const [drag, setDrag] = useState(null);
  const gesture = useRef(null);
  const latest = useRef({ state, page, onDrop, onCancel, onPageHover });
  const suppressClick = useRef(false);
  latest.current = { state, page, editing, selectedIds, onSelect, onDrop, onCancel, onPageHover };

  function publish(current) {
    setDrag({ item: current.item, items: current.items, ids: current.ids, x: current.x, y: current.y,
      target: current.target, previews: current.previews, previewAnchor: current.previewAnchor });
  }

  function clear() {
    const current = gesture.current;
    if (current) {
      clearTimeout(current.hold);
      clearTimeout(current.pageHold);
      if (current.active) suppressClick.current = true;
      try { current.element.releasePointerCapture(current.pointerId); } catch { /* Already released. */ }
    }
    gesture.current = null;
    setDrag(null);
  }

  function pageTarget(element, current) {
    let index = element.dataset.dropIndex === undefined ? undefined : Number(element.dataset.dropIndex);
    if (index !== undefined && current.item.parentId === null && current.item.order < index) index--;
    return { kind: 'move', parentId: null, page: Number(element.dataset.page), index,
      key: element.dataset.pageKey, create: element.hasAttribute('data-page-new'), label: tr("移到另一屏") };
  }

  function hoverPage(x, y, current) {
    const element = document.elementFromPoint(x, y)?.closest('[data-page-switch]');
    if (!element || element.disabled) {
      clearTimeout(current.pageHold); current.hoverRegion = null; current.pageTarget = null;
      return;
    }
    // A screen transition changes the edge's destination. Keep the original
    // destination until the pointer leaves, so releasing never skips two screens.
    if (current.hoverRegion === element.dataset.pageSwitch) return;
    clearTimeout(current.pageHold);
    current.hoverRegion = element.dataset.pageSwitch;
    current.pageTarget = pageTarget(element, current);
    current.pageHold = setTimeout(() => {
      if (gesture.current === current && current.active) latest.current.onPageHover?.(current.pageTarget);
    }, 550);
  }

  function targetAt(x, y, current) {
    const hit = document.elementFromPoint(x, y);
    if (!hit) return null;
    const trash = hit.closest('[data-layout-trash]');
    if (latest.current.editing && trash && !trash.disabled) return { kind: 'delete', label: tr("松开删除") };
    const pageSwitch = hit.closest('[data-page-switch]');
    if (pageSwitch && !pageSwitch.disabled) return current.pageTarget || pageTarget(pageSwitch, current);
    const folderPanel = document.querySelector('[data-folder-panel]');
    if (current.item.parentId && folderPanel && (!folderPanel.contains(hit) || hit.closest('[data-drop-root]'))) {
      return { kind: 'move', parentId: null, page: latest.current.page, label: tr("移到桌面") };
    }
    const freeTarget = () => {
      const grid = hit.closest('[data-grid-columns]');
      if (!grid) return null;
      const rect = grid.getBoundingClientRect(), style = getComputedStyle(grid), columns = Number(grid.dataset.gridColumns);
      const gap = parseFloat(style.columnGap) || 0, rowGap = parseFloat(style.rowGap) || 0;
      const width = (rect.width - (columns - 1) * gap) / columns, height = parseFloat(style.gridAutoRows);
      const size = desktopFootprint(current.item, columns);
      return { kind: 'place', parentId: null, page: Number(grid.dataset.page), key: grid.dataset.pageKey,
        row: Math.max(0, Math.min(DESKTOP_ROWS - size.rows, Math.floor((y - rect.top) / (height + rowGap)) - current.grabRow)),
        column: Math.max(0, Math.min(columns - size.columns, Math.floor((x - rect.left) / (width + gap)) - current.grabColumn)), label: tr("放置到这里") };
    };
    const tile = hit.closest('[data-entry-id]');
    if (tile) {
      const target = latest.current.state.entries.find((item) => item.id === tile.dataset.entryId);
      if (!target) return null;
      if (current.ids.includes(target.id)) return target.parentId === null ? freeTarget() : null;
      const icon = tile.querySelector('.site-icon')?.getBoundingClientRect() ?? tile.getBoundingClientRect();
      const center = Math.abs(x - (icon.left + icon.width / 2)) < icon.width * .36
        && Math.abs(y - (icon.top + icon.height / 2)) < icon.height * .4;
      if (center && current.items.every((item) => item.type === 'site') && target.type !== 'widget' && target.parentId === null
        && (target.type === 'folder' || current.item.parentId === null)) {
        return { kind: 'combine', id: target.id, label: target.type === 'folder' ? tr("放入「{0}」", [target.name]) : tr("合并为文件夹") };
      }
      if (target.parentId === null) return freeTarget();
      if ((target.parentId ?? null) !== (current.item.parentId ?? null)) return null;
      const after = x > icon.left + icon.width / 2;
      let index = target.order + Number(after);
      if (current.item.order < index) index--;
      return { kind: 'move', id: target.id, parentId: target.parentId ?? null, page: target.page ?? 0, index, side: after ? 'after' : 'before', label: tr("调整顺序") };
    }
    const grid = hit.closest('[data-drop-parent]');
    if (grid) {
      const parentId = grid.dataset.dropParent || null;
      if (parentId === null) return freeTarget();
      let index = grid.dataset.dropIndex === undefined ? undefined : Number(grid.dataset.dropIndex);
      if (index !== undefined && current.item.parentId === parentId && current.item.order < index) index--;
      return { kind: 'move', parentId, page: Number(grid.dataset.page || latest.current.page), index, label: tr("放到末尾") };
    }
    return null;
  }

  function activate(current) {
    if (gesture.current !== current || current.active) return;
    current.previews = new Map();
    for (const item of current.items.slice(0, 4)) {
      if (item.type !== 'widget') continue;
      const source = item.id === current.item.id ? current.element
        : document.querySelector(`[data-entry-id="${CSS.escape(item.id)}"]`);
      const preview = captureWidgetPreview(source);
      if (preview) current.previews.set(item.id, preview);
    }
    if (current.item.type === 'widget') {
      const preview = current.previews.get(current.item.id);
      if (!preview) { clear(); return; }
      current.previewAnchor = { width: preview.width, height: preview.height,
        x: current.startX - preview.left, y: current.startY - preview.top };
    }
    current.active = true;
    try { current.element.setPointerCapture(current.pointerId); } catch { /* Pointer ended. */ }
    current.target = null; publish(current);
  }

  useEffect(() => {
    const current = gesture.current;
    if (!current?.active) return;
    clearTimeout(current.pageHold);
    if (current.pageTarget?.key !== screenKey) { current.hoverRegion = null; current.pageTarget = null; }
    current.target = null; publish(current);
    const refresh = () => {
      if (gesture.current !== current || !current.active) return;
      current.target = targetAt(current.x, current.y, current); publish(current);
    };
    const frame = requestAnimationFrame(refresh), timer = setTimeout(refresh, 220);
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [screenKey]);

  useEffect(() => {
    const cancel = (event) => {
      if (event.type === 'keydown' && event.key !== 'Escape') return;
      if (gesture.current) clear();
    };
    window.addEventListener('keydown', cancel);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('keydown', cancel);
      window.removeEventListener('blur', cancel);
      clearTimeout(gesture.current?.hold);
      clearTimeout(gesture.current?.pageHold);
      gesture.current = null;
    };
  }, []);

  function tileProps(item) {
    return {
      'data-entry-id': item.id,
      draggable: false,
      onDragStart: (event) => event.preventDefault(),
      onClickCapture(event) {
        if (event.target.closest('dialog')) return;
        if (suppressClick.current && event.detail > 0) {
          suppressClick.current = false;
          event.preventDefault(); event.stopPropagation();
        }
        if (latest.current.editing) { event.preventDefault(); event.stopPropagation(); }
      },
      onPointerDown(event) {
        if (event.button !== 0 || event.target.closest('dialog')) return;
        if (!latest.current.editing && item.type === 'widget' && event.target.closest('button,a,input,textarea,select')
          && !event.target.closest('[data-widget-launcher]')) return;
        if (gesture.current) clear();
        suppressClick.current = false;
        let selection = [item.id], deselectOnClick = false;
        if (latest.current.editing) {
          event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
          const chosen = latest.current.selectedIds;
          deselectOnClick = chosen.includes(item.id);
          selection = deselectOnClick ? chosen : [...chosen, item.id];
          latest.current.onSelect?.(selection);
        }
        const ids = [item.id, ...selection.filter((id) => id !== item.id)], items = ids.map((id) => latest.current.state.entries.find((entry) => entry.id === id)).filter(Boolean).map((entry) => structuredClone(entry));
        const current = { item: structuredClone(item), revision: latest.current.state.revision,
          pointerId: event.pointerId, element: event.currentTarget, startX: event.clientX,
          startY: event.clientY, x: event.clientX, y: event.clientY, active: false, touch: event.pointerType === 'touch', grabRow: 0, grabColumn: 0,
          ids, items, deselectOnClick };
        const grid = event.currentTarget.closest('[data-grid-columns]');
        if (item.type === 'widget' && grid) {
          const columns = Number(grid.dataset.gridColumns), style = getComputedStyle(grid), box = event.currentTarget.getBoundingClientRect();
          const gap = parseFloat(style.columnGap) || 0, rowGap = parseFloat(style.rowGap) || 0;
          const width = (grid.getBoundingClientRect().width - (columns - 1) * gap) / columns, height = parseFloat(style.gridAutoRows);
          const size = desktopFootprint(item, columns);
          current.grabColumn = Math.max(0, Math.min(size.columns - 1, Math.floor((event.clientX - box.left) / (width + gap))));
          current.grabRow = Math.max(0, Math.min(size.rows - 1, Math.floor((event.clientY - box.top) / (height + rowGap))));
        }
        gesture.current = current;
        if (current.touch && !latest.current.editing) current.hold = setTimeout(() => activate(current), 300);
      },
      onPointerMove(event) {
        const current = gesture.current;
        if (!current || current.pointerId !== event.pointerId) return;
        current.x = event.clientX; current.y = event.clientY;
        const distance = Math.hypot(current.x - current.startX, current.y - current.startY);
        if (!current.active) {
          if (current.touch && !latest.current.editing && distance > 12) { clear(); return; }
          if ((!current.touch || latest.current.editing) && distance > 6) activate(current);
        }
        if (current.active) {
          event.preventDefault();
          hoverPage(current.x, current.y, current);
          current.target = targetAt(current.x, current.y, current);
          publish(current);
        }
      },
      onPointerUp(event) {
        const current = gesture.current;
        if (!current || current.pointerId !== event.pointerId) return;
        const active = current.active;
        const target = active ? targetAt(event.clientX, event.clientY, current) : null;
        clear();
        if (!active && latest.current.editing) {
          if (current.deselectOnClick) latest.current.onSelect?.(current.ids.filter((id) => id !== current.item.id));
        }
        if (!active || !target) return;
        event.preventDefault();
        if (latest.current.state.revision !== current.revision) {
          latest.current.onCancel?.(tr("导航已在其他页面更新，请重新拖动。"));
          return;
        }
        latest.current.onDrop(current.ids, target, current.revision);
      },
      onPointerCancel: clear,
      onLostPointerCapture() { if (gesture.current?.active) clear(); },
    };
  }
  return { drag, tileProps, cancelDrag: clear };
}

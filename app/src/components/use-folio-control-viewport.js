import { useLayoutEffect, useRef } from 'react';

const anchoredControls = '.folio-block-interaction-layer, .folio-table-controls';

// Folio portals escape scrolling panes so menus and dialogs can stay usable.
// Only the buttons attached to content need the content's vertical clipping.
export default function useFolioControlViewport(areaRef, portalHost) {
  const refresh = useRef(null);
  useLayoutEffect(() => {
    const area = areaRef.current, view = area?.ownerDocument.defaultView;
    if (!area || !portalHost || !view) return;
    let frame = null;
    const observed = new Set();
    const schedule = () => {
      if (frame === null) frame = view.requestAnimationFrame(() => { frame = null; update(); });
    };
    const sizes = new view.ResizeObserver(schedule);
    function observe(node) {
      if (!observed.has(node)) { sizes.observe(node); observed.add(node); }
    }
    function update() {
      const content = area.querySelector('.folio-editor__content');
      let top = 0, bottom = view.innerHeight;
      if (!content?.clientHeight) bottom = 0;
      else for (let node = content; node; node = node.parentElement) {
        observe(node);
        if (node !== content && !/auto|scroll|hidden|clip/.test(view.getComputedStyle(node).overflowY)) continue;
        const rect = node.getBoundingClientRect(), scale = node.offsetHeight ? rect.height / node.offsetHeight : 1;
        top = Math.max(top, rect.top + node.clientTop * scale);
        bottom = Math.min(bottom, rect.top + (node.clientTop + node.clientHeight) * scale);
      }
      bottom = Math.max(top, bottom);
      const selection = area.ownerDocument.getSelection();
      const range = selection?.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0) : null;
      const selectedTextVisible = content?.clientHeight > 0 && bottom > top && range && area.contains(range.commonAncestorContainer)
        && [...range.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0 && rect.bottom > top && rect.top < bottom);
      for (const portal of portalHost.querySelectorAll('.folio-ui-portal')) {
        if (portal.querySelector(anchoredControls)) {
          // Folio's fixed 100px probe accounts for scaled containing blocks.
          const rect = portal.getBoundingClientRect(), xScale = rect.width / 100, yScale = rect.height / 100;
          let clip = 'inset(50%)';
          if (content?.clientHeight && xScale > 0 && yScale > 0 && bottom > top) {
            const left = -rect.left / xScale, right = (view.innerWidth - rect.left) / xScale;
            const upper = (top - rect.top) / yScale, lower = (bottom - rect.top) / yScale;
            // Keep the existing side gutters for block and table buttons.
            clip = `polygon(${left}px ${upper}px, ${right}px ${upper}px, ${right}px ${lower}px, ${left}px ${lower}px)`;
          }
          if (portal.style.getPropertyValue('--note-control-clip') !== clip) portal.style.setProperty('--note-control-clip', clip);
        } else if (portal.querySelector('.folio-editor__bubble-toolbar')) {
          portal.toggleAttribute('data-note-selection-visible', Boolean(selectedTextVisible));
          portal.inert = !selectedTextVisible;
        }
      }
    }
    observe(area);
    const changes = new view.MutationObserver(schedule);
    changes.observe(portalHost, { childList: true, subtree: true });
    changes.observe(area, { childList: true, subtree: true });
    area.ownerDocument.addEventListener('scroll', schedule, { capture: true, passive: true });
    area.ownerDocument.addEventListener('selectionchange', schedule);
    view.addEventListener('resize', schedule);
    view.visualViewport?.addEventListener('resize', schedule);
    view.visualViewport?.addEventListener('scroll', schedule);
    refresh.current = update;
    update();
    return () => {
      refresh.current = null;
      if (frame !== null) view.cancelAnimationFrame(frame);
      sizes.disconnect(); changes.disconnect();
      area.ownerDocument.removeEventListener('scroll', schedule, true);
      area.ownerDocument.removeEventListener('selectionchange', schedule);
      view.removeEventListener('resize', schedule);
      view.visualViewport?.removeEventListener('resize', schedule);
      view.visualViewport?.removeEventListener('scroll', schedule);
    };
  }, [areaRef, portalHost]);
  useLayoutEffect(() => { refresh.current?.(); });
}

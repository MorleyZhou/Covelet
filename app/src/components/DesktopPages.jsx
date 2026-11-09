import { tr, getLocale } from "../i18n/index.js";
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CaretLeft, CaretRight, Plus } from '@phosphor-icons/react';
import { DESKTOP_ROWS, desktopFootprint, layoutDesktop, nextDesktopPage } from '../lib/desktop-layout.js';
import './desktop-pages.css';
import { Button } from './ui/button.jsx';

export default function DesktopPages({ settings, entries, activeKey, draftPage, drag, editing = false, onActiveChange, onNewPage, onScreenChange, renderTiles }) {
  const viewport = useRef(null), swipe = useRef(null), suppressSwipeClick = useRef(false), wheelTime = useRef(0), wheelSum = useRef(0), wheelContext = useRef(null);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [metrics, setMetrics] = useState({ columns: settings.columns, row: 120, gap: settings.gap, icon: settings.iconSize, tileGap: 8 });
  const screens = layoutDesktop(entries, metrics.columns, draftPage, settings.pages);
  const requested = screens.findIndex((screen) => screen.key === activeKey);
  const active = requested >= 0 ? requested : Math.max(0, screens.findIndex((screen) => screen.page === Number(activeKey.split(':')[0])));
  const current = screens[active];
  const currentName = settings.desktopPages?.[current.page]?.name;
  const dropSize = drag ? desktopFootprint(drag.item, metrics.columns) : null;
  const nextPage = editing ? draftPage ?? nextDesktopPage(entries, settings.pages) : null;
  const newKey = nextPage === null ? null : `${nextPage}:0`;
  const maxWidth = settings.columns * Math.max(120, settings.iconSize + 32) + (settings.columns - 1) * settings.gap;

  useLayoutEffect(() => {
    const element = viewport.current;
    const measure = () => {
      const grid = element.querySelector('.desktop-grid');
      const gridStyle = getComputedStyle(grid);
      const pageStyle = getComputedStyle(grid.parentElement);
      const gap = parseFloat(gridStyle.columnGap) || 0;
      const preferredRowGap = Math.min(settings.gap, matchMedia('(max-width: 550px)').matches ? 20 : settings.gap);
      const inlinePadding = (parseFloat(pageStyle.paddingLeft) || 0) + (parseFloat(pageStyle.paddingRight) || 0);
      const blockPadding = (parseFloat(pageStyle.paddingTop) || 0) + (parseFloat(pageStyle.paddingBottom) || 0);
      const icon = element.querySelector('.desktop-size-probe').getBoundingClientRect().width;
      const minimumCell = icon + (settings.showLabels ? 28 : 0) + 8;
      const availableWidth = Math.max(1, Math.min(element.parentElement.parentElement.clientWidth, maxWidth) - inlinePadding);
      const columns = Math.min(settings.columns, Math.max(1, Math.floor((availableWidth + gap) / (minimumCell + gap))));
      const widthCell = (availableWidth - (columns - 1) * gap) / columns;
      const availableHeight = element.clientHeight;
      const minimumRow = settings.showLabels ? 44 : 28;
      const rowGap = Math.min(preferredRowGap, Math.max(3, (availableHeight - blockPadding - minimumRow * DESKTOP_ROWS) / (DESKTOP_ROWS - 1)));
      const heightCell = (availableHeight - blockPadding - rowGap * (DESKTOP_ROWS - 1)) / DESKTOP_ROWS;
      const row = Math.max(minimumRow, Math.min(widthCell, heightCell));
      const width = Math.min(availableWidth + inlinePadding, columns * Math.max(minimumCell, row) + (columns - 1) * gap + inlinePadding);
      const tileGap = row < 60 ? 4 : 8;
      const renderedIcon = Math.min(icon, row - (settings.showLabels ? 21 + tileGap : 4));
      setMetrics((before) => before.columns === columns && Math.abs(before.row - row) < .1 && before.gap === rowGap
        && before.icon === renderedIcon && before.tileGap === tileGap && Math.abs((before.width ?? 0) - width) < .1
        ? before : { columns, row, gap: rowGap, width, icon: renderedIcon, tileGap });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(element.parentElement.parentElement);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [settings.columns, settings.width, settings.iconSize, settings.gap, settings.showLabels, maxWidth, editing]);

  useLayoutEffect(() => {
    if (current.key !== activeKey) onActiveChange(current.key);
    onScreenChange({ ...current, columns: metrics.columns });
  }, [current.key, activeKey, metrics.columns, entries, onActiveChange, onScreenChange]);
  useLayoutEffect(() => { viewport.current.scrollTop = 0; }, [current.key]);

  function change(index) {
    if (index < 0 || index >= screens.length) return;
    onActiveChange(screens[index].key);
  }
  wheelContext.current = { drag, active, screens, change };
  useEffect(() => {
    const element = viewport.current;
    const wheel = (event) => {
      const context = wheelContext.current;
      if (event.defaultPrevented || event.ctrlKey || !context.drag && !element.contains(event.target)) return;
      if (!context.drag && event.target.closest('input,textarea,select,[role=combobox]')) return;
      if (!context.drag) for (let node = event.target; node && node !== element; node = node.parentElement) {
        if (node.scrollHeight > node.clientHeight + 2 && ['auto', 'scroll'].includes(getComputedStyle(node).overflowY)) return;
      }
      if (!context.drag && Math.abs(event.deltaY) >= Math.abs(event.deltaX) && element.scrollHeight > element.clientHeight + 2) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      const direction = Math.sign(delta), next = context.active + direction;
      if (next < 0 || next >= context.screens.length) return;
      event.preventDefault();
      if (Date.now() - wheelTime.current < (context.drag ? 320 : 650)) { wheelSum.current = 0; return; }
      if (Math.sign(wheelSum.current) !== direction) wheelSum.current = 0;
      wheelSum.current += delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
      if (Math.abs(wheelSum.current) < (context.drag ? 30 : 48)) return;
      wheelTime.current = Date.now(); wheelSum.current = 0; context.change(next);
    };
    window.addEventListener('wheel', wheel, { passive: false, capture: true });
    return () => window.removeEventListener('wheel', wheel, true);
  }, []);
  function keyDown(event) {
    if (event.target !== event.currentTarget || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    change(event.key === 'Home' ? 0 : event.key === 'End' ? screens.length - 1 : active + (event.key === 'ArrowRight' ? 1 : -1));
  }
  const dropAttributes = (screen, direction) => screen ? {
    'data-page-switch': direction, 'data-page-key': screen.key, 'data-page': screen.page,
    'data-drop-index': screen.items.length ? screen.items.at(-1).order + 1 : undefined,
  } : nextPage !== null ? { 'data-page-switch': direction, 'data-page-key': newKey, 'data-page': nextPage, 'data-page-new': '' } : {};
  const nearby = screens.map((screen, index) => ({ screen, index })).filter(({ index }) => Math.abs(index - active) <= 3);
  return <div className="desktop-pages" style={{ maxWidth: Math.min(maxWidth, metrics.width ?? maxWidth), '--desktop-rows': DESKTOP_ROWS,
    '--grid-columns': metrics.columns, '--grid-row': `${metrics.row}px`, '--desktop-row-gap': `${metrics.gap}px`,
    '--desktop-icon-size': `${metrics.icon}px`, '--desktop-tile-gap': `${metrics.tileGap}px` }}>
    <div ref={viewport} className="desktop-page-viewport"
      tabIndex={0} role="group" aria-label={tr("主屏幕，第 {0} 屏，共 {1} 屏", [active + 1, screens.length])} onKeyDown={keyDown}
      onPointerDown={(event) => {
        suppressSwipeClick.current = false;
        if (event.defaultPrevented) return;
        if (event.button !== 0 || event.target.closest('input,textarea,.clock-widget button,.github-widget button,.github-widget a')) return;
        if (event.pointerType !== 'touch' && event.target.closest('button,a,[data-entry-id]')) return;
        swipe.current = { id: event.pointerId, x: event.clientX, y: event.clientY, time: Date.now() };
        if (event.pointerType !== 'touch') event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = swipe.current;
        if (!start || start.id !== event.pointerId || drag || event.defaultPrevented) return;
        const dx = event.clientX - start.x, dy = event.clientY - start.y;
        if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) { setSwipeOffset(Math.max(-180, Math.min(180, dx))); event.preventDefault(); }
      }}
      onPointerUp={(event) => {
        const start = swipe.current;
        swipe.current = null; setSwipeOffset(0);
        if (!start || start.id !== event.pointerId || drag || event.defaultPrevented || Date.now() - start.time > 1800) return;
        const dx = event.clientX - start.x, dy = event.clientY - start.y;
        if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          suppressSwipeClick.current = true; change(active + (dx < 0 ? 1 : -1));
        }
      }} onPointerCancel={() => { swipe.current = null; setSwipeOffset(0); }}
      onLostPointerCapture={() => { swipe.current = null; setSwipeOffset(0); }}
      onClickCapture={(event) => {
        if (!suppressSwipeClick.current) return;
        suppressSwipeClick.current = false; event.preventDefault(); event.stopPropagation();
      }}>
      <span className="site-icon desktop-size-probe" aria-hidden="true" />
      <div className={`desktop-page-track ${drag ? 'drag-active' : ''} ${swipeOffset ? 'is-swiping' : ''}`} style={{ transform: `translateX(calc(-${active * 100}% + ${swipeOffset}px))` }}>
        {screens.map((screen, index) => <div className="desktop-page" key={screen.key} aria-hidden={index !== active} inert={index !== active && !drag}>
          <div className={`sites-grid desktop-grid ${!settings.showLabels ? 'hide-labels' : ''}`} data-drop-parent="" data-page={screen.page} data-page-key={screen.key} data-grid-columns={metrics.columns}
            data-drop-index={screen.items.length ? screen.items.at(-1).order + 1 : undefined}>
            {Array.from({ length: DESKTOP_ROWS * metrics.columns }, (_, slot) => {
              const row = Math.floor(slot / metrics.columns), column = slot % metrics.columns;
              return <div key={`slot-${slot}`} aria-hidden="true" className="desktop-empty-slot"
                style={{ gridRow: row + 1, gridColumn: column + 1 }} />;
            })}
            {drag?.target?.kind === 'place' && drag.target.key === screen.key && <div className="desktop-placement-target" aria-hidden="true"
              style={{ gridRow: `${drag.target.row + 1} / span ${dropSize.rows}`, gridColumn: `${drag.target.column + 1} / span ${dropSize.columns}` }} />}
            {renderTiles(screen.items, screen.placements)}
          </div>
        </div>)}
      </div>
      {drag && <>
        {active > 0 && <div className="desktop-edge desktop-edge-left" {...dropAttributes(screens[active - 1], 'previous')}><CaretLeft size={24} /></div>}
        {(active < screens.length - 1 || nextPage !== null) && <div className="desktop-edge desktop-edge-right" {...dropAttributes(screens[active + 1], 'next')}><CaretRight size={24} /></div>}
      </>}
    </div>
    <nav className="desktop-page-controls" aria-label={tr("主屏幕分页")} data-layout-control={editing ? '' : undefined}>
      {currentName && <span className="desktop-page-name" dir="auto" title={currentName}>{currentName}</span>}
      <Button variant="unstyled" size="unstyled" type="button" className="desktop-page-arrow" aria-label={tr("上一屏")} disabled={active === 0} onClick={() => change(active - 1)} {...dropAttributes(screens[active - 1], 'previous')}><CaretLeft size={17} /></Button>
      <div className="desktop-page-dots">
        {nearby.map(({ screen, index }) => <Button variant="unstyled" size="unstyled" key={screen.key} type="button" className="desktop-page-dot" aria-label={tr("第 {0} 屏", [index + 1])}
          aria-current={index === active ? 'page' : undefined} onClick={() => change(index)} {...dropAttributes(screen, screen.key)}><span /></Button>)}
      </div>
      <Button variant="unstyled" size="unstyled" type="button" className="desktop-page-arrow" aria-label={tr("下一屏")} disabled={active === screens.length - 1} onClick={() => change(active + 1)} {...dropAttributes(screens[active + 1], 'next')}><CaretRight size={17} /></Button>
      {editing && nextPage !== null && <Button variant="unstyled" size="unstyled" type="button" className="desktop-page-add" aria-label={tr("添加一屏")} title={tr("添加一屏")} data-layout-control onClick={() => onNewPage(nextPage)} {...dropAttributes(null, 'new')}><Plus size={17} /></Button>}
    </nav>
  </div>;
}

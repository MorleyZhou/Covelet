import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CaretUp, CaretDown, X } from '@phosphor-icons/react';
import { tr, formatNumber } from '../i18n/index.js';
import { findRenderedNoteMatches, noteSearchTerms } from '../lib/note-search.js';
import { Button } from './ui/button.jsx';
import './note-search-matches.css';

function renderedEditor(area) {
  if (!area || area.closest('[hidden], [inert], [aria-hidden="true"]')) return null;
  if (area.matches('.ProseMirror, .folio-reader')) return area;
  return [...area.querySelectorAll('.ProseMirror, .folio-reader')]
    .find((node) => !node.closest('[hidden], [inert], [aria-hidden="true"]')) || null;
}

function scrollToRange(range, area) {
  if (!range || !area || !area.contains(range.commonAncestorContainer)) return;
  const window = area.ownerDocument.defaultView;
  const modal = area.closest('[data-ui-modal]'), stop = modal || area;
  const containers = [];
  for (let element = range.startContainer.parentElement; element; element = element.parentElement) {
    const style = window.getComputedStyle(element);
    const clipX = /^(auto|scroll|hidden|clip)$/u.test(style.overflowX);
    const clipY = /^(auto|scroll|hidden|clip)$/u.test(style.overflowY);
    if (clipX || clipY) containers.push({ element, clipX, clipY,
      scrollX: clipX && style.overflowX !== 'clip', scrollY: clipY && style.overflowY !== 'clip' });
    if (element === stop) break;
  }
  const clientBox = (element) => {
    const box = element.getBoundingClientRect();
    const left = box.left + element.clientLeft, top = box.top + element.clientTop;
    return { left, top, right: left + element.clientWidth, bottom: top + element.clientHeight };
  };
  // A narrow note has both an editor scroller and an outer form scroller. A
  // range centered in the inner box can still sit behind the outer footer.
  // Use each viewport's visible intersection and remeasure after every scroll;
  // a second pass handles an initially wholly clipped inner viewport.
  for (let pass = 0; pass < 2; pass++) for (let index = 0; index < containers.length; index++) {
    const container = containers[index], box = clientBox(container.element);
    let left = Math.max(0, box.left), top = Math.max(0, box.top);
    let right = Math.min(window.innerWidth, box.right), bottom = Math.min(window.innerHeight, box.bottom);
    for (const ancestor of containers.slice(index + 1)) {
      const outer = clientBox(ancestor.element);
      if (ancestor.clipX) { left = Math.max(left, outer.left); right = Math.min(right, outer.right); }
      if (ancestor.clipY) { top = Math.max(top, outer.top); bottom = Math.min(bottom, outer.bottom); }
    }
    const rect = range.getClientRects?.()[0] || range.getBoundingClientRect?.();
    if (!rect || !rect.height) continue;
    if (container.scrollY && bottom > top && container.element.scrollHeight > container.element.clientHeight) {
      const margin = Math.min(12, (bottom - top) / 4);
      if (rect.top < top + margin || rect.bottom > bottom - margin) {
        container.element.scrollTop += rect.top - (top + bottom) / 2 + Math.min(rect.height, bottom - top) / 2;
      }
    }
    // Vertical movement can change a fragment's geometry; do not reuse it for
    // horizontal adjustment, or for any outer ancestor.
    const horizontal = range.getClientRects?.()[0] || range.getBoundingClientRect?.();
    if (horizontal && container.scrollX && right > left && container.element.scrollWidth > container.element.clientWidth) {
      if (horizontal.left < left + 8) container.element.scrollLeft += horizontal.left - left - 8;
      else if (horizontal.right > right - 8) container.element.scrollLeft += horizontal.right - right + 8;
    }
  }
}

export default function NoteSearchMatches({ rootRef, query, active = true, onClose }) {
  const id = useId().replace(/[^a-z\d-]/giu, ''), name = `covelet-note-match-${id}`, currentName = `${name}-current`;
  const terms = useMemo(() => noteSearchTerms(query), [query]), queryKey = JSON.stringify(terms);
  const ranges = useRef([]), selected = useRef(0), paintCurrent = useRef(() => {});
  const [status, setStatus] = useState({ count: 0, current: 0, truncated: false });
  // This component can precede its sibling editor area in the parent's render.
  // Passive effects run after every DOM ref has attached; a child layout effect
  // can otherwise observe rootRef.current === null and never install a watcher.
  useEffect(() => {
    const area = rootRef.current, window = area?.ownerDocument.defaultView;
    const registry = window?.CSS?.highlights, Highlight = window?.Highlight;
    const clear = () => { registry?.delete(name); registry?.delete(currentName); };
    ranges.current = []; selected.current = 0; clear();
    setStatus({ count: 0, current: 0, truncated: false });
    if (!active || !area || !window) return clear;
    let frame = null, disposed = false, first = true;
    const request = window.requestAnimationFrame?.bind(window) || ((callback) => window.setTimeout(callback, 0));
    const cancel = window.cancelAnimationFrame?.bind(window) || window.clearTimeout.bind(window);
    paintCurrent.current = (scroll = false) => {
      if (disposed) return;
      const range = ranges.current[selected.current];
      if (registry && Highlight) {
        registry.delete(currentName);
        if (range) { const highlight = new Highlight(range); highlight.priority = 1; registry.set(currentName, highlight); }
      }
      if (scroll && range) scrollToRange(range, area);
      setStatus((value) => ({ ...value, current: range ? selected.current + 1 : 0 }));
    };
    function rebuild() {
      frame = null;
      if (disposed) return;
      const editor = renderedEditor(area), result = editor ? findRenderedNoteMatches(editor, terms) : { matches: [], truncated: false };
      ranges.current = result.matches.map((match) => match.range);
      selected.current = Math.min(selected.current, Math.max(0, ranges.current.length - 1));
      clear();
      if (registry && Highlight && ranges.current.length) registry.set(name, new Highlight(...ranges.current));
      setStatus({ count: ranges.current.length, current: ranges.current.length ? selected.current + 1 : 0, truncated: result.truncated });
      // Folio mounts its editor after this effect (immediatelyRender:false).
      // Keep the initial scroll pending until the first real DOM range exists.
      paintCurrent.current(first && ranges.current.length > 0);
      if (ranges.current.length) first = false;
    }
    function schedule() { if (frame === null) frame = request(rebuild); }
    const observer = new window.MutationObserver(schedule);
    observer.observe(area, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'inert'] });
    rebuild();
    return () => { disposed = true; observer.disconnect(); if (frame !== null) cancel(frame); clear(); ranges.current = []; paintCurrent.current = () => {}; };
  }, [rootRef, queryKey, active, name, currentName]);
  function go(delta) {
    if (!ranges.current.length) return;
    selected.current = (selected.current + delta + ranges.current.length) % ranges.current.length;
    paintCurrent.current(true);
  }
  if (!active) return null;
  return <div className="note-search-matches" data-note-search-matches role="region" aria-label={tr('搜索定位')}>
    <style>{`::highlight(${name}) { background-color: #ffe08a; color: #231900; }
::highlight(${currentName}) { background-color: #f5a623; color: #171000; }
@media (forced-colors: active) { ::highlight(${name}), ::highlight(${currentName}) { background-color: Highlight; color: HighlightText; } }`}</style>
    <span className="note-search-match-status" role="status" aria-live="polite">{status.count
      ? tr('第 {0} / {1} 处', [formatNumber(status.current), formatNumber(status.count)]) : tr('正文中没有匹配的文字。')}</span>
    {status.truncated && <span className="note-search-match-limit">{tr('仅显示前 {0} 处匹配。', [formatNumber(status.count)])}</span>}
    <div className="note-search-match-actions">
      <Button type="button" variant="ghost" size="icon" aria-label={tr('上一处')} title={tr('上一处')} disabled={!status.count} onClick={() => go(-1)}><CaretUp size={17} /></Button>
      <Button type="button" variant="ghost" size="icon" aria-label={tr('下一处')} title={tr('下一处')} disabled={!status.count} onClick={() => go(1)}><CaretDown size={17} /></Button>
      <Button type="button" variant="ghost" size="icon" aria-label={tr('关闭搜索定位')} title={tr('关闭搜索定位')} onClick={onClose}><X size={17} /></Button>
    </div>
  </div>;
}

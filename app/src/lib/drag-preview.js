// Capture the existing widget without mounting another live React component.
// Keep its own size container so responsive widget styles do not change in flight.
export function captureWidgetPreview(source) {
  if (!source?.matches('.widget-tile')) return null;
  const box = source.getBoundingClientRect();
  if (!box.width || !box.height) return null;

  const node = source.cloneNode(true), style = getComputedStyle(source);
  const originals = [source, ...source.querySelectorAll('*')];
  const copies = [node, ...node.querySelectorAll('*')];
  const scrollOffsets = [];
  originals.forEach((original, index) => {
    const copy = copies[index];
    copy.removeAttribute('id');
    copy.removeAttribute('data-entry-id');
    if (original.scrollTop || original.scrollLeft) scrollOffsets.push({ node: copy, top: original.scrollTop, left: original.scrollLeft });
    if (original instanceof HTMLInputElement) { copy.value = original.value; copy.checked = original.checked; }
    if (original instanceof HTMLTextAreaElement || original instanceof HTMLSelectElement) copy.value = original.value;
  });
  node.classList.remove('dragging', 'is-selected', 'combine-target', 'insert-before', 'insert-after');
  node.querySelectorAll('.layout-selection-mark').forEach((mark) => mark.remove());
  node.inert = true;
  node.tabIndex = -1;
  node.setAttribute('aria-hidden', 'true');
  // Preserve values inherited from the desktop; the preview lives outside its grid.
  for (const name of Array.from(style)) if (name.startsWith('--')) node.style.setProperty(name, style.getPropertyValue(name));
  Object.assign(node.style, {
    width: `${box.width}px`, height: `${box.height}px`, boxSizing: 'border-box',
    position: 'absolute', inset: '0', margin: '0', gridArea: 'auto',
    font: style.font, color: style.color, animation: 'none', transition: 'none',
    transform: 'none', transformOrigin: 'top left', opacity: '1', pointerEvents: 'none',
  });
  const content = node.querySelector('.widget-live-content');
  if (content) Object.assign(content.style, { animation: 'none', transform: 'none', outline: 'none' });
  const caption = source.querySelector('.widget-caption'), captionCopy = node.querySelector('.widget-caption');
  if (caption && captionCopy) {
    const captionStyle = getComputedStyle(caption);
    Object.assign(captionCopy.style, { font: captionStyle.font,
      color: `var(--navigation-label-ink, ${captionStyle.color})`, textShadow: `var(--navigation-label-shadow, ${captionStyle.textShadow})` });
  }
  return {
    node, width: box.width, height: box.height, left: box.left, top: box.top,
    restoreScroll() { scrollOffsets.forEach(({ node: scrollNode, top, left }) => { scrollNode.scrollTop = top; scrollNode.scrollLeft = left; }); },
  };
}

// Spatial keyboard focus follows the rendered grid, including spanning widgets.
// It never mutates layout positions or the current multi-selection.
export function focusDesktopNeighbor(tile, key) {
  const grid = tile.closest('[data-grid-columns]');
  if (!grid) return false;
  const tiles = [...grid.querySelectorAll('[data-entry-id][tabindex="0"]')].filter((node) => node.getBoundingClientRect().width > 0);
  if (!tiles.length) return false;
  let target;
  if (key === 'Home' || key === 'End') {
    const ordered = tiles.sort((a, b) => Number(a.dataset.gridRow) - Number(b.dataset.gridRow) || Number(a.dataset.gridColumn) - Number(b.dataset.gridColumn));
    target = key === 'Home' ? ordered[0] : ordered.at(-1);
  } else {
    const box = tile.getBoundingClientRect(), horizontal = key === 'ArrowLeft' || key === 'ArrowRight', sign = ['ArrowRight', 'ArrowDown'].includes(key) ? 1 : -1;
    const center = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    const candidates = tiles.filter((node) => node !== tile).map((node) => {
      const rect = node.getBoundingClientRect(), x = rect.left + rect.width / 2 - center.x, y = rect.top + rect.height / 2 - center.y;
      const forward = (horizontal ? x : y) * sign, lateral = Math.abs(horizontal ? y : x);
      const overlap = horizontal ? Math.min(box.bottom, rect.bottom) - Math.max(box.top, rect.top) : Math.min(box.right, rect.right) - Math.max(box.left, rect.left);
      return { node, forward, score: forward + lateral * 2 + (overlap > 0 ? 0 : 10000) };
    }).filter((item) => item.forward > 1).sort((a, b) => a.score - b.score);
    target = candidates[0]?.node;
  }
  target?.focus({ preventScroll: true });
  return true;
}

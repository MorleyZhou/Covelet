// Select only validated local cache records. Acquisition belongs to explicit
// user actions, while a missing theme variant can use the saved base image.
export function observeCachedIconSources(primary, fallback, { peek, read, subscribe, onReady, onMissing, defer = false }) {
  const alternate = fallback && fallback !== primary ? fallback : '';
  let active = true, started = false, primaryReady = false, primaryChecked = false, alternateItem;
  const accept = (source, item) => {
    if (!active || !item) return;
    if (source === primary) {
      primaryReady = true;
      onReady(source, item);
    } else if (source === alternate) {
      alternateItem = item;
      if (primaryChecked && !primaryReady) onReady(source, item);
    }
  };
  const unsubscribe = subscribe((item) => {
    if (item.url === primary || item.url === alternate) accept(item.url, item);
  });
  const safeRead = (source) => Promise.resolve().then(() => read(source)).catch(() => null);
  const start = () => {
    if (!active || started || primaryReady) return;
    started = true;
    const known = peek(primary);
    if (known) { accept(primary, known); return; }
    safeRead(primary).then(async (item) => {
      if (!active || primaryReady) return;
      primaryChecked = true;
      if (item) { accept(primary, item); return; }
      let other = alternate ? alternateItem || peek(alternate) : null;
      if (!other && alternate) {
        const pending = await safeRead(alternate);
        other = alternateItem || pending;
      }
      if (!active || primaryReady) return;
      if (other) accept(alternate, other);
      else onMissing();
    });
  };
  if (!defer) start();
  return { start, stop() { active = false; unsubscribe(); } };
}

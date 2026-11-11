export function resourceLocation(entry, navigation) {
  const folder = entry.parentId ? navigation.entries.find((item) => item.type === 'folder' && item.id === entry.parentId) : null;
  return { page: folder?.page ?? entry.page ?? 0, folder };
}

export function resourceDomain(entry) {
  try { return entry.type === 'site' ? new URL(entry.url).hostname : ''; } catch { return ''; }
}

// Presentation order only: retain the records and never sort navigation.entries.
export function sortResourceRows(rows, navigation, { field = 'name', direction = 'asc' } = {}, locale) {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
  const locations = new Map(rows.map((row) => [row.key, resourceLocation(row.entry, navigation)]));
  const sign = direction === 'desc' ? -1 : 1;
  return [...rows].sort((left, right) => {
    const a = left.entry, b = right.entry;
    let comparison = 0;
    if (field === 'domain') comparison = collator.compare(resourceDomain(a), resourceDomain(b));
    if (field === 'location') {
      const first = locations.get(left.key), second = locations.get(right.key);
      comparison = first.page - second.page || collator.compare(first.folder?.name || '', second.folder?.name || '');
    }
    comparison ||= collator.compare(a.name, b.name);
    return sign * comparison || collator.compare(left.key, right.key);
  });
}

export function scopeSearchContent(navigation, tools, scope, page) {
  const entries = navigation?.entries ?? [];
  if (scope === 'all') return { entries, tools };
  if (scope === 'current') {
    const folderPages = new Map(entries.filter((entry) => entry.type === 'folder')
      .map((folder) => [folder.id, folder.page ?? 0]));
    return {
      entries: entries.filter((entry) => (folderPages.get(entry.parentId) ?? entry.page ?? 0) === page),
      tools: null,
    };
  }
  if (scope === 'site' || scope === 'folder') return { entries: entries.filter((entry) => entry.type === scope), tools: null };
  if (scope === 'note') return { entries: [], tools: { notes: tools?.notes } };
  if (scope === 'reading') return { entries: [], tools: { reading: tools?.reading } };
  return { entries: [], tools: null };
}

export function navigationResultPath(result, navigation, hiddenKeys, pageName) {
  if (!['site', 'folder'].includes(result.type) || hiddenKeys?.has(result.key)) return '';
  const entry = result.entry;
  const folder = entry.parentId && navigation.entries.find((candidate) => candidate.type === 'folder' && candidate.id === entry.parentId);
  if (folder && hiddenKeys?.has(`folder:${folder.id}`)) return '';
  const desktop = pageName(folder?.page ?? entry.page ?? 0);
  return folder ? `${desktop} › ${folder.name}` : desktop;
}

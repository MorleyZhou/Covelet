// Structural traversal: stored expired items remain referenced until a locked
// purge commits their removal. Archive validity never changes with the clock.
export function navigationResourceEntries(state) {
  return [...(state?.entries || []), ...(state?.trash?.items || []).flatMap((item) => item.ownedEntries || [])];
}

export function remapNavigationAssets(input, mapping) {
  const state = structuredClone(input);
  if (state.settings.background.kind === 'image' && mapping.has(state.settings.background.value)) state.settings.background.value = mapping.get(state.settings.background.value);
  for (const entry of navigationResourceEntries(state)) if (entry.icon?.kind === 'image' && mapping.has(entry.icon.value)) entry.icon.value = mapping.get(entry.icon.value);
  return state;
}

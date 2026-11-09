import { tr } from '../i18n/index.js';
import { desktopPageName, logicalDesktopPages } from '../lib/desktop-pages.js';
import { desktopDestinationValue } from '../lib/navigation-destinations.js';
import Select from './Select.jsx';

export default function NavigationDestination({ state, preferences, value, onChange, disabled }) {
  const folders = new Map();
  const hidden = new Set(preferences.presentation ? preferences.privateKeys : []);
  for (const item of state.entries) {
    if (item.type !== 'folder' || item.detached || hidden.has(`folder:${item.id}`)) continue;
    const page = item.page ?? 0;
    if (!folders.has(page)) folders.set(page, []);
    folders.get(page).push(item);
  }
  const options = logicalDesktopPages(state).flatMap((page) => {
    const name = desktopPageName(state.settings, page);
    return [{ value: desktopDestinationValue(state, page), label: name },
      ...(folders.get(page) || []).sort((a, b) => a.order - b.order).map((folder) => ({
        value: `folder:${folder.id}`,
        label: `${name} / ${folder.name}`,
      }))];
  });
  return <Select label={tr('目标位置')} value={value} onChange={onChange} options={options} disabled={disabled} />;
}

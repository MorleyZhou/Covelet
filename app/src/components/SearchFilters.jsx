import { useRef } from 'react';
import { FunnelSimple } from '@phosphor-icons/react';
import { tr } from '../i18n/index.js';
import { useFloatingContainer } from './DialogSurface.jsx';
import { Button } from './ui/button.jsx';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator,
} from './ui/dropdown-menu.jsx';
import './search-filters.css';

export default function SearchFilters({ value, onChange, onReturnFocus }) {
  const chosen = useRef(false), container = useFloatingContainer();
  const label = tr('筛选搜索结果');
  return <DropdownMenu modal={false} onOpenChange={(open) => { if (open) chosen.current = false; }}>
    <DropdownMenuTrigger asChild>
      <Button type="button" variant="unstyled" size="unstyled" className="search-submit search-filter"
        data-active={value !== 'all' || undefined} aria-label={label} title={label}>
        <FunnelSimple size={20} weight={value === 'all' ? 'regular' : 'fill'} aria-hidden="true" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent container={container} align="end" aria-label={label} onCloseAutoFocus={(event) => {
      if (chosen.current && onReturnFocus) {
        event.preventDefault();
        onReturnFocus();
      }
    }}>
      <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
        <DropdownMenuRadioItem value="all" onSelect={() => { chosen.current = true; }}>{tr('全部内容')}</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="current" onSelect={() => { chosen.current = true; }}>{tr('当前桌面')}</DropdownMenuRadioItem>
        <DropdownMenuSeparator />
        <DropdownMenuRadioItem value="desktop" onSelect={() => { chosen.current = true; }}>{tr('桌面')}</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="site" onSelect={() => { chosen.current = true; }}>{tr('网站')}</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="folder" onSelect={() => { chosen.current = true; }}>{tr('文件夹')}</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="note" onSelect={() => { chosen.current = true; }}>{tr('便笺')}</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="reading" onSelect={() => { chosen.current = true; }}>{tr('稍后读')}</DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}

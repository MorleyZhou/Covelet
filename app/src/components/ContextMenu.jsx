import { useLayoutEffect, useRef } from 'react';
import { tr } from '../i18n/index.js';
import { useFloatingContainer } from './DialogSurface.jsx';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from './ui/dropdown-menu.jsx';

export default function ContextMenu({ context, items = [], onClose, label = tr('网站操作') }) {
  const container = useFloatingContainer(), chosen = useRef(false);
  useLayoutEffect(() => { chosen.current = false; }, [context]);
  if (!context || !container) return null;
  return <DropdownMenu open modal={false} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DropdownMenuTrigger asChild>
      <span aria-hidden="true" tabIndex={-1} style={{ position: 'fixed', width: 1, height: 1, pointerEvents: 'none', left: Number.isFinite(context.x) ? context.x : 8, top: Number.isFinite(context.y) ? context.y : 8 }} />
    </DropdownMenuTrigger>
    <DropdownMenuContent container={container} className="context-menu" aria-label={label} align="start" sideOffset={0}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onEscapeKeyDown={(event) => event.stopPropagation()}
      onCloseAutoFocus={(event) => { event.preventDefault(); if (!chosen.current && context.source?.isConnected) context.source.focus({ preventScroll: true }); }}
      onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Tab') { event.preventDefault(); onClose(); context.source?.focus({ preventScroll: true }); } }}>
      {items.map((item, index) => item.divider ? <DropdownMenuSeparator key={`divider-${index}`} /> : <DropdownMenuItem
        key={`${item.label}-${index}`} disabled={Boolean(item.disabled)} destructive={item.danger}
        onSelect={() => {
          chosen.current = true;
          // A following dialog must remember the stable tile, not this menu item.
          if (context.source?.isConnected) context.source.focus({ preventScroll: true });
          onClose(); item.action?.();
        }}>{item.icon}{item.label}</DropdownMenuItem>)}
    </DropdownMenuContent>
  </DropdownMenu>;
}

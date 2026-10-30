import { forwardRef } from 'react';
import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu';
import { Check } from '@phosphor-icons/react';
import { cn } from './utils.js';

const DropdownMenu = DropdownPrimitive.Root;
const DropdownMenuTrigger = DropdownPrimitive.Trigger;
const DropdownMenuGroup = DropdownPrimitive.Group;
const DropdownMenuContent = forwardRef(function DropdownMenuContent({ className, children, container, sideOffset = 6, ...props }, ref) {
  return <DropdownPrimitive.Portal container={container}>
    <DropdownPrimitive.Content ref={ref} data-slot="dropdown-menu-content" data-popover sideOffset={sideOffset} collisionPadding={8} className={cn('ui-floating-panel ui-dropdown-content', className)} {...props}>{children}</DropdownPrimitive.Content>
  </DropdownPrimitive.Portal>;
});
const DropdownMenuItem = forwardRef(function DropdownMenuItem({ className, destructive = false, ...props }, ref) {
  return <DropdownPrimitive.Item ref={ref} data-slot="dropdown-menu-item" data-destructive={destructive || undefined} className={cn('ui-menu-item', className)} {...props} />;
});
const DropdownMenuRadioGroup = DropdownPrimitive.RadioGroup;
const DropdownMenuRadioItem = forwardRef(function DropdownMenuRadioItem({ className, children, ...props }, ref) {
  return <DropdownPrimitive.RadioItem ref={ref} data-slot="dropdown-menu-radio-item" className={cn('ui-menu-item ui-menu-radio-item', className)} {...props}>{children}<DropdownPrimitive.ItemIndicator className="ui-menu-indicator"><Check size={15} /></DropdownPrimitive.ItemIndicator></DropdownPrimitive.RadioItem>;
});
const DropdownMenuSeparator = forwardRef(function DropdownMenuSeparator({ className, ...props }, ref) {
  return <DropdownPrimitive.Separator ref={ref} className={cn('ui-menu-separator', className)} {...props} />;
});

export { DropdownMenu, DropdownMenuTrigger, DropdownMenuGroup, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator };

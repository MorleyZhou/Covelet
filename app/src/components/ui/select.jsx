import { forwardRef } from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { CaretDown, CaretUp, Check } from '@phosphor-icons/react';
import { cn } from './utils.js';

const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;
const SelectTrigger = forwardRef(function SelectTrigger({ className, children, ...props }, ref) {
  return <SelectPrimitive.Trigger ref={ref} data-slot="select-trigger" className={cn('ui-select-trigger', className)} {...props}>{children}<SelectPrimitive.Icon asChild><CaretDown size={15} aria-hidden="true" /></SelectPrimitive.Icon></SelectPrimitive.Trigger>;
});
const SelectContent = forwardRef(function SelectContent({ className, children, container, position = 'popper', ...props }, ref) {
  return <SelectPrimitive.Portal container={container}>
    <SelectPrimitive.Content ref={ref} data-slot="select-content" data-popover className={cn('ui-floating-panel ui-select-content', className)} position={position} sideOffset={6} collisionPadding={10} {...props}>
      <SelectPrimitive.ScrollUpButton className="ui-select-scroll"><CaretUp size={14} /></SelectPrimitive.ScrollUpButton>
      <SelectPrimitive.Viewport className="ui-select-viewport">{children}</SelectPrimitive.Viewport>
      <SelectPrimitive.ScrollDownButton className="ui-select-scroll"><CaretDown size={14} /></SelectPrimitive.ScrollDownButton>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>;
});
const SelectItem = forwardRef(function SelectItem({ className, children, ...props }, ref) {
  return <SelectPrimitive.Item ref={ref} data-slot="select-item" className={cn('ui-select-item', className)} {...props}>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText><span className="ui-select-indicator"><SelectPrimitive.ItemIndicator><Check size={15} weight="bold" /></SelectPrimitive.ItemIndicator></span>
  </SelectPrimitive.Item>;
});
const SelectLabel = forwardRef(function SelectLabel({ className, ...props }, ref) {
  return <SelectPrimitive.Label ref={ref} className={cn('ui-select-label', className)} {...props} />;
});
const SelectSeparator = forwardRef(function SelectSeparator({ className, ...props }, ref) {
  return <SelectPrimitive.Separator ref={ref} className={cn('ui-menu-separator', className)} {...props} />;
});

export { Select, SelectGroup, SelectValue, SelectTrigger, SelectContent, SelectItem, SelectLabel, SelectSeparator };

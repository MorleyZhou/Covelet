import { forwardRef } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from './utils.js';

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;
const PopoverClose = PopoverPrimitive.Close;
const PopoverContent = forwardRef(function PopoverContent({ className, children, container, align = 'start', sideOffset = 8, ...props }, ref) {
  return <PopoverPrimitive.Portal container={container}>
    <PopoverPrimitive.Content ref={ref} data-slot="popover-content" data-popover align={align} sideOffset={sideOffset} collisionPadding={12} className={cn('ui-floating-panel ui-popover-content', className)} {...props}>{children}</PopoverPrimitive.Content>
  </PopoverPrimitive.Portal>;
});

export { Popover, PopoverTrigger, PopoverAnchor, PopoverClose, PopoverContent };

import { forwardRef } from 'react';
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import { cn } from './utils.js';

// Adapted from shadcn/ui's New York Scroll Area. Keep the scrollbar primitive
// mounted even when visually hidden so Radix enables native viewport scrolling.
const ScrollArea = forwardRef(function ScrollArea({ className, children, hideScrollbars = false, viewportProps, ...props }, ref) {
  return <ScrollAreaPrimitive.Root ref={ref} data-slot="scroll-area" data-scrollbars={hideScrollbars ? 'hidden' : 'auto'} className={cn('ui-scroll-area', className)} {...props}>
    <ScrollAreaPrimitive.Viewport tabIndex={0} {...viewportProps} data-slot="scroll-area-viewport" className={cn('ui-scroll-viewport', viewportProps?.className)}>
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>;
});

const ScrollBar = forwardRef(function ScrollBar({ className, orientation = 'vertical', ...props }, ref) {
  return <ScrollAreaPrimitive.Scrollbar ref={ref} data-slot="scroll-area-scrollbar" orientation={orientation} className={cn('ui-scrollbar', className)} {...props}>
    <ScrollAreaPrimitive.Thumb data-slot="scroll-area-thumb" className="ui-scroll-thumb" />
  </ScrollAreaPrimitive.Scrollbar>;
});

export { ScrollArea, ScrollBar };

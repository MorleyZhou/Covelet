import { forwardRef } from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cn } from './utils.js';

// shadcn/ui New York Switch, styled with Covelet tokens.
const Switch = forwardRef(function Switch({ className, ...props }, ref) {
  return <SwitchPrimitive.Root ref={ref} data-slot="switch" className={cn('ui-switch', className)} {...props}>
    <SwitchPrimitive.Thumb data-slot="switch-thumb" className="ui-switch-thumb" />
  </SwitchPrimitive.Root>;
});

export { Switch };

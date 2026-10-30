import { forwardRef } from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check, Minus } from '@phosphor-icons/react';
import { cn } from './utils.js';

// Adapted from shadcn/ui's New York Checkbox. Its button-based primitive stays
// separate from the native checkbox switches used by the settings page.
const Checkbox = forwardRef(function Checkbox({ className, ...props }, ref) {
  return <CheckboxPrimitive.Root ref={ref} data-slot="checkbox" className={cn('ui-checkbox', className)} {...props}>
    <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="ui-checkbox-indicator">
      <Check className="ui-checkbox-check" size={12} weight="bold" aria-hidden="true" />
      <Minus className="ui-checkbox-mixed" size={12} weight="bold" aria-hidden="true" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>;
});

export { Checkbox };

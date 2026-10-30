import { forwardRef } from 'react';
import { cn } from './utils.js';

// Adapted from shadcn/ui's New York Input; styles live in ui.css.
const Input = forwardRef(function Input({ className, type, unstyled = false, ...props }, ref) {
  const nativeControl = ['file', 'hidden', 'color'].includes(type);
  return <input ref={ref} data-slot="input" type={type} className={cn(!nativeControl && (unstyled ? 'ui-input-unstyled' : 'ui-input'), className)} {...props} />;
});

export { Input };

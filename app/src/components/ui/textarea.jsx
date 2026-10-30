import { forwardRef } from 'react';
import { cn } from './utils.js';

const Textarea = forwardRef(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} data-slot="textarea" className={cn('ui-input ui-textarea', className)} {...props} />;
});

export { Textarea };

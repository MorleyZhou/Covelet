import { forwardRef } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from './utils.js';

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;
const DialogPortal = DialogPrimitive.Portal;
const DialogOverlay = forwardRef(function DialogOverlay({ className, ...props }, ref) {
  return <DialogPrimitive.Overlay ref={ref} data-slot="dialog-overlay" className={cn('ui-dialog-overlay', className)} {...props} />;
});
const DialogContent = forwardRef(function DialogContent({ className, children, container, overlayClassName, onInteractOutside, ...props }, ref) {
  return <DialogPortal container={container}>
    <DialogOverlay className={overlayClassName} />
    <DialogPrimitive.Content ref={ref} data-slot="dialog-content" data-ui-modal className={cn('ui-dialog-content', className)}
      onInteractOutside={(event) => {
        // A close button can remove its toast before Radix delivers this event.
        if (event.target?.closest?.('[data-slot="toast-viewport"], .toast')) event.preventDefault();
        onInteractOutside?.(event);
      }} {...props}>{children}</DialogPrimitive.Content>
  </DialogPortal>;
});
const DialogTitle = forwardRef(function DialogTitle({ className, ...props }, ref) {
  return <DialogPrimitive.Title ref={ref} data-slot="dialog-title" className={cn('ui-dialog-title', className)} {...props} />;
});
const DialogDescription = forwardRef(function DialogDescription({ className, ...props }, ref) {
  return <DialogPrimitive.Description ref={ref} data-slot="dialog-description" className={cn('ui-dialog-description', className)} {...props} />;
});
const DialogHeader = ({ className, ...props }) => <div data-slot="dialog-header" className={cn('ui-dialog-header', className)} {...props} />;
const DialogFooter = ({ className, ...props }) => <div data-slot="dialog-footer" className={cn('ui-dialog-footer', className)} {...props} />;

export { Dialog, DialogTrigger, DialogClose, DialogPortal, DialogOverlay, DialogContent, DialogTitle, DialogDescription, DialogHeader, DialogFooter };

import { createContext, forwardRef, useContext } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from './utils.js';

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;
const DialogPortal = DialogPrimitive.Portal;
// Portals share a DOM container, but keep their React owner. A child backdrop
// must sit above its owner's content rather than behind every open dialog.
const DialogLayer = createContext(0);
const DialogOverlay = forwardRef(function DialogOverlay({ className, ...props }, ref) {
  return <DialogPrimitive.Overlay ref={ref} data-slot="dialog-overlay" className={cn('ui-dialog-overlay', className)} {...props} />;
});
const DialogContent = forwardRef(function DialogContent({ className, children, container, overlayClassName, onInteractOutside, style, ...props }, ref) {
  const depth = useContext(DialogLayer);
  return <DialogLayer.Provider value={depth + 1}><DialogPortal container={container}>
    <DialogOverlay className={overlayClassName} data-dialog-depth={depth} style={{ '--dialog-layer': 80 + depth * 2 }} />
    <DialogPrimitive.Content ref={ref} data-slot="dialog-content" data-ui-modal data-dialog-depth={depth} className={cn('ui-dialog-content', className)}
      style={{ '--dialog-layer': 81 + depth * 2, ...style }}
      onInteractOutside={(event) => {
        // A close button can remove its toast before Radix delivers this event.
        if (event.target?.closest?.('[data-slot="toast-viewport"], .toast')) event.preventDefault();
        onInteractOutside?.(event);
      }} {...props}>{children}</DialogPrimitive.Content>
  </DialogPortal></DialogLayer.Provider>;
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

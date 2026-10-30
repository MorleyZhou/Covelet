import { forwardRef } from 'react';
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import { cn } from './utils.js';

const AlertDialog = AlertDialogPrimitive.Root;
const AlertDialogTrigger = AlertDialogPrimitive.Trigger;
const AlertDialogAction = AlertDialogPrimitive.Action;
const AlertDialogCancel = AlertDialogPrimitive.Cancel;
const AlertDialogContent = forwardRef(function AlertDialogContent({ className, children, container, ...props }, ref) {
  return <AlertDialogPrimitive.Portal container={container}>
    <AlertDialogPrimitive.Overlay data-slot="alert-dialog-overlay" className="ui-dialog-overlay ui-alert-overlay" />
    <AlertDialogPrimitive.Content ref={ref} data-slot="alert-dialog-content" data-ui-modal className={cn('ui-dialog-content ui-alert-content', className)} {...props}>{children}</AlertDialogPrimitive.Content>
  </AlertDialogPrimitive.Portal>;
});
const AlertDialogTitle = forwardRef(function AlertDialogTitle({ className, ...props }, ref) {
  return <AlertDialogPrimitive.Title ref={ref} data-slot="alert-dialog-title" className={cn('ui-dialog-title', className)} {...props} />;
});
const AlertDialogDescription = forwardRef(function AlertDialogDescription({ className, ...props }, ref) {
  return <AlertDialogPrimitive.Description ref={ref} data-slot="alert-dialog-description" className={cn('ui-dialog-description', className)} {...props} />;
});

export { AlertDialog, AlertDialogTrigger, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogTitle, AlertDialogDescription };

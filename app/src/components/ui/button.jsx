import { forwardRef } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva } from 'class-variance-authority';
import { cn } from './utils.js';

// Adapted from shadcn/ui's New York Button; styles live in ui.css.
const buttonVariants = cva('ui-control', {
  variants: {
    variant: {
      default: 'ui-button ui-button-primary',
      destructive: 'ui-button ui-button-destructive',
      outline: 'ui-button ui-button-outline',
      secondary: 'ui-button ui-button-secondary',
      ghost: 'ui-button ui-button-ghost',
      link: 'ui-button ui-button-link',
      unstyled: 'ui-button-unstyled',
    },
    size: {
      default: 'ui-button-default',
      sm: 'ui-button-sm',
      lg: 'ui-button-lg',
      icon: 'ui-button-icon',
      unstyled: '',
    },
  },
  defaultVariants: { variant: 'default', size: 'default' },
});

const Button = forwardRef(function Button({ className, variant, size, asChild = false, type, ...props }, ref) {
  const Component = asChild ? Slot : 'button';
  return <Component ref={ref} data-slot="button" type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});

export { Button, buttonVariants };

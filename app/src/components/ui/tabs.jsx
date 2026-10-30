import { forwardRef } from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from './utils.js';

const Tabs = forwardRef(function Tabs({ className, ...props }, ref) {
  return <TabsPrimitive.Root ref={ref} data-slot="tabs" className={cn('ui-tabs', className)} {...props} />;
});
const TabsList = forwardRef(function TabsList({ className, ...props }, ref) {
  return <TabsPrimitive.List ref={ref} data-slot="tabs-list" className={cn('ui-tabs-list', className)} {...props} />;
});
const TabsTrigger = forwardRef(function TabsTrigger({ className, ...props }, ref) {
  return <TabsPrimitive.Trigger ref={ref} data-slot="tabs-trigger" className={cn('ui-tabs-trigger', className)} {...props} />;
});
const TabsContent = forwardRef(function TabsContent({ className, ...props }, ref) {
  return <TabsPrimitive.Content ref={ref} data-slot="tabs-content" className={cn('ui-tabs-content', className)} {...props} />;
});

export { Tabs, TabsList, TabsTrigger, TabsContent };

import { CaretRight } from '@phosphor-icons/react';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from './collapsible.jsx';
import { cn } from './utils.js';

// A shared disclosure composed from the shadcn Collapsible primitives.
function Disclosure({ title, children, className, ...props }) {
  return <Collapsible className={cn('ui-disclosure', className)} {...props}>
    <CollapsibleTrigger className="ui-disclosure-trigger"><CaretRight size={12} aria-hidden="true" />{title}</CollapsibleTrigger>
    <CollapsibleContent className="ui-disclosure-content">{children}</CollapsibleContent>
  </Collapsible>;
}

export { Disclosure };

# UI components

Locally owned JavaScript adaptations of the [shadcn/ui New York registry](https://ui.shadcn.com/r/styles/new-york/checkbox.json). The shared library covers Button, Input, Textarea, Checkbox, Switch, Slider, Tabs, Select, Dialog, Alert Dialog, Dropdown Menu, Popover, Collapsible and Scroll Area. Disclosure composes Collapsible. These use the original Radix primitives, composition and controlled-state APIs. The registry's Tailwind classes are translated to `ui.css` so Covelet keeps its existing theme tokens and does not acquire a global CSS reset. Icons use the existing Phosphor dependency.

All first-party screens use these controls. Specialized Button/Input variants retain the navigation tiles, widget artwork, drag geometry, inline titles, search field and custom color controls. Form switches and selection checkboxes are separate primitives; slider values are arrays. The application Select adapter keeps original typed option values instead of coercing numbers/booleans to strings. Dialogs use focus scopes and viewport positioning without a transform, allowing nested floating controls to portal into the owning theme/dialog surface. The existing Folio editor and its content remain unchanged.

Import individual component files rather than a barrel from service-worker code. Load `ui.css` in each UI entry. Do not add global native checkbox/switch styling or a global reset. Use the owning floating container for Select, Popover and nested confirmation portals. Component modules never fetch code from a registry at runtime.

Upstream sources: https://github.com/shadcn-ui/ui/tree/main/apps/www/registry/new-york/ui

Original shadcn/ui code is MIT licensed; see `LICENSE.shadcn`. Package dependencies retain their own licenses. Their distribution notices are included in `public/UI_LICENSES.txt`. Components and dependencies ship locally in the extension; no registry or component code is fetched at runtime.

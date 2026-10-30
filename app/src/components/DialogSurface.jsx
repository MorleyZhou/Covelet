import { createContext, useContext } from 'react';

// Floating controls stay inside the owning shadcn dialog's focus/theme scope,
// outside its independently scrolling content panes.
// null is an owning dialog whose DOM is still mounting; undefined is outside
// a dialog, where a top-layer prompt can use the document body.
export const DialogSurface = createContext(undefined);
export const useDialogSurface = () => useContext(DialogSurface);

export function useFloatingContainer() {
  const surface = useDialogSurface();
  return surface === undefined
    ? globalThis.document?.querySelector('.owntab, .quick-add') || globalThis.document?.body
    : surface;
}

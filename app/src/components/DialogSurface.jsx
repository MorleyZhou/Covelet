import { createContext, useContext } from 'react';

// Floating editor controls belong inside the native dialog's top layer, but
// outside its independently scrolling content panes.
// null is an owning dialog whose DOM is still mounting; undefined is outside
// a dialog, where a top-layer prompt can use the document body.
export const DialogSurface = createContext(undefined);
export const useDialogSurface = () => useContext(DialogSurface);

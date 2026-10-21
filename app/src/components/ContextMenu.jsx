import { tr, getLocale } from "../i18n/index.js";
import { useLayoutEffect, useRef, useState } from "react";

/** A context menu that stays in its caller's DOM tree, including modal dialogs. */
export default function ContextMenu({ context, items = [], onClose, label = tr("网站操作") }) {
  const menuRef = useRef(null);
  const itemRefs = useRef([]);
  const [position, setPosition] = useState(null);

  useLayoutEffect(() => {
    if (!context) return;
    function place() {
      const menu = menuRef.current;
      if (!menu) return;
      const bounds = menu.getBoundingClientRect();
      const x = Number.isFinite(context.x) ? context.x : 8;
      const y = Number.isFinite(context.y) ? context.y : 8;
      setPosition({
        left: Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8)),
        top: Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8)),
      });
    }
    place();
    itemRefs.current.find((element) => element && !element.disabled)?.focus({ preventScroll: true });
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [context]);

  function focusSource() {
    if (context?.source?.isConnected) context.source.focus({ preventScroll: true });
  }

  function handleKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      // A folder's dialog must stay open when dismissing only its menu.
      event.stopPropagation();
      onClose();
      focusSource();
      return;
    }
    if (event.key === "Tab") {
      // Resume the ordinary tab sequence from the tile that opened the menu.
      focusSource();
      onClose();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const buttons = itemRefs.current.filter((element) => element && !element.disabled);
    if (!buttons.length) return;
    const active = buttons.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? buttons.length - 1
        : event.key === "ArrowDown" ? (active + 1) % buttons.length
          : (active <= 0 ? buttons.length : active) - 1;
    buttons[next].focus({ preventScroll: true });
  }

  if (!context) return null;
  return (
    <div
      ref={menuRef}
      className="popover context-menu"
      data-popover
      role="menu"
      aria-label={label}
      onKeyDown={handleKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      style={{
        left: position?.left ?? context.x ?? 8,
        top: position?.top ?? context.y ?? 8,
        minWidth: "min(200px, calc(100vw - 16px))",
        maxWidth: "calc(100vw - 16px)",
        maxHeight: "calc(100dvh - 16px)",
        overflow: "auto",
      }}
    >
      {items.map((item, index) => item.divider ? (
        <div key={`divider-${index}`} className="popover-divider" role="separator" />
      ) : (
        <button
          key={`${item.label}-${index}`}
          ref={(element) => { itemRefs.current[index] = element; }}
          type="button"
          role="menuitem"
          disabled={Boolean(item.disabled)}
          tabIndex={-1}
          className={item.danger ? "danger" : undefined}
          onClick={() => {
            onClose();
            item.action?.();
          }}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  );
}

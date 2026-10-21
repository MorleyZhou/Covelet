import { tr, getLocale } from "../i18n/index.js";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { CaretDown, Check } from "@phosphor-icons/react";
import "./select.css";

/** A select-only combobox. Values are passed through without string coercion. */
export default function Select({
  label,
  value,
  onChange,
  options = [],
  disabled = false,
  placeholder = tr("请选择"),
  id,
  "aria-describedby": describedBy,
}) {
  const generatedId = useId();
  const controlId = id || `own-select-${generatedId}`;
  const labelId = `${controlId}-label`;
  const menuId = `${controlId}-listbox`;
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const optionRefs = useRef([]);
  const typeaheadRef = useRef({ text: "", time: 0 });
  const previousValueRef = useRef(value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(null);
  const [position, setPosition] = useState(null);
  const nativePopover = typeof HTMLElement !== "undefined" &&
    typeof HTMLElement.prototype.showPopover === "function";
  const selectedIndex = options.findIndex((option) => Object.is(option.value, value));
  const activeIndex = active
    ? options.findIndex((option) => Object.is(option.value, active.value))
    : -1;
  const unavailable = disabled || !options.some((option) => !option.disabled);

  function focusTrigger() {
    triggerRef.current?.focus({ preventScroll: true });
  }

  function close(restoreFocus = false) {
    setOpen(false);
    typeaheadRef.current = { text: "", time: 0 };
    if (restoreFocus) focusTrigger();
  }

  function activate(index) {
    const option = options[index];
    if (option && !option.disabled) setActive({ value: option.value });
  }

  function show(edge) {
    if (unavailable) return;
    const selected = selectedIndex >= 0 && !options[selectedIndex].disabled
      ? selectedIndex : -1;
    const first = options.findIndex((option) => !option.disabled);
    const last = options.findLastIndex((option) => !option.disabled);
    activate(edge === "first" ? first : edge === "last" ? last : selected >= 0 ? selected : first);
    setPosition(null);
    setOpen(true);
  }

  function choose(index) {
    const option = options[index];
    if (!option || option.disabled || unavailable) return;
    close(true);
    if (!Object.is(value, option.value)) onChange?.(option.value);
  }

  function move(direction) {
    for (let distance = 1; distance <= options.length; distance += 1) {
      const next = (activeIndex + direction * distance + options.length) % options.length;
      if (!options[next].disabled) {
        activate(next);
        return;
      }
    }
  }

  function typeahead(key) {
    const now = Date.now();
    const previous = typeaheadRef.current;
    let text = now - previous.time < 700 ? previous.text + key : key;
    // Repeated letters cycle through matching choices instead of forming "aaa".
    const characters = Array.from(text);
    const repeated = characters.every((character) => character === characters[0]);
    const search = (repeated ? characters[0] : text).toLocaleLowerCase(getLocale());
    typeaheadRef.current = { text, time: now };
    const start = repeated || previous.text.length === 0 || now - previous.time >= 700
      ? activeIndex + 1 : activeIndex;
    for (let offset = 0; offset < options.length; offset += 1) {
      const index = (Math.max(0, start) + offset) % options.length;
      const option = options[index];
      if (!option.disabled && String(option.label).trim().toLocaleLowerCase(getLocale()).startsWith(search)) {
        activate(index);
        return;
      }
    }
  }

  function onKeyDown(event) {
    if (event.nativeEvent?.isComposing || event.isComposing || unavailable) return;
    const key = event.key;
    if (key === "Tab") {
      if (open) close();
      return;
    }
    if (key === "Escape") {
      if (!open) return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(key)) {
      event.preventDefault();
      event.stopPropagation();
      typeaheadRef.current = { text: "", time: 0 };
      if (!open) {
        show(key === "Home" ? "first" : key === "End" ? "last" : undefined);
      } else if (key === "Enter" || key === " ") {
        choose(activeIndex);
      } else if (key === "Home") {
        activate(options.findIndex((option) => !option.disabled));
      } else if (key === "End") {
        activate(options.findLastIndex((option) => !option.disabled));
      } else {
        move(key === "ArrowDown" ? 1 : -1);
      }
      return;
    }
    if (key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      if (!open) show();
      typeahead(key);
    }
  }

  useEffect(() => {
    if (unavailable && open) close();
    if (!open) {
      previousValueRef.current = value;
      return;
    }
    const changed = !Object.is(previousValueRef.current, value);
    previousValueRef.current = value;
    if (changed || activeIndex < 0 || options[activeIndex]?.disabled) {
      const next = selectedIndex >= 0 && !options[selectedIndex].disabled
        ? selectedIndex : options.findIndex((option) => !option.disabled);
      if (next >= 0) activate(next);
    }
  }, [value, options, open, unavailable, activeIndex, selectedIndex]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    if (nativePopover) {
      if (open && !menu.matches(":popover-open")) menu.showPopover();
      if (!open && menu.matches(":popover-open")) menu.hidePopover();
    }
    if (!open) return;

    let frame;
    function positionMenu() {
      const trigger = triggerRef.current;
      if (!trigger || !menu.isConnected) return;
      const anchor = trigger.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft || 0;
      const viewportTop = viewport?.offsetTop || 0;
      const viewportWidth = viewport?.width || window.innerWidth;
      const viewportHeight = viewport?.height || window.innerHeight;
      const margin = 10;
      const gap = 7;
      const bottom = viewportTop + viewportHeight - margin;
      const top = viewportTop + margin;
      if (anchor.bottom < top || anchor.top > bottom) {
        setOpen(false);
        return;
      }
      const width = Math.min(Math.max(anchor.width, 200), viewportWidth - margin * 2);
      const below = Math.max(0, bottom - anchor.bottom - gap);
      const above = Math.max(0, anchor.top - gap - top);
      const desiredHeight = Math.min(menu.scrollHeight || options.length * 40 + 14, 320);
      const flip = below < desiredHeight && above > below;
      const maxHeight = Math.max(0, Math.min(320, flip ? above : below));
      const height = Math.min(desiredHeight, maxHeight);
      const next = {
        left: Math.max(viewportLeft + margin, Math.min(anchor.left, viewportLeft + viewportWidth - margin - width)),
        top: flip ? Math.max(top, anchor.top - gap - height) : anchor.bottom + gap,
        width,
        maxHeight,
      };
      setPosition((current) => current && Object.keys(next).every((key) => current[key] === next[key])
        ? current : next);
    }
    function schedulePosition() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(positionMenu);
    }
    positionMenu();
    const observer = new ResizeObserver(schedulePosition);
    observer.observe(triggerRef.current);
    observer.observe(menu);
    window.addEventListener("resize", schedulePosition);
    window.addEventListener("scroll", schedulePosition, true);
    window.visualViewport?.addEventListener("resize", schedulePosition);
    window.visualViewport?.addEventListener("scroll", schedulePosition);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedulePosition);
      window.removeEventListener("scroll", schedulePosition, true);
      window.visualViewport?.removeEventListener("resize", schedulePosition);
      window.visualViewport?.removeEventListener("scroll", schedulePosition);
    };
  }, [open, nativePopover, options]);

  useLayoutEffect(() => {
    if (!open || !position || activeIndex < 0) return;
    const menu = menuRef.current;
    const option = optionRefs.current[activeIndex];
    if (!menu || !option) return;
    const optionTop = option.offsetTop;
    const optionBottom = optionTop + option.offsetHeight;
    if (optionTop < menu.scrollTop) menu.scrollTop = optionTop;
    else if (optionBottom > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = optionBottom - menu.clientHeight;
    }
  }, [activeIndex, open, position]);

  useEffect(() => {
    if (!open) return;
    function outside(event) {
      if (!triggerRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) close();
    }
    function focusOutside(event) {
      if (!triggerRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) close();
    }
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", focusOutside);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", focusOutside);
    };
  }, [open]);

  return (
    <div className="own-select">
      <span className="own-select-label" id={labelId}>{label}</span>
      <button
        ref={triggerRef}
        id={controlId}
        type="button"
        className="own-select-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        aria-activedescendant={open && activeIndex >= 0 ? `${menuId}-option-${activeIndex}` : undefined}
        disabled={unavailable}
        data-placeholder={selectedIndex < 0 || undefined}
        onClick={() => open ? close() : show()}
        onKeyDown={onKeyDown}
        onBlur={(event) => {
          if (open && !menuRef.current?.contains(event.relatedTarget)) close();
        }}
      >
        <span className="own-select-value">{selectedIndex >= 0 ? options[selectedIndex].label : placeholder}</span>
        <CaretDown size={15} weight="bold" aria-hidden="true" />
      </button>
      <div
        ref={menuRef}
        id={menuId}
        className="own-select-menu"
        role="listbox"
        aria-labelledby={labelId}
        popover={nativePopover ? "auto" : undefined}
        hidden={nativePopover ? undefined : !open}
        style={{ ...position, visibility: open && position ? "visible" : "hidden" }}
        onToggle={(event) => {
          if ((event.nativeEvent?.newState || event.newState) === "closed") close();
        }}
      >
        {options.map((option, index) => (
          <div
            key={`${String(option.value)}-${index}`}
            ref={(element) => { optionRefs.current[index] = element; }}
            id={`${menuId}-option-${index}`}
            role="option"
            className="own-select-option"
            aria-selected={index === selectedIndex}
            aria-disabled={option.disabled || undefined}
            data-active={open && index === activeIndex || undefined}
            onPointerDown={(event) => event.preventDefault()}
            onPointerMove={() => activate(index)}
            onClick={() => choose(index)}
          >
            <span>{option.label}</span>
            {index === selectedIndex && <Check size={16} weight="bold" aria-hidden="true" />}
          </div>
        ))}
      </div>
    </div>
  );
}

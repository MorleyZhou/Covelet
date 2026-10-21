import { tr, getLocale } from "../i18n/index.js";
import { useEffect, useId, useRef, useState } from "react";
import { DEFAULT_ICON_BACKGROUND } from "../lib/model.js";

export default function IconBackground({ value = DEFAULT_ICON_BACKGROUND, onChange, onReset, preview }) {
  const [hex, setHex] = useState(value);
  const [open, setOpen] = useState(false);
  const ref = useRef(null), trigger = useRef(null), id = useId();
  useEffect(() => setHex(value), [value]);
  useEffect(() => {
    if (!open) return;
    const outside = (event) => { if (!ref.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", outside); };
  }, [open]);
  return <fieldset className="icon-appearance">
    <legend>{tr("图标")}</legend>
    <div className="icon-appearance-row">
      <div className="icon-appearance-preview" aria-label={tr("图标预览")}>{preview}</div>
      <div className="icon-color-menu" ref={ref} onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
        }
      }}>
        <button type="button" className="button icon-color-trigger" ref={trigger} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}><span style={{ backgroundColor: value }} aria-hidden="true" />{tr("背景色")}</button>
        {open && <div className="icon-color-controls" id={id} role="group" aria-label={tr("图标背景色")}>
        <input className="icon-color-picker" type="color" aria-label={tr("选择图标背景色")} value={value}
          onChange={(event) => onChange(event.target.value)} />
        <input className="icon-color-hex" aria-label={tr("图标背景色 HEX")} spellCheck={false} maxLength={7} value={hex}
          onChange={(event) => {
            const next = event.target.value;
            setHex(next);
            if (/^#[a-f\d]{6}$/i.test(next)) onChange(next.toLowerCase());
          }}
          onBlur={() => setHex(value)} />
        <button className="button quiet" type="button" onClick={() => onReset ? onReset() : onChange(DEFAULT_ICON_BACKGROUND)}>{onReset ? tr("自动") : tr("恢复默认")}</button>
        </div>}
      </div>
    </div>
  </fieldset>;
}

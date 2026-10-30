import { tr, getLocale } from "../i18n/index.js";
import { useEffect, useId, useState } from "react";
import { DEFAULT_ICON_BACKGROUND } from "../lib/model.js";
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover.jsx';
import { useFloatingContainer } from './DialogSurface.jsx';
import { Button } from './ui/button.jsx';
import { Input } from './ui/input.jsx';

export default function IconBackground({ value = DEFAULT_ICON_BACKGROUND, onChange, onReset, preview }) {
  const [hex, setHex] = useState(value);
  const [open, setOpen] = useState(false);
  const id = useId(), container = useFloatingContainer();
  useEffect(() => setHex(value), [value]);
  return <fieldset className="icon-appearance">
    <legend>{tr("图标")}</legend>
    <div className="icon-appearance-row">
      <div className="icon-appearance-preview" aria-label={tr("图标预览")}>{preview}</div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild><Button variant="secondary" type="button" className="button icon-color-trigger" aria-controls={id}><span style={{ backgroundColor: value }} aria-hidden="true" />{tr("背景色")}</Button></PopoverTrigger>
        {container && <PopoverContent container={container} className="icon-color-controls" id={id} aria-label={tr("图标背景色")} onEscapeKeyDown={(event) => event.stopPropagation()}>
        <Input className="icon-color-picker" type="color" aria-label={tr("选择图标背景色")} value={value}
          onChange={(event) => onChange(event.target.value)} />
        <Input className="icon-color-hex" aria-label={tr("图标背景色 HEX")} spellCheck={false} maxLength={7} value={hex}
          onChange={(event) => {
            const next = event.target.value;
            setHex(next);
            if (/^#[a-f\d]{6}$/i.test(next)) onChange(next.toLowerCase());
          }}
          onBlur={() => setHex(value)} />
        <Button variant="ghost" className="button quiet" type="button" onClick={() => onReset ? onReset() : onChange(DEFAULT_ICON_BACKGROUND)}>{onReset ? tr("自动") : tr("恢复默认")}</Button>
        </PopoverContent>}
      </Popover>
    </div>
  </fieldset>;
}

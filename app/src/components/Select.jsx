import { useId } from 'react';
import { tr } from '../i18n/index.js';
import { useFloatingContainer } from './DialogSurface.jsx';
import { Select as SelectRoot, SelectTrigger, SelectValue, SelectContent, SelectItem } from './ui/select.jsx';
import './select.css';

// Keep the application API and typed values; only Radix's internal keys are strings.
export default function Select({ label, value, onChange, options = [], disabled = false, placeholder = tr('请选择'), id, 'aria-describedby': describedBy }) {
  const generatedId = useId(), container = useFloatingContainer();
  const controlId = id || `covelet-select-${generatedId}`;
  const index = options.findIndex((option) => Object.is(option.value, value));
  return <div className="own-select">
    {label && <label className="own-select-label" id={`${controlId}-label`} htmlFor={controlId}>{label}</label>}
    <SelectRoot value={index < 0 ? '' : `option-${index}`} disabled={disabled || !options.some((option) => !option.disabled)} onValueChange={(key) => {
      const option = options[Number(key.slice(7))];
      if (option && !option.disabled && !Object.is(option.value, value)) onChange?.(option.value);
    }}>
      <SelectTrigger id={controlId} aria-labelledby={label ? `${controlId}-label` : undefined} aria-label={label ? undefined : placeholder} aria-describedby={describedBy}>
        <SelectValue data-slot="select-value" placeholder={placeholder} />
      </SelectTrigger>
      {container && <SelectContent container={container} onEscapeKeyDown={(event) => event.stopPropagation()}>
        {options.map((option, at) => <SelectItem key={`option-${at}`} value={`option-${at}`} disabled={option.disabled} textValue={String(option.label)}>{option.label}</SelectItem>)}
      </SelectContent>}
    </SelectRoot>
  </div>;
}

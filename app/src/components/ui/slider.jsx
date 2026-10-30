import { forwardRef } from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';
import { cn } from './utils.js';

// shadcn/ui New York Slider; controlled values use the upstream array API.
const Slider = forwardRef(function Slider({ className, value, defaultValue, min = 0, max = 100, 'aria-label': label, 'aria-labelledby': labelledBy, ...props }, ref) {
  const values = value || defaultValue || [min];
  return <SliderPrimitive.Root ref={ref} data-slot="slider" value={value} defaultValue={defaultValue} min={min} max={max} className={cn('ui-slider', className)} {...props}>
    <SliderPrimitive.Track data-slot="slider-track" className="ui-slider-track"><SliderPrimitive.Range data-slot="slider-range" className="ui-slider-range" /></SliderPrimitive.Track>
    {values.map((_, index) => <SliderPrimitive.Thumb key={index} data-slot="slider-thumb" className="ui-slider-thumb" aria-label={label} aria-labelledby={labelledBy} />)}
  </SliderPrimitive.Root>;
});

export { Slider };

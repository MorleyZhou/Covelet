import { tr, getLocale } from "../i18n/index.js";
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Globe, Plus, Trash, X } from '@phosphor-icons/react';
import Select from './Select.jsx';
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover.jsx';
import { useFloatingContainer } from './DialogSurface.jsx';
import {
  createColorBackground, colorBackgroundCss, readColorConfig, GRADIENT_CURVES, MAX_BACKGROUND_COLORS,
  hexToHsv, hsvToHex, fullHex,
} from '../lib/background-colors.js';
import './background-picker.css';
import { Button } from './ui/button.jsx';
import { Slider } from './ui/slider.jsx';
import { Input } from './ui/input.jsx';

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const round = (value) => Math.round(value * 100) / 100;
const isColor = (background) => ['color', 'gradient'].includes(background.kind);

function ColorPicker({ color, onChange }) {
  const [hsv, setHsv] = useState(() => hexToHsv(color));
  const [hex, setHex] = useState(color);
  useEffect(() => {
    setHex(color);
    setHsv((current) => hsvToHex(current) === color ? current : hexToHsv(color));
  }, [color]);
  function update(next) {
    const value = { ...hsv, ...next };
    setHsv(value);
    onChange(hsvToHex(value));
  }
  function point(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    update({ s: clamp((event.clientX - rect.left) / rect.width) * 100, v: (1 - clamp((event.clientY - rect.top) / rect.height)) * 100 });
  }
  return <div className="background-color-picker">
    <Button variant="unstyled" size="unstyled" type="button" className="color-plane" aria-label={tr("饱和度与亮度，{0}%，{1}%", [Math.round(hsv.s), Math.round(hsv.v)])}
      aria-description={tr("左右方向键调整饱和度，上下方向键调整亮度，按住 Shift 加快调整。")}
      style={{ '--color-hue': `hsl(${hsv.h} 100% 50%)` }}
      onPointerDown={(event) => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); point(event); }}
      onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) point(event); }}
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        update({ s: clamp(hsv.s + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0), 0, 100),
          v: clamp(hsv.v + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0), 0, 100) });
      }}>
      <span className="color-plane-point" style={{ left: `${hsv.s}%`, top: `${100 - hsv.v}%` }} />
    </Button>
    <Slider className="color-hue" aria-label={tr("色相")} min={0} max={359} step={1} value={[Number(Math.round(hsv.h))]}
      onValueChange={([nextValue]) => update({ h: Number(nextValue) })} />
    <label className="color-hex-row"><span>HEX</span><Input unstyled className="background-editor-input" aria-label={tr("背景颜色 HEX")} value={hex} spellCheck={false} maxLength={7}
      onChange={(event) => {
        const next = event.target.value;
        setHex(next);
        if (/^#[a-f\d]{6}$/i.test(next)) onChange(fullHex(next));
      }} onBlur={() => {
        if (/^#[a-f\d]{3}$/i.test(hex)) onChange(fullHex(hex));
        else setHex(color);
      }} /></label>
  </div>;
}

function CurveEditor({ value, onChange }) {
  const graph = useRef(null), drag = useRef(null);
  const [x1, y1, x2, y2] = value;
  const preset = GRADIENT_CURVES.find((item) => item.points.every((point, index) => point === value[index]))?.value || 'custom';
  function move(event) {
    if (drag.current === null) return;
    const rect = graph.current.getBoundingClientRect();
    const index = drag.current, next = [...value];
    next[index * 2] = round(clamp((event.clientX - rect.left - 14) / (rect.width - 28)));
    next[index * 2 + 1] = round(1 - clamp((event.clientY - rect.top - 14) / (rect.height - 28)));
    onChange(next);
  }
  return <div className="gradient-curve-editor">
    <Select label={tr("渐变曲线")} value={preset} options={[...GRADIENT_CURVES, { value: 'custom', label: tr("自定") }]}
      onChange={(selected) => onChange([...(GRADIENT_CURVES.find((item) => item.value === selected)?.points || [0.25, 0.1, 0.25, 1])])} />
    <div className="gradient-curve-graph" ref={graph}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <path className="curve-diagonal" d="M0 100L100 0" />
        <path className="curve-handle-line" d={`M0 100L${x1 * 100} ${100 - y1 * 100}M100 0L${x2 * 100} ${100 - y2 * 100}`} />
        <path className="curve-path" d={`M0 100C${x1 * 100} ${100 - y1 * 100},${x2 * 100} ${100 - y2 * 100},100 0`} />
      </svg>
      {[0, 1].map((index) => <Button variant="unstyled" size="unstyled" type="button" key={index} className="curve-control-point"
        aria-label={tr("曲线控制点 {0}，X {1}，Y {2}", [index + 1, value[index * 2], value[index * 2 + 1]])}
        style={{ left: `calc(${value[index * 2] * 100}% + ${14 - 28 * value[index * 2]}px)`, top: `calc(${(1 - value[index * 2 + 1]) * 100}% + ${14 - 28 * (1 - value[index * 2 + 1])}px)` }}
        onPointerDown={(event) => { if (event.button !== 0) return; drag.current = index; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) move(event); }}
        onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault();
          const step = event.shiftKey ? 0.1 : 0.01, next = [...value];
          const at = index * 2 + (['ArrowUp', 'ArrowDown'].includes(event.key) ? 1 : 0);
          next[at] = round(clamp(next[at] + (['ArrowRight', 'ArrowUp'].includes(event.key) ? step : -step)));
          onChange(next);
        }} />)}
    </div>
    <div className="curve-coordinates">
      {['X1', 'Y1', 'X2', 'Y2'].map((label, index) => <label key={label}><span>{label}</span>
        <Input unstyled type="number" className="background-editor-input" aria-label={tr("曲线 {0}", [label])} min="0" max="1" step="0.01" value={value[index]}
          onChange={(event) => {
            if (event.target.value === '' || !Number.isFinite(event.target.valueAsNumber)) return;
            const next = [...value]; next[index] = round(clamp(event.target.valueAsNumber)); onChange(next);
          }} />
      </label>)}
    </div>
  </div>;
}

export default function BackgroundPicker({ value, onChange, wallpaper }) {
  const [config, setConfig] = useState(() => readColorConfig(value));
  const [active, setActive] = useState(0), [open, setOpen] = useState(false);
  const custom = useRef(isColor(value) ? value : createColorBackground(config));
  const trigger = useRef(null), panel = useRef(null), title = useRef(null);
  const colorButtons = useRef([]), pendingColorFocus = useRef(null);
  const id = useId();
  const container = useFloatingContainer();
  const selected = isColor(value);
  useEffect(() => {
    if (!isColor(value)) return;
    custom.current = value;
    const next = readColorConfig(value);
    setConfig((current) => value.kind === 'color' ? { ...current, colors: next.colors } : next);
    setActive((current) => Math.min(current, next.colors.length - 1));
  }, [value]);

  function close(restoreFocus = false) { setOpen(false); if (restoreFocus) trigger.current?.focus({ preventScroll: true }); }
  function change(next) {
    setConfig(next);
    const background = createColorBackground(next);
    custom.current = background; onChange(background);
  }
  useLayoutEffect(() => {
    if (pendingColorFocus.current === null) return;
    colorButtons.current[pendingColorFocus.current]?.focus({ preventScroll: true });
    pendingColorFocus.current = null;
  }, [config.colors.length]);
  return <Popover open={open} onOpenChange={setOpen}><fieldset className="background-settings">
    <legend>{tr("背景")}</legend>
    <div className="background-options">
      <Button variant="unstyled" size="unstyled" type="button" className={`background-choice daily-choice ${value.kind === 'bing' ? 'selected' : ''}`}
        aria-pressed={value.kind === 'bing'} onClick={() => { close(); onChange({ kind: 'bing', value: 'daily' }); }}>
        <Globe size={29} aria-hidden="true" /><span>{tr("Bing 每日壁纸")}</span>
      </Button>
      <PopoverTrigger asChild><Button variant="unstyled" size="unstyled" type="button" ref={trigger} className={`background-choice color-choice ${selected ? 'selected' : ''}`}
        aria-pressed={selected} aria-haspopup="dialog" aria-expanded={open} aria-controls={id}
        onClick={() => { if (!selected) onChange(custom.current); }}>
        <span className="background-choice-swatch" style={{ background: colorBackgroundCss(selected ? value : custom.current) }} aria-hidden="true" />
        <span>{tr("颜色")}</span>
      </Button></PopoverTrigger>
    </div>
    {value.kind === 'bing' && (wallpaper?.stale || wallpaper?.source === 'builtin') && <p className="hint" role="status">
      {wallpaper.stale ? tr("壁纸暂未更新，正在使用上次壁纸。") : tr("每日壁纸暂不可用，正在使用内置背景。")}
    </p>}
    {container && <PopoverContent container={container} ref={panel} id={id} className="background-color-panel" side="right" align="start" aria-labelledby={`${id}-title`}
      onOpenAutoFocus={(event) => { event.preventDefault(); title.current?.focus({ preventScroll: true }); }}
      onEscapeKeyDown={(event) => event.stopPropagation()}>
      <div className="background-panel-header">
        <h3 id={`${id}-title`} ref={title} tabIndex={-1}>{tr("颜色")}</h3>
        <Button variant="unstyled" size="unstyled" type="button" className="icon-button" aria-label={tr("关闭颜色选择器")} onClick={() => close(true)}><X size={19} /></Button>
      </div>
      <div className="background-panel-body">
        <div className="background-colors" role="group" aria-label={tr("背景颜色")}>
          {config.colors.map((color, index) => <Button variant="unstyled" size="unstyled" type="button" key={index} className="background-color-stop"
            ref={(element) => { colorButtons.current[index] = element; }}
            aria-label={tr("颜色 {0}，{1}", [index + 1, color])} aria-pressed={active === index} style={{ backgroundColor: color }} onClick={() => setActive(index)} />)}
          <Button variant="unstyled" size="unstyled" type="button" className="background-color-add" aria-label={tr("添加颜色")} disabled={config.colors.length >= MAX_BACKGROUND_COLORS}
            onClick={() => {
              const last = hexToHsv(config.colors.at(-1));
              pendingColorFocus.current = config.colors.length;
              change({ ...config, colors: [...config.colors, hsvToHex({ h: last.h + 45, s: Math.max(last.s, 22), v: Math.min(100, last.v + 10) })] });
              setActive(config.colors.length);
            }}><Plus size={19} /></Button>
          {config.colors.length > 1 && <Button variant="unstyled" size="unstyled" type="button" className="background-color-remove" aria-label={tr("移除颜色 {0}", [active + 1])}
            onClick={() => {
              pendingColorFocus.current = Math.max(0, active - 1);
              change({ ...config, colors: config.colors.filter((_, index) => index !== active) }); setActive(pendingColorFocus.current);
            }}><Trash size={18} /></Button>}
        </div>
        <ColorPicker key={active} color={config.colors[active]} onChange={(color) => change({ ...config, colors: config.colors.map((value, index) => index === active ? color : value) })} />
        {config.colors.length > 1 && <>
          <div className="gradient-preview" role="img" aria-label={tr("渐变预览")} style={{ background: colorBackgroundCss(custom.current) }} />
          <label className="gradient-direction"><span>{tr("方向")}<output>{config.angle}°</output></span>
            <Slider aria-label={tr("渐变方向")} min={0} max={360} step={1} value={[Number(config.angle)]}
              onValueChange={([nextValue]) => change({ ...config, angle: Number(nextValue) })} />
          </label>
          <CurveEditor value={config.curve} onChange={(curve) => change({ ...config, curve })} />
        </>}
      </div>
    </PopoverContent>}
  </fieldset></Popover>;
}

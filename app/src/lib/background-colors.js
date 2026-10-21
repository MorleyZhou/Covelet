import { tr, getLocale } from "../i18n/index.js";
export const MAX_BACKGROUND_COLORS = 8;
export const DEFAULT_BACKGROUND_COLOR = '#cedbd9';
export const GRADIENT_CURVES = [
  { value: 'linear', get label() { return tr("线性"); }, points: [0, 0, 1, 1] },
  { value: 'smooth', get label() { return tr("平滑"); }, points: [0.42, 0, 0.58, 1] },
  { value: 'in', get label() { return tr("渐入"); }, points: [0.42, 0, 1, 1] },
  { value: 'out', get label() { return tr("渐出"); }, points: [0, 0, 0.58, 1] },
];

export function fullHex(value) {
  if (/^#[a-f\d]{3}$/i.test(value)) return `#${[...value.slice(1)].map((part) => part + part).join('')}`.toLowerCase();
  return value.toLowerCase();
}

export function validateGradient(gradient) {
  if (!gradient || typeof gradient !== 'object' || Array.isArray(gradient)
    || Object.keys(gradient).some((key) => !['colors', 'angle', 'curve'].includes(key))) throw Error(tr("渐变设置无效"));
  if (!Array.isArray(gradient.colors) || gradient.colors.length < 2 || gradient.colors.length > MAX_BACKGROUND_COLORS
    || Array.from(gradient.colors).some((color) => typeof color !== 'string' || !/^#[a-f\d]{6}$/i.test(color))) throw Error(tr("渐变需要 2 至 8 个颜色"));
  if (!Number.isInteger(gradient.angle) || gradient.angle < 0 || gradient.angle > 360) throw Error(tr("渐变方向无效"));
  if (!Array.isArray(gradient.curve) || gradient.curve.length !== 4
    || Array.from(gradient.curve).some((point) => !Number.isFinite(point) || point < 0 || point > 1)) throw Error(tr("渐变曲线无效"));
  return gradient;
}

const bezier = (t, a, b) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;

// CSS gradients have no easing API. Sample a bounded cubic Bezier per color
// interval, so editing the curve changes the actual wallpaper interpolation.
export function gradientProgress(x, [x1, y1, x2, y2]) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (x1 === y1 && x2 === y2) return x;
  let low = 0, high = 1;
  for (let step = 0; step < 24; step++) {
    const mid = (low + high) / 2;
    if (bezier(mid, x1, x2) < x) low = mid;
    else high = mid;
  }
  return bezier((low + high) / 2, y1, y2);
}

const channels = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
const hexColor = (rgb) => `#${rgb.map((value) => Math.round(value).toString(16).padStart(2, '0')).join('')}`;
const mix = (from, to, progress) => hexColor(channels(from).map((value, index) => value + (channels(to)[index] - value) * progress));
const percent = (number) => Number((number * 100).toFixed(2));

export function gradientColorStops(gradient) {
  validateGradient(gradient);
  const { colors, curve } = gradient;
  const steps = curve[0] === curve[1] && curve[2] === curve[3] ? 1 : 8;
  const stops = [{ color: colors[0], offset: 0 }];
  for (let index = 0; index < colors.length - 1; index++) {
    for (let step = 1; step <= steps; step++) {
      const fraction = step / steps;
      stops.push({ color: mix(colors[index], colors[index + 1], gradientProgress(fraction, curve)), offset: percent((index + fraction) / (colors.length - 1)) / 100 });
    }
  }
  return stops;
}

export function gradientCss(gradient) {
  const stops = gradientColorStops(gradient).map(({ color, offset }) => `${color} ${percent(offset)}%`);
  return `linear-gradient(${gradient.angle}deg, ${stops.join(', ')})`;
}

export function colorBackgroundCss(background) {
  // Define the display interpolation explicitly so CSS and the local canvas
  // sampler use the same sRGB stops. Keep the stored legacy CSS unchanged.
  return background.kind === 'gradient' && background.gradient
    ? gradientCss(background.gradient).replace('deg,', 'deg in srgb,') : background.value;
}

export function createColorBackground(config) {
  if (!config || !Array.isArray(config.colors) || config.colors.length < 1 || config.colors.length > MAX_BACKGROUND_COLORS
    || Array.from(config.colors).some((color) => typeof color !== 'string' || !/^#[a-f\d]{6}$/i.test(color))) throw Error(tr("背景颜色无效"));
  const gradient = { colors: config.colors.map(fullHex), angle: config.angle, curve: [...config.curve] };
  if (gradient.colors.length === 1) return { kind: 'color', value: gradient.colors[0] };
  return { kind: 'gradient', value: gradientCss(gradient), gradient };
}

export function readColorConfig(background) {
  if (background?.kind === 'gradient' && background.gradient) return structuredClone(background.gradient);
  const single = background?.kind === 'color' ? fullHex(background.value) : DEFAULT_BACKGROUND_COLOR;
  const base = { colors: [single], angle: 135, curve: [0, 0, 1, 1] };
  // Older simple CSS gradients remain editable. Other validated legacy CSS is
  // rendered unchanged; opening the editor alone never rewrites a saved value.
  if (background?.kind === 'gradient') {
    const match = /^linear-gradient\(\s*([+-]?[\d.]+)deg\s*,\s*(.+)\)$/i.exec(background.value);
    const stops = match?.[2].split(',').map((part) => /^\s*(#[a-f\d]{3}(?:[a-f\d]{3})?)\s*$/i.exec(part)?.[1]);
    if (stops?.length >= 2 && stops.length <= MAX_BACKGROUND_COLORS && stops.every(Boolean) && Number.isFinite(Number(match[1]))) {
      return { ...base, colors: stops.map(fullHex), angle: ((Math.round(Number(match[1])) % 360) + 360) % 360 };
    }
  }
  return base;
}

export function hexToHsv(hex) {
  const [r, g, b] = channels(fullHex(hex)).map((channel) => channel / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  let hue = 0;
  if (delta) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
  }
  return { h: (hue * 60 + 360) % 360, s: max ? delta / max * 100 : 0, v: max * 100 };
}

export function hsvToHex({ h, s, v }) {
  const saturation = Math.max(0, Math.min(100, s)) / 100, value = Math.max(0, Math.min(100, v)) / 100;
  const hue = ((h % 360) + 360) % 360 / 60;
  const chroma = value * saturation, x = chroma * (1 - Math.abs(hue % 2 - 1));
  const tuples = [[chroma, x, 0], [x, chroma, 0], [0, chroma, x], [0, x, chroma], [x, 0, chroma], [chroma, 0, x]];
  return hexColor(tuples[Math.floor(hue)].map((channel) => (channel + value - chroma) * 255));
}

import { tr, getLocale } from "../i18n/index.js";
import { gradientColorStops } from './background-colors.js';

const SHADE_STOPS = [[0, 8 / 255], [.45, 4 / 255], [1, 18 / 255]];
export const VISUAL_SHADE_BACKGROUND = `linear-gradient(180deg, ${SHADE_STOPS.map(([at, alpha]) => `rgba(0,0,0,${alpha}) ${at * 100}%`).join(', ')})`;

function canvasAt(width, height) {
  return globalThis.OffscreenCanvas ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });
}

// Structured gradients share the exact stops used by the visible CSS, including
// curve sampling. Only recognized legacy linear gradients are interpreted.
function linearGradient(background) {
  if (background.gradient) return { angle: background.gradient.angle, stops: gradientColorStops(background.gradient) };
  const match = /^linear-gradient\((.+)\)$/iu.exec(background.value);
  if (!match) return null;
  const parts = [];
  let depth = 0, start = 0;
  for (let at = 0; at < match[1].length; at++) {
    if (match[1][at] === '(') depth++;
    if (match[1][at] === ')') depth--;
    if (match[1][at] === ',' && !depth) { parts.push(match[1].slice(start, at).trim()); start = at + 1; }
  }
  parts.push(match[1].slice(start).trim());
  let angle = 180;
  if (/^[+-]?[\d.]+deg$/iu.test(parts[0])) angle = Number(parts.shift().slice(0, -3));
  else if (/^to /iu.test(parts[0])) {
    const directions = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270 };
    if (!Object.hasOwn(directions, parts[0].toLowerCase())) return null;
    angle = directions[parts.shift().toLowerCase()];
  }
  if (!Number.isFinite(angle) || parts.length < 2 || parts.length > 64) return null;
  const stops = parts.map((part) => {
    const stop = /^(.*?)(?:\s+([+-]?[\d.]+)%)?$/u.exec(part);
    return { color: stop[1].trim(), offset: stop[2] === undefined ? null : Number(stop[2]) / 100 };
  });
  if (stops.some(({ color, offset }) => !CSS.supports('color', color) || offset !== null && (!Number.isFinite(offset) || offset < 0 || offset > 1))) return null;
  stops[0].offset ??= 0;
  stops[stops.length - 1].offset ??= 1;
  for (let index = 1, previous = 0; index < stops.length; index++) {
    if (stops[index].offset === null) continue;
    stops[index].offset = Math.max(stops[previous].offset, stops[index].offset);
    for (let missing = previous + 1; missing < index; missing++) {
      stops[missing].offset = stops[previous].offset + (stops[index].offset - stops[previous].offset) * (missing - previous) / (index - previous);
    }
    previous = index;
  }
  return { angle, stops };
}

export function navigationTextStyle(node) {
  if (!node.matches('.site-name')) return null;
  const style = getComputedStyle(node);
  return { text: node.textContent || '', font: style.font || `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
    fontSize: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight), align: style.textAlign,
    direction: style.direction, spacing: style.letterSpacing, ellipsis: style.textOverflow === 'ellipsis',
    left: parseFloat(style.paddingLeft) || 0, right: parseFloat(style.paddingRight) || 0,
    top: parseFloat(style.paddingTop) || 0, clientWidth: parseFloat(style.width) || node.clientWidth };
}

function glyphMask(target, width, height, scaleX, scaleY) {
  if (!target.textStyle) return null;
  const canvas = canvasAt(width, height), context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  const { textStyle: style, box, crop } = target;
  context.scale(scaleX, scaleY); context.font = style.font; context.direction = style.direction;
  if ('letterSpacing' in context) context.letterSpacing = style.spacing === 'normal' ? '0px' : style.spacing;
  const available = Math.max(1, style.clientWidth - style.left - style.right);
  let text = style.text;
  if (style.ellipsis && context.measureText(text).width > available) {
    const letters = Array.from(text); let low = 0, high = letters.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (context.measureText(`${letters.slice(0, middle).join('')}…`).width <= available) low = middle;
      else high = middle - 1;
    }
    text = `${letters.slice(0, low).join('')}…`;
  }
  const metrics = context.measureText(text), ascent = metrics.fontBoundingBoxAscent ?? style.fontSize * .85;
  const descent = metrics.fontBoundingBoxDescent ?? style.fontSize * .25;
  const lineHeight = style.lineHeight || style.fontSize * 1.2;
  const y = box.top - crop.top + style.top + (lineHeight - ascent - descent) / 2 + ascent;
  const align = style.align === 'center' ? 'center' : style.align === 'right' || style.align === 'end' && style.direction !== 'rtl' || style.align === 'start' && style.direction === 'rtl' ? 'right' : 'left';
  const x = box.left - crop.left + style.left + (align === 'center' ? available / 2 : align === 'right' ? available : 0);
  context.textAlign = align; context.textBaseline = 'alphabetic'; context.fillStyle = '#fff'; context.strokeStyle = '#fff';
  context.lineWidth = .5; context.fillText(text, x, y); context.strokeText(text, x, y);
  const data = context.getImageData(0, 0, width, height).data;
  return data.some((value, index) => index % 4 === 3 && value > 0) ? data : null;
}

// Retain a local background renderer and sample only each label's pixel patch.
// There is no downscaled whole-screen grid: gradients are evaluated at their
// actual screen coordinates and photos reuse the more detailed local thumbnail.
export function paintNavigationBackdrop({ background, sample, box, viewportWidth, viewportHeight, shade = 0, blur = 0 }) {
  if (!background || !box || !viewportWidth || !viewportHeight) return null;
  let image, renderedWidth, renderedHeight, config;
  if (['bing', 'builtin', 'image'].includes(background.kind)) {
    if (!sample || !(sample.pixels instanceof ArrayBuffer) || sample.pixels.byteLength !== sample.width * sample.height * 4) return null;
    image = canvasAt(sample.width, sample.height); const imageContext = image.getContext('2d');
    if (!imageContext) return null;
    imageContext.putImageData(new ImageData(new Uint8ClampedArray(sample.pixels), sample.width, sample.height), 0, 0);
    const originalWidth = sample.originalWidth || sample.width, originalHeight = sample.originalHeight || sample.height;
    const cover = Math.max(box.width / originalWidth, box.height / originalHeight);
    renderedWidth = originalWidth * cover; renderedHeight = originalHeight * cover;
  } else if (background.kind === 'gradient') {
    config = linearGradient(background);
    if (!config) return null;
  } else if (background.kind !== 'color') return null;
  return { sampleRegion(target) {
    const { crop } = target, cssWidth = crop.right - crop.left, cssHeight = crop.bottom - crop.top;
    const radius = blur * 1.025;
    const scale = Math.min(2, globalThis.devicePixelRatio || 1, 256 / cssWidth, 64 / cssHeight,
      500 / (cssWidth + 6 * radius), 500 / (cssHeight + 6 * radius));
    const width = Math.max(1, Math.floor(cssWidth * scale)), height = Math.max(1, Math.floor(cssHeight * scale));
    const sx = width / cssWidth, sy = height / cssHeight;
    const padX = Math.ceil(radius * sx * 3), padY = Math.ceil(radius * sy * 3);
    const canvas = canvasAt(width + padX * 2, height + padY * 2), context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw Error(tr("无法分析文字背景。"));
    const x = (value) => (value - crop.left) * sx + padX, y = (value) => (value - crop.top) * sy + padY;
    context.fillStyle = '#bdcfce'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.save(); context.filter = `blur(${radius * Math.max(sx, sy)}px)`;
    if (image) context.drawImage(image, x(box.left + (box.width - renderedWidth) / 2), y(box.top + (box.height - renderedHeight) / 2), renderedWidth * sx, renderedHeight * sy);
    else {
      if (config) {
        const angle = config.angle * Math.PI / 180, dx = Math.sin(angle), dy = -Math.cos(angle);
        const length = Math.abs(box.width * dx) + Math.abs(box.height * dy), cx = box.left + box.width / 2, cy = box.top + box.height / 2;
        const gradient = context.createLinearGradient(x(cx - dx * length / 2), y(cy - dy * length / 2), x(cx + dx * length / 2), y(cy + dy * length / 2));
        for (const { offset, color } of config.stops) gradient.addColorStop(offset, color);
        context.fillStyle = gradient;
      } else context.fillStyle = background.value;
      context.fillRect(x(box.left), y(box.top), box.width * sx, box.height * sy);
    }
    context.restore();
    context.fillStyle = `rgba(0,0,0,${Math.min(90, Math.max(0, shade)) / 100})`; context.fillRect(0, 0, canvas.width, canvas.height);
    const overlay = context.createLinearGradient(0, y(0), 0, y(viewportHeight));
    for (const [at, alpha] of SHADE_STOPS) overlay.addColorStop(at, `rgba(0,0,0,${alpha})`);
    context.fillStyle = overlay; context.fillRect(0, 0, canvas.width, canvas.height);
    const data = context.getImageData(padX, padY, width, height).data, mask = glyphMask(target, width, height, sx, sy);
    if (mask) for (let at = 3; at < data.length; at += 4) data[at] = mask[at];
    return { width, height, scale: Math.max(sx, sy), pixels: data.buffer };
  } };
}

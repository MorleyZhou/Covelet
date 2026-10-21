import { letterIcon, normalizeUrl } from './model.js';

/** A URL-derived name remains available before, or without, site access. */
export function fallbackSiteName(input) {
  return new URL(normalizeUrl(input)).host.replace(/^www\./iu, '');
}

/** Apply one recognition result to the current entry, never a stale form copy. */
export function applyRecognizedSite(entry, { title, icon }, { entryId, origin, preserveName = false, preserveIcon = false }) {
  if (!entry || entry.id !== entryId) return entry;
  try {
    if (new URL(normalizeUrl(entry.url)).origin !== origin) return entry;
  } catch {
    return entry;
  }
  const recognizedName = typeof title === 'string' ? title.trim() : '';
  const usableName = recognizedName.length > 0 && recognizedName.length <= 200 &&
    !/[\u0000-\u001f\u007f]/u.test(recognizedName);
  const name = !preserveName && usableName ? recognizedName : entry.name;
  const usableIcon = ['image', 'url'].includes(icon?.kind) && typeof icon.value === 'string' && icon.value.length > 0;
  return { ...entry, name, icon: usableIcon ? { ...icon } : preserveIcon && ['image', 'url'].includes(entry.icon?.kind) ? { ...entry.icon } : letterIcon(name) };
}

function luminance(hex) {
  const channels = hex.match(/../gu).map((part) => parseInt(part, 16) / 255);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

/** Choose the higher WCAG relative-luminance contrast for a solid icon color. */
export function iconTextColor(background = '#f5f5f7') {
  let hex = typeof background === 'string' ? background.replace(/^#/u, '') : '';
  if (/^[a-f\d]{3}$/iu.test(hex)) hex = [...hex].map((digit) => digit + digit).join('');
  if (!/^[a-f\d]{6}$/iu.test(hex)) hex = 'f5f5f7';
  const lightness = luminance(hex);
  const dark = luminance('1d1d1f');
  const darkContrast = (Math.max(lightness, dark) + 0.05) / (Math.min(lightness, dark) + 0.05);
  const whiteContrast = 1.05 / (lightness + 0.05);
  return darkContrast >= whiteContrast ? '#1d1d1f' : '#fff';
}

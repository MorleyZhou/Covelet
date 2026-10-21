// Display-only colors. Saved theme, shade and icon backgrounds remain untouched.
const rgb = (hex) => /^#[a-f\d]{6}$/iu.test(hex ?? '')
  ? [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)) : null;
const hex = (color) => `#${color.map((value) => Math.round(value).toString(16).padStart(2, '0')).join('')}`;
const mix = (color, base, amount) => color.map((value, index) => Math.round(value * (1 - amount) + base[index] * amount));
function luminance(color) {
  return color.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}
export function contrastRatio(first, second) {
  const a = luminance(rgb(first)), b = luminance(rgb(second));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function accentFor(color, panel, toward) {
  for (let step = 0; step <= 64; step++) {
    const candidate = mix(color, [toward, toward, toward], step / 64);
    if (contrastRatio(hex(candidate), hex(panel)) >= 4.5) return hex(candidate);
  }
  return hex([toward, toward, toward]);
}
const textOn = (color) => contrastRatio(color, '#ffffff') >= contrastRatio(color, '#000000') ? '#ffffff' : '#000000';

export function createAdaptiveAppearance(palette, manualShade = 0) {
  const color = rgb(palette?.accent);
  if (!color || !['brightness', 'p10', 'p90'].every((key) => Number.isFinite(palette[key]) && palette[key] >= 0 && palette[key] <= 1)) return null;
  const manual = Math.min(90, Math.max(0, Number.isFinite(manualShade) ? manualShade : 0)) / 100;
  // Local label contrast handles bright and dark parts independently. Keep the
  // user's shade instead of dimming the whole photograph to suit one text color.
  const darkText = palette.p10 * (1 - manual) ** 2.2 >= 0.35;
  const lightPanel = mix(color, [255, 255, 255], 0.93);
  const darkPanel = mix(color, [29, 30, 33], 0.91);
  const lightAccent = accentFor(color, lightPanel, 0);
  const darkAccent = accentFor(color, darkPanel, 255);
  return {
    shade: manual * 100,
    style: {
      '--adaptive-panel-light': hex(lightPanel),
      '--adaptive-panel-dark': hex(darkPanel),
      '--adaptive-glass-light': `rgba(${lightPanel.join(',')},0.94)`,
      '--adaptive-glass-dark': `rgba(${darkPanel.join(',')},0.94)`,
      '--adaptive-accent-light': lightAccent,
      '--adaptive-accent-dark': darkAccent,
      '--adaptive-button-light': textOn(lightAccent),
      '--adaptive-button-dark': textOn(darkAccent),
      '--adaptive-page-ink': darkText ? '#16222e' : '#ffffff',
      '--adaptive-text-shadow': darkText ? '0 1px 2px #ffffff60' : '0 1px 2px #00000080',
    },
  };
}

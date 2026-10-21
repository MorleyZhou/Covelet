import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdaptiveAppearance, contrastRatio } from './adaptive-appearance.js';

test('adaptive appearance preserves manual shade as a floor without mutating wallpaper statistics', () => {
  const palette = { accent: '#58aabb', brightness: 0.5, p10: 0.03, p90: 0.85 };
  const original = structuredClone(palette);
  const style = createAdaptiveAppearance(palette, 72);
  assert.equal(style.shade, 72);
  assert.equal(style.style['--adaptive-page-ink'], '#ffffff');
  assert.deepEqual(palette, original);
  assert(createAdaptiveAppearance(palette, 0).shade > 0);
});

test('uniformly bright wallpaper uses dark foreground while dark wallpaper stays white without extra dimming', () => {
  const bright = createAdaptiveAppearance({ accent: '#fdf9ed', brightness: 0.95, p10: 0.9, p90: 0.98 });
  assert.equal(bright.style['--adaptive-page-ink'], '#16222e');
  assert.equal(bright.shade, 0);
  const dark = createAdaptiveAppearance({ accent: '#141f37', brightness: 0.02, p10: 0.01, p90: 0.06 });
  assert.equal(dark.style['--adaptive-page-ink'], '#ffffff');
  assert.equal(dark.shade, 0);
});

test('light and dark panel accents and button labels have readable solid-color contrast across hues', () => {
  for (const accent of ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#f7f200', '#aaaaaa', '#a066cc']) {
    const { style } = createAdaptiveAppearance({ accent, brightness: 0.4, p10: 0.1, p90: 0.7 });
    for (const theme of ['light', 'dark']) {
      assert(contrastRatio(style[`--adaptive-accent-${theme}`], style[`--adaptive-panel-${theme}`]) >= 4.5, `${accent}/${theme} accent`);
      assert(contrastRatio(style[`--adaptive-button-${theme}`], style[`--adaptive-accent-${theme}`]) >= 4.5, `${accent}/${theme} button`);
    }
  }
});

test('invalid or missing analysis does not apply a partly adaptive theme', () => {
  for (const palette of [null, {}, { accent: 'url(https://invalid)', brightness: 0, p10: 0, p90: 0 }, { accent: '#ffffff', brightness: NaN, p10: 0, p90: 1 }, { accent: '#ffffff', brightness: 1, p10: 0, p90: 100 }]) assert.equal(createAdaptiveAppearance(palette), null);
});

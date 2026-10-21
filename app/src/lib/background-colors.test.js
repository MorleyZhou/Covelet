import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, validateState, migrateNavigationState } from './model.js';
import {
  createColorBackground, readColorConfig, gradientProgress, gradientCss,
  GRADIENT_CURVES, MAX_BACKGROUND_COLORS, fullHex, hexToHsv, hsvToHex,
} from './background-colors.js';

const config = (patch = {}) => ({ colors: ['#102030', '#eeeeff'], angle: 135, curve: [0, 0, 1, 1], ...patch });
const withBackground = (background) => ({ ...createEmptyState(), settings: { ...createEmptyState().settings, background } });

test('single colors and multiple gradient colors round trip without changing unrelated appearance', () => {
  const solid = createColorBackground(config({ colors: ['#ABCDEF'] }));
  assert.deepEqual(solid, { kind: 'color', value: '#abcdef' });
  const original = config({ colors: ['#102030', '#eeeeff', '#aabbcc'], angle: 270, curve: [0.22, 0.15, 0.7, 0.95] });
  const background = createColorBackground(original);
  const state = withBackground(background); state.settings.theme = 'dark'; state.settings.shade = 15;
  const restored = migrateNavigationState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(readColorConfig(restored.settings.background), original);
  assert.deepEqual(restored.settings, state.settings);
  readColorConfig(background).colors[0] = '#ffffff';
  assert.equal(background.gradient.colors[0], '#102030', 'editing the returned draft cannot mutate saved data');
});

test('Bezier easing changes real gradient samples while keeping exact endpoints and color order', () => {
  const linear = config();
  assert.equal(gradientCss(linear), 'linear-gradient(135deg, #102030 0%, #eeeeff 100%)');
  const easeIn = GRADIENT_CURVES.find((curve) => curve.value === 'in').points;
  const easeOut = GRADIENT_CURVES.find((curve) => curve.value === 'out').points;
  assert(gradientProgress(0.25, easeIn) < 0.25);
  assert(gradientProgress(0.25, easeOut) > 0.25);
  const curved = gradientCss(config({ colors: ['#000000', '#ffffff', '#ff0000'], curve: easeIn }));
  assert(curved.includes('#000000 0%'));
  assert(curved.includes('#ffffff 50%'));
  assert(curved.endsWith('#ff0000 100%)'));
  assert.notEqual(curved, gradientCss(config({ colors: ['#000000', '#ffffff', '#ff0000'] })));
  for (const curve of [[1, 0, 0, 1], [0, 1, 0, 1], [1, 0, 1, 0], ...GRADIENT_CURVES.map((entry) => entry.points)]) {
    let previous = -1;
    for (let step = 0; step <= 100; step++) {
      const progress = gradientProgress(step / 100, curve);
      assert(progress >= previous && progress >= 0 && progress <= 1);
      previous = progress;
    }
    assert.equal(gradientProgress(0, curve), 0); assert.equal(gradientProgress(1, curve), 1);
  }
});

test('eight-color custom curves stay within the existing CSS storage budget', () => {
  const background = createColorBackground(config({ colors: Array.from({ length: MAX_BACKGROUND_COLORS }, (_, i) => i % 2 ? '#ffffff' : '#123456'), curve: [0.3, 0.15, 0.9, 0.8] }));
  assert(background.value.length < 2000);
  assert(JSON.stringify(background).length < 2000);
  assert.equal((background.value.match(/#[a-f\d]{6}/g) || []).length, 57);
  assert.deepEqual(validateState(withBackground(background)).settings.background, background);
});

test('imports reject unsafe or inconsistent gradient metadata before rendering or syncing', () => {
  const valid = createColorBackground(config());
  const broken = [
    { ...valid, extra: true }, { ...valid, kind: 'color' }, { ...valid, gradient: null },
    { ...valid, gradient: { ...valid.gradient, extra: 'url(https://tracker.test)' } },
    ...[[], ['#ffffff'], Array(9).fill('#ffffff'), ['#fff', '#000000'], ['url(https://tracker.test)', '#ffffff'], new Array(2)].map((colors) => ({ ...valid, gradient: config({ colors }) })),
    ...[-1, 361, 1.5, NaN, '135'].map((angle) => ({ ...valid, gradient: config({ angle }) })),
    ...[[0, 0, 1], [0, -1, 1, 1], [0, 0, 1, 1.1], [0, 0, Infinity, 1], [0, 0, '1', 1], new Array(4)].map((curve) => ({ ...valid, gradient: config({ curve }) })),
    { ...valid, value: 'linear-gradient(90deg, #123456, #ffffff)' },
    { ...valid, value: 'url(https://tracker.test)' },
  ];
  for (const background of broken) assert.throws(() => validateState(withBackground(background)));
});

test('legacy solids, gradients and built-in wallpaper remain readable without rewriting saved choices', () => {
  const cases = [
    { kind: 'color', value: '#abc' },
    { kind: 'gradient', value: 'linear-gradient(135deg, #bfd0ce, #e3d6bc)' },
    { kind: 'gradient', value: 'radial-gradient(circle, red, rgb(0, 0, 255))' },
    { kind: 'builtin', value: 'alpine' },
  ];
  for (const background of cases) {
    assert.deepEqual(migrateNavigationState(withBackground(background)).settings.background, background);
    readColorConfig(background);
    assert.deepEqual(validateState(withBackground(background)).settings.background, background);
  }
  assert.deepEqual(readColorConfig(cases[0]).colors, ['#aabbcc']);
  assert.deepEqual(readColorConfig(cases[1]), config({ colors: ['#bfd0ce', '#e3d6bc'] }));
  assert.equal(fullHex('#ABc'), '#aabbcc');
});

test('HSV picker conversions preserve exact RGB colors including grayscale and primary hues', () => {
  for (const color of ['#000000', '#ffffff', '#888888', '#ff0000', '#00ff00', '#0000ff', '#7f3ba2', '#cedbd9']) {
    assert.equal(hsvToHex(hexToHsv(color)), color);
  }
  assert.equal(hsvToHex({ h: 360, s: 100, v: 100 }), '#ff0000');
  assert.equal(hsvToHex({ h: -60, s: 100, v: 100 }), '#ff00ff');
});

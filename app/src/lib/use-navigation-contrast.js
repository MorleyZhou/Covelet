import { useEffect, useRef } from 'react';
import { analyzeNavigationContrast } from './visual-processing.js';
import { paintNavigationBackdrop, navigationTextStyle } from './navigation-contrast.js';

const TARGETS = '.navigation-shelf .site-name, .icon-drag-ghost .widget-caption, .header-icon, .desktop-page-controls';
const ICON_TARGETS = '.navigation-shelf [data-icon-surface], .icon-drag-ghost [data-icon-surface]';
const WIDGET_TARGETS = '.navigation-shelf [data-widget-surface], .icon-drag-ghost [data-widget-surface]';
const INK = '--navigation-label-ink', SHADOW = '--navigation-label-shadow', STROKE = '--navigation-label-stroke';
const ICON_BACKGROUND = '--navigation-icon-background', ICON_INK = '--navigation-icon-ink';
const WIDGET_PROPERTIES = ['--widget-surface', '--widget-foreground', '--widget-muted', '--ink', '--muted', '--clock-accent',
  '--github-0', '--github-1', '--github-2', '--github-3', '--github-4'];
const same = (left, right) => left?.length === right?.length && left.every((value, index) => value === right[index]);

export function useNavigationContrast({ rootRef, wallpaperRef, enabled, background, sample, shade, blur, theme = 'system', screenKey, entries, editing, showLabels, drag }) {
  const latest = useRef(null), scheduleRef = useRef(null);
  latest.current = { background, sample, shade, blur, theme };

  useEffect(() => {
    const root = rootRef.current, wallpaper = wallpaperRef.current;
    if (!enabled || !root || !wallpaper) return;
    let disposed = false, timer, frame, retryTimer, retryAt = 0, generation = 0, controller, scene, sceneKey, lastGeometry;
    let patchCache = new WeakMap();
    const originals = new Map(), previous = new WeakMap(), iconSchemes = new WeakMap();
    function restore(node, values) {
      for (const [name, value, priority] of values) {
        if (value) node.style.setProperty(name, value, priority);
        else node.style.removeProperty(name);
      }
    }
    function reset() { for (const [node, values] of originals) restore(node, values); originals.clear(); lastGeometry = null; }
    async function update() {
      frame = null;
      if (disposed || Date.now() < retryAt) return;
      const version = generation, options = latest.current, box = wallpaper.getBoundingClientRect();
      const viewportWidth = window.innerWidth, viewportHeight = window.innerHeight;
      const key = [options.background?.kind, options.background?.value, options.sample, options.shade, options.blur, options.theme, viewportWidth, viewportHeight, window.devicePixelRatio, box.left, box.top, box.width, box.height];
      const changedScene = !same(sceneKey, key);
      try {
        if (changedScene) {
          scene = paintNavigationBackdrop({ ...options, box, viewportWidth, viewportHeight });
          sceneKey = key;
          lastGeometry = null; patchCache = new WeakMap();
        }
        if (!scene) { reset(); return; }
        // Caption and surface budgets are separate so large desktops do not
        // consume their text budget on icon-background samples.
        const nodes = [...root.querySelectorAll(TARGETS), ...root.querySelectorAll(ICON_TARGETS), ...root.querySelectorAll(WIDGET_TARGETS)];
        let captionCount = 0, iconCount = 0, widgetCount = 0;
        const targets = nodes.map((node) => {
          const bounds = node.getBoundingClientRect(), clip = node.closest('.desktop-page-viewport')?.getBoundingClientRect();
          const crop = { left: Math.max(0, clip?.left ?? 0, bounds.left - 1), top: Math.max(0, clip?.top ?? 0, bounds.top - 1),
            right: Math.min(viewportWidth, clip?.right ?? viewportWidth, bounds.right + 1), bottom: Math.min(viewportHeight, clip?.bottom ?? viewportHeight, bounds.bottom + 1) };
          if (bounds.width <= 0 || bounds.height <= 0 || crop.right - crop.left < 1 || crop.bottom - crop.top < 1) return null;
          const textStyle = navigationTextStyle(node);
          const tone = node.dataset.iconSurface, type = node.hasAttribute('data-widget-surface') ? 'widget' : tone ? 'icon' : 'caption';
          const rawInk = node.dataset.iconInk || '';
          let ink;
          if (type === 'icon' && rawInk && rawInk.length <= 512) {
            try {
              const value = JSON.parse(rawInk);
              if (Array.isArray(value) && value.length === 64 && value.every((item) => Number.isSafeInteger(item) && item >= 0 && item <= 10000)
                && value.reduce((sum, item) => sum + item, 0) > 0 && value.reduce((sum, item) => sum + item, 0) <= 11000) ink = value;
            } catch { /* An unfinished image retains conservative surface defaults. */ }
          }
          const signature = [bounds.left, bounds.top, bounds.width, bounds.height, crop.left, crop.top, crop.right, crop.bottom]
            .map((value) => Math.round(value * 16) / 16).concat(JSON.stringify(textStyle), type, tone, rawInk);
          return { node, box: bounds, crop, textStyle, type, tone, ink, signature };
        }).filter(Boolean).filter(({ type }) => type === 'widget' ? ++widgetCount <= 48 : type === 'icon' ? ++iconCount <= 48 : ++captionCount <= 64);
        const geometry = targets.flatMap(({ node, signature }) => [node, ...signature]);
        if (!changedScene && same(lastGeometry, geometry)) return;
        if (!targets.length) { lastGeometry = geometry; return; }
        const patches = targets.map((target) => {
          let cached = patchCache.get(target.node);
          if (!cached || !same(cached.signature, target.signature)) {
            cached = { signature: target.signature, patch: scene.sampleRegion(target) }; patchCache.set(target.node, cached);
          }
          return { ...cached.patch, type: target.type, tone: target.tone, ink: target.ink, theme: options.theme, pixels: cached.patch.pixels.slice(0), previous: changedScene ? undefined : previous.get(target.node) };
        });
        controller = new AbortController();
        const captions = await analyzeNavigationContrast(patches, controller.signal);
        if (disposed || version !== generation) return;
        lastGeometry = geometry;
        for (const result of captions) {
          if (!Number.isInteger(result.index)) continue;
          const node = targets[result.index]?.node;
          if (!node?.isConnected) continue;
          if (result.type === 'widget') {
            if (targets[result.index].type !== 'widget' || !/^#[\da-f]{8}$/iu.test(result.background)
              || !['#1d1d1f', '#f5f5f7'].includes(result.foreground) || !/^#[\da-f]{6}$/iu.test(result.muted) || !/^#[\da-f]{6}$/iu.test(result.accent)
              || !Array.isArray(result.palette) || result.palette.length !== 5 || result.palette.some((color) => !/^#[\da-f]{6}$/iu.test(color))) continue;
            if (!originals.has(node)) originals.set(node, WIDGET_PROPERTIES.map((name) => [name, node.style.getPropertyValue(name), node.style.getPropertyPriority(name)]));
            const values = [result.background, result.foreground, result.muted, result.foreground, result.muted, result.accent, ...result.palette];
            WIDGET_PROPERTIES.forEach((name, index) => node.style.setProperty(name, values[index]));
            previous.set(node, result.foreground === '#1d1d1f' ? 'dark' : 'light');
            continue;
          }
          if (result.type === 'icon') {
            if (targets[result.index].type !== 'icon' || !/^#[\da-f]{6}$/iu.test(result.background) || !['#1d1d1f', '#ffffff'].includes(result.foreground)
              || !['light', 'dark'].includes(result.scheme)) continue;
            if (!originals.has(node)) originals.set(node, [ICON_BACKGROUND, ICON_INK].map((name) => [name, node.style.getPropertyValue(name), node.style.getPropertyPriority(name)]));
            node.style.setProperty(ICON_BACKGROUND, result.background); node.style.setProperty(ICON_INK, result.foreground);
            if (iconSchemes.get(node) !== result.scheme) {
              iconSchemes.set(node, result.scheme);
              node.dispatchEvent(new CustomEvent('covelet:icon-scheme', { detail: result.scheme }));
            }
            previous.set(node, result.foreground === '#ffffff' ? 'light' : 'dark');
            continue;
          }
          if (!['dark', 'light'].includes(result.ink) || !Number.isInteger(result.support) || result.support < 0 || result.support > 2) continue;
          if (!originals.has(node)) originals.set(node, [INK, SHADOW, STROKE].map((name) => [name, node.style.getPropertyValue(name), node.style.getPropertyPriority(name)]));
          node.style.setProperty(INK, result.ink === 'dark' ? '#000000' : '#ffffff');
          const opposite = result.ink === 'dark' ? '#ffffff' : '#000000';
          node.style.setProperty(SHADOW, result.support ? `0 1px ${result.support === 2 ? '1.5px' : '1px'} ${opposite}${result.support === 2 ? 'a6' : '80'}` : 'none');
          node.style.setProperty(STROKE, result.support === 2 ? `.7px ${opposite}cc` : '0 transparent');
          previous.set(node, result.ink);
        }
        const activeNodes = new Set(targets.map(({ node }) => node));
        for (const [node, values] of originals) if (!node.isConnected || !activeNodes.has(node)) { if (node.isConnected) restore(node, values); originals.delete(node); }
      } catch (error) {
        if (!disposed && version === generation && error?.name !== 'AbortError') {
          scene = null; sceneKey = null; reset();
          retryAt = Date.now() + 30000;
          clearTimeout(retryTimer); retryTimer = setTimeout(schedule, 30000);
        }
      }
    }
    function schedule() {
      if (disposed) return;
      generation++;
      controller?.abort();
      if (timer || frame) return;
      timer = setTimeout(() => { timer = null; frame = requestAnimationFrame(update); }, 48);
    }
    scheduleRef.current = schedule;
    const resize = new ResizeObserver(schedule);
    resize.observe(root); resize.observe(wallpaper);
    const mutations = new MutationObserver(schedule);
    // Own style writes must not schedule another analysis. Clock/GitHub renders
    // can notify us, but unchanged label geometry skips the WASM work.
    mutations.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-icon-surface', 'data-icon-ink', 'data-widget-surface'] });
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, { passive: true, capture: true });
    const fontChange = () => { patchCache = new WeakMap(); lastGeometry = null; schedule(); };
    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', fontChange);
    viewport?.addEventListener('scroll', schedule, { passive: true });
    document.fonts?.addEventListener('loadingdone', fontChange);
    const transitionFinished = (event) => {
      // Color/opacity fades do not change sampling geometry. Only layout or
      // movement can require new patches when a transition finishes.
      if (['transform', 'translate', 'width', 'height', 'padding', 'gap', 'grid-template-columns'].includes(event.propertyName)) schedule();
    };
    root.addEventListener('transitionend', transitionFinished);
    document.fonts?.ready.then(() => { if (!disposed) { patchCache = new WeakMap(); lastGeometry = null; schedule(); } });
    schedule();
    return () => {
      disposed = true; scheduleRef.current = null;
      clearTimeout(timer); clearTimeout(retryTimer); cancelAnimationFrame(frame); controller?.abort();
      resize.disconnect(); mutations.disconnect();
      window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true);
      viewport?.removeEventListener('resize', fontChange); viewport?.removeEventListener('scroll', schedule);
      document.fonts?.removeEventListener('loadingdone', fontChange);
      root.removeEventListener('transitionend', transitionFinished);
      reset();
    };
  }, [enabled, rootRef, wallpaperRef]);

  useEffect(() => { scheduleRef.current?.(); }, [enabled, background, sample, shade, blur, theme, screenKey, entries, editing, showLabels, drag]);
}

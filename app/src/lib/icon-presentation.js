// Small presentation decisions consume the bounded summaries from the packaged
// Rust core. Pixel scanning, edge classification and histograms live in WASM.
const linear = (channel) => { const value = channel / 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; };
const luminance = (channels) => channels.reduce((total, channel, index) => total + linear(channel) * [.2126, .7152, .0722][index], 0);
const hex = (channels) => `#${channels.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
function surfaceColor(stats, light, anchor = light ? 248 : 24) {
  const mean = stats[4], tint = light ? .10 : .12;
  return [mean >>> 16 & 255, mean >>> 8 & 255, mean & 255].map((channel) => Math.round(anchor * (1 - tint) + channel * tint));
}
function separation(stats, channels, alpha = 1) {
  const surface = luminance(channels);
  // Compare the visible surface with the WASM mean and 10/50/90 percentiles.
  // A single bright highlight must not determine the whole card's polarity.
  return [stats[5], stats[6], stats[7], stats[8]].reduce((score, value, index) => {
    const backdrop = value / 10000, visible = surface * alpha + backdrop * (1 - alpha);
    const contrast = (Math.max(visible, backdrop) + .05) / (Math.min(visible, backdrop) + .05);
    return score + Math.log(contrast) * [.35, .15, .35, .15][index];
  }, 0);
}
function contrastingSurface(stats, previous, alpha = 1) {
  const light = separation(stats, surfaceColor(stats, true), alpha), dark = separation(stats, surfaceColor(stats, false), alpha);
  // `previous` names the foreground ink, not the background color.
  if (['dark', 'light'].includes(previous) && Math.abs(light - dark) < Math.log(1.18)) return previous === 'dark';
  return light >= dark;
}

// Select a separating tile surface, then choose the site's original artwork
// for that surface. Fixed white/black marks constrain the background instead.
export function adaptiveIconBackground(stats, tone, previous, ink) {
  if (ink?.length === 64 && tone !== 'themed') {
    const candidates = [
      ...[248, 232, 216, 202].map((anchor) => ({ light: true, channels: surfaceColor(stats, true, anchor) })),
      ...[24, 42, 60, 76].map((anchor) => ({ light: false, channels: surfaceColor(stats, false, anchor) })),
      ...[114, 134, 154, 174].map((anchor) => ({ light: anchor >= 134, channels: surfaceColor(stats, anchor >= 134, anchor) })),
    ].filter(({ light }) => tone === 'light' ? !light : tone === 'dark' ? light : true).map((candidate) => {
      const backdrop = luminance(candidate.channels);
      let weight = 0, readable = 0, score = 0;
      ink.forEach((count, index) => {
        const value = index / 63, contrast = (Math.max(value, backdrop) + .05) / (Math.min(value, backdrop) + .05);
        weight += count; score += count * Math.log(contrast);
        if (contrast >= 3) readable += count;
      });
      return { ...candidate, readable: weight ? readable / weight : 0, inkScore: weight ? score / weight : 0,
        separation: separation(stats, candidate.channels) };
    });
    const coverage = Math.max(...candidates.map((candidate) => candidate.readable));
    // First preserve the mark's readable pixels. Wallpaper contrast can only
    // rank candidates that passed that constraint; it cannot override it.
    const eligible = candidates.filter((candidate) => candidate.readable >= coverage - .015)
      .sort((a, b) => (b.separation + b.inkScore * .08) - (a.separation + a.inkScore * .08));
    let selected = eligible[0];
    const held = eligible.find((candidate) => candidate.light === (previous === 'dark'));
    if (['light', 'dark'].includes(previous) && held && selected.separation - held.separation < Math.log(1.12)) selected = held;
    return { background: hex(selected.channels), foreground: selected.light ? '#1d1d1f' : '#ffffff', scheme: selected.light ? 'light' : 'dark' };
  }
  const lightSurface = tone === 'light' ? false : ['dark', 'mixed'].includes(tone) ? true : contrastingSurface(stats, previous);
  let channels = surfaceColor(stats, lightSurface);
  if (separation(stats, channels) < Math.log(1.65)) {
    // A single-version mark cannot switch polarity. Lift its dark backing or
    // lower its light backing while retaining ample contrast with the mark.
    for (const anchor of lightSurface ? [232, 216, 202] : [42, 60, 76]) {
      const candidate = surfaceColor(stats, lightSurface, anchor);
      if (separation(stats, candidate) > separation(stats, channels)) channels = candidate;
      if (separation(stats, channels) >= Math.log(1.65)) break;
    }
  }
  return { background: hex(channels), foreground: lightSurface ? '#1d1d1f' : '#ffffff', scheme: lightSurface ? 'light' : 'dark' };
}

// A widget is a readable surface, not an image to recolor. The wallpaper's
// local WASM mean/luminance supplies its tint; foreground and controls follow
// the resulting light/dark surface. Explicit themes retain their polarity.
export function adaptiveWidgetSurface(stats, theme = 'system', previous) {
  const light = theme === 'light' || theme !== 'dark' && contrastingSurface(stats, previous, .95);
  const background = `${hex(surfaceColor(stats, light))}f2`;
  return { background, foreground: light ? '#1d1d1f' : '#f5f5f7', muted: light ? '#47474f' : '#cdccd2',
    accent: light ? '#be5d0c' : '#ffae46',
    palette: light ? ['#e8ebe8', '#a8d69c', '#75b963', '#4b953f', '#2c6533'] : ['#323735', '#244b31', '#397742', '#5ba457', '#8bcb75'] };
}

import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Optional authoring tool; normal builds consume the checked-in PNG files.
// Supply a trusted sharp package path through COVELET_SHARP_PATH, or install
// sharp in your authoring environment. No image service or remote font is used.
const require = createRequire(import.meta.url);
const sharp = require(process.env.COVELET_SHARP_PATH || 'sharp');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const brand = path.join(root, 'docs/brand');
const icons = path.join(root, 'app/public/icons');
const store = path.join(root, 'docs/store/assets');
for (const directory of [brand, icons, store]) mkdirSync(directory, { recursive: true });
const svg = readFileSync(path.join(brand, 'covelet-icon.svg'));
for (const size of [16, 32, 48, 128]) {
  await sharp(svg).resize(size, size).png().toFile(path.join(icons, `icon-${size}.png`));
}
await sharp(svg).resize(512, 512).png().toFile(path.join(brand, 'covelet-icon-512.png'));
await sharp(svg).resize(300, 300).png().toFile(path.join(store, 'edge-logo-300.png'));
const chromeStoreMark = await sharp(svg).resize(96, 96).png().toBuffer();
await sharp({ create: { width: 128, height: 128, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: chromeStoreMark, left: 16, top: 16 }])
  .png()
  .toFile(path.join(store, 'chrome-logo-128.png'));

function promotion(width, height, scale) {
  const mark = svg.toString('utf8').replace(/<svg[^>]*>/, `<svg x="${42 * scale}" y="${96 * scale}" width="${84 * scale}" height="${84 * scale}" viewBox="0 0 256 256">`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#F3F7F6"/>
    <path d="M0 ${height * .87}C${width * .3} ${height * .57} ${width * .55} ${height * 1.13} ${width} ${height * .73}V${height}H0Z" fill="#E2EFEB"/>
    ${mark}
    <text x="${146 * scale}" y="${135 * scale}" font-family="Arial,sans-serif" font-size="${42 * scale}" font-weight="600" letter-spacing="${-1.6 * scale}" fill="#183A4A">Covelet</text>
    <text x="${148 * scale}" y="${164 * scale}" font-family="Arial,sans-serif" font-size="${14 * scale}" fill="#577078">A quiet place to start.</text>
  </svg>`;
}
const small = promotion(440, 280, 1);
writeFileSync(path.join(brand, 'covelet-promo.svg'), small);
await sharp(Buffer.from(small)).flatten({ background: '#F3F7F6' }).png().toFile(path.join(store, 'promo-440x280.png'));
// The large optional promotion keeps the same typography and generous space.
const large = promotion(1400, 560, 2);
await sharp(Buffer.from(large)).flatten({ background: '#F3F7F6' }).png().toFile(path.join(store, 'promo-1400x560.png'));
console.log('Covelet SVG source, four extension PNGs and store brand assets generated.');

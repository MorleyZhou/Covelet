// Response headers and filenames are hints. Real image signatures select the
// decoder, so a PNG served as favicon.ico remains a PNG rather than a bad ICO.
export const ICON_IMAGE_LIMIT = 1024 * 1024;
export const ICON_SVG_LIMIT = 128 * 1024;
export function sniffIconMime(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  const ascii = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (bytes.length >= 8 && bytes[0] === 137 && ascii(1, 7) === 'PNG\r\n\x1a\n') return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return 'image/vnd.microsoft.icon';
  // Only a document rooted in SVG can reach the separate inert SVG parser.
  // HTML containing an embedded SVG, challenge pages and arbitrary XML cannot.
  const prefix = new TextDecoder().decode(bytes.subarray(0, 4096)).replace(/^\uFEFF/, '');
  if (/^\s*(?:<\?xml\b[^?]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|\/?>)/i.test(prefix)) return 'image/svg+xml';
  return null;
}

export async function normalizeIconBlob(blob) {
  if (!(blob instanceof Blob) || !blob.size) throw Object.assign(Error('Image size is invalid'), { code: 'FORMAT' });
  if (blob.size > ICON_IMAGE_LIMIT) throw Object.assign(Error('Image exceeds its byte limit'), { code: 'LIMIT' });
  const bytes = new Uint8Array(await blob.arrayBuffer()), mime = sniffIconMime(bytes);
  if (!mime) throw Object.assign(Error('Image format is unsupported'), { code: 'FORMAT' });
  if (mime === 'image/svg+xml' && blob.size > ICON_SVG_LIMIT) throw Object.assign(Error('SVG exceeds its byte limit'), { code: 'LIMIT' });
  return blob.type === mime ? blob : new Blob([bytes], { type: mime });
}

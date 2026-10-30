import { normalizeIconAddress } from './site-icons.js';
import { validateIconBytes } from './site-info.js';
import { ICON_IMAGE_LIMIT } from './icon-image-format.js';

// One contract for cache reads, restored resources and synchronized icons.
// Uploaded asset records keep their independent (larger) ingestion limits.
export async function validateNavigationIconRecord(item, source = item?.url, { decode = globalThis.createImageBitmap } = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item) || normalizeIconAddress(source) !== source || item.url !== source
    || !Number.isFinite(item.updatedAt) || item.updatedAt < 0 || typeof item.vector !== 'boolean' || typeof item.adaptive !== 'boolean'
    || !Number.isInteger(item.width) || !Number.isInteger(item.height) || item.width < 1 || item.height < 1
    || item.width > 4096 || item.height > 4096 || item.width * item.height > 4_000_000
    || !item.adaptive && item.darkBlob !== undefined) throw Error('Invalid navigation image record');
  for (const blob of [item.blob, ...(item.adaptive ? [item.darkBlob] : [])]) {
    if (!(blob instanceof Blob) || !['image/png', 'image/jpeg', 'image/webp'].includes(blob.type) || !blob.size || blob.size > ICON_IMAGE_LIMIT) throw Error('Invalid navigation image bytes');
    validateIconBytes(new Uint8Array(await blob.arrayBuffer()), blob.type);
    if (typeof decode !== 'function') throw Error('Image decoder unavailable');
    const image = await decode(blob);
    try { if (image.width !== item.width || image.height !== item.height) throw Error('Image dimensions do not match'); }
    finally { image.close?.(); }
  }
  return item;
}

import { tr } from '../i18n/index.js';

// Bounded text only: no HTML, remote image rendering or Blob URLs. The choice
// always applies the full decoded record, never this display projection.
export function conflictRecordPreview(value) {
  let budget = 12000, entries = 0, truncated = false;
  function visit(item, depth = 0) {
    if (budget <= 0 || ++entries > 500 || depth > 12) { truncated = true; return '…'; }
    if (item instanceof Blob) return tr('二进制内容：{0} 字节，类型 {1}', [item.size, item.type || 'application/octet-stream']);
    if (typeof item === 'string') {
      const result = item.slice(0, Math.max(0, budget)); budget -= result.length;
      if (result.length !== item.length) { truncated = true; return result + '…'; }
      return result;
    }
    if (Array.isArray(item)) {
      const result = []; for (const child of item) { if (entries > 500 || budget <= 0) { truncated = true; break; } result.push(visit(child, depth + 1)); } return result;
    }
    if (item && typeof item === 'object') {
      const result = Object.create(null);
      for (const [key, child] of Object.entries(item)) {
        if (entries > 500 || budget <= 0) { truncated = true; break; }
        budget -= key.length; result[key] = visit(child, depth + 1);
      }
      return result;
    }
    budget -= String(item).length; return item;
  }
  const text = JSON.stringify(visit(value), null, 2);
  return truncated ? text + '\n' + tr('内容较长，预览已截短；选择时仍会采用完整记录。') : text;
}

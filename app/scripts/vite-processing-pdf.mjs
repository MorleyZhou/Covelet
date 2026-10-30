// PDF.js is used only to render locally supplied bytes. Keep its networking and
// dynamic worker/codec loaders out of both the page bundle and packaged worker.
// These transforms deliberately fail closed when an upstream loader changes.
export function isolatePdfJs(source, kind) {
  if (!['renderer', 'worker'].includes(kind)) throw Error('Unknown PDF.js build target');
  const replaceOnce = (pattern, replacement, label) => {
    let count = 0; source = source.replace(pattern, () => { count++; return replacement; });
    if (count !== 1) throw Error(`PDF.js ${label} changed; review the local-only adapter before building.`);
  };
  if (kind === 'renderer') {
    replaceOnce(/this\._createCDNWrapper = url => \{[\s\S]*?\n    \};/g, 'this._createCDNWrapper = processingBlockedPdfResource;', 'CDN worker wrapper');
    replaceOnce(/const worker = new Worker\(workerSrc, \{\s*type: "module"\s*\}\);/g, 'const worker = processingBlockedPdfResource();', 'worker URL loader');
    replaceOnce(/const worker = await import\(\s*\/\*webpackIgnore: true\*\/\s*\/\*@vite-ignore\*\/\s*this\.workerSrc\);/g, 'const worker = processingBlockedPdfResource();', 'fallback worker import');
  } else {
    replaceOnce(/const mod = await import\(\s*\/\*webpackIgnore: true\*\/\s*\/\*@vite-ignore\*\/\s*`\$\{WasmImage\.#wasmUrl\}\$\{this\._noWasmFilename\}`\);/g, 'const mod = processingBlockedPdfResource();', 'image codec import');
  }
  // PDF.js also uses "fetch" for local cross-reference table reads. Rename all
  // those identifiers together, preserving internal calls, while the only bare
  // identifier resolves to this denied loader, never to the browser network API.
  const requests = [...source.matchAll(/(?<![\w$.])fetch\s*\(/g)].length;
  if (requests < 1 || !source.includes('XMLHttpRequest')) throw Error('PDF.js resource loader changed; review the adapter.');
  source = source.replace(/\bfetch\b/g, 'processingPdfRead').replace(/\bXMLHttpRequest\b/g, 'ProcessingDeniedPdfRequest');
  if (/\b(?:eval\s*\(|new\s+Function\s*\(|importScripts\s*\(|import\s*\()/.test(source) || /\b(?:XMLHttpRequest|WebSocket|EventSource)\b/.test(source) || /(?<![\w$.])fetch\s*\(/.test(source)) throw Error('Unexpected executable or network loader remains in PDF.js.');
  const guard = `
function processingBlockedPdfResource() { throw new Error('External PDF resources are disabled.'); }
const processingPdfRead = processingBlockedPdfResource;
class ProcessingDeniedPdfRequest { constructor() { processingBlockedPdfResource(); } }
`;
  return { code: guard + source, map: null };
}

export default function processingPdf() {
  return {
    name: 'covelet:local-only-pdf-renderer',
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replaceAll('\\', '/').split('?')[0];
      if (!normalized.includes('/pdfjs-dist/build/')) return null;
      if (normalized.endsWith('/pdf.mjs')) return isolatePdfJs(source, 'renderer');
      if (normalized.endsWith('/pdf.worker.mjs')) return isolatePdfJs(source, 'worker');
      throw Error(`Unreviewed PDF.js build: ${normalized}`);
    },
  };
}

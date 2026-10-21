import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A read-only localhost view of the exact packaged files. This is not an
// extension runtime: chrome.search, permissions and sync need real installation.
const root = await realpath(fileURLToPath(new URL('../dist/extension/', import.meta.url)));
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const port = Number(process.argv[2] || 4175);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Preview port must be an integer from 1024 through 65535.');
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.wasm':'application/wasm', '.png':'image/png', '.txt':'text/plain; charset=utf-8', '.json':'application/json; charset=utf-8' };
const server = createServer(async (request, response) => {
  if (!['GET','HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const target = await realpath(path.resolve(root, `.${pathname === '/' ? '/newtab.html' : pathname}`));
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !(await stat(target)).isFile()) throw Error('Not a packaged file');
    const content = await readFile(target);
    response.writeHead(200, { 'Content-Type':types[path.extname(target)] || 'application/octet-stream', 'Cache-Control':'no-store', 'Content-Security-Policy':manifest.content_security_policy.extension_pages, 'X-Content-Type-Options':'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch { response.writeHead(404).end('Not found'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Packaged Covelet preview: http://127.0.0.1:${port}/newtab.html (no extension APIs)`));

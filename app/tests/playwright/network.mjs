// Exact fixtures for the extension's expected network boundary. No real cloud
// credentials, servers, browser API mocks, or relaxed extension permissions.
export const WEBDAV_BASE = 'https://www.bing.com/covelet-playwright-webdav/';
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5WQAAAAASUVORK5CYII=', 'base64');
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export function createNetworkFixture() {
  const objects = new Map(), requests = [], unexpected = [];
  let authFailure = false, writeFailure = false;
  const davItem = (href, bytes) => `<d:response><d:href>${xml(href)}</d:href><d:propstat><d:prop><d:resourcetype>${bytes === undefined ? '<d:collection/>' : ''}</d:resourcetype>${bytes === undefined ? '' : `<d:getcontentlength>${bytes.length}</d:getcontentlength>`}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  async function install(context, { offline = false } = {}) {
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
      const method = request.method();
      requests.push({ method, url: url.href });
      const fulfill = response => offline ? route.abort('internetdisconnected') : route.fulfill(response);
      if (url.href.startsWith(WEBDAV_BASE)) {
        if (authFailure) return fulfill({ status: 401, body: 'FIXTURE_PRIVATE_RESPONSE', contentType: 'text/plain' });
        if (method === 'PROPFIND') {
          const children = request.headers().depth === '1'
            ? [...objects].filter(([href]) => href.startsWith(url.href) && !href.slice(url.href.length).includes('/')).map(([href, bytes]) => davItem(href, bytes)).join('') : '';
          return fulfill({ status: 207, contentType: 'application/xml', body: `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${davItem(url.href)}${children}</d:multistatus>` });
        }
        if (method === 'MKCOL') return fulfill({ status: 201, body: '' });
        if (method === 'PUT') {
          if (offline) return route.abort('internetdisconnected');
          if (writeFailure) return fulfill({ status: 503, body: 'Synthetic unavailable storage', contentType: 'text/plain' });
          objects.set(url.href, request.postDataBuffer() || Buffer.alloc(0));
          return fulfill({ status: 201, body: '' });
        }
        if (method === 'GET') return fulfill({ status: objects.has(url.href) ? 200 : 404, body: objects.get(url.href) || '', contentType: 'application/octet-stream' });
      }
      if (url.origin === 'https://www.bing.com' && url.pathname === '/HPImageArchive.aspx') {
        return fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ images: [{ url: '/covelet-playwright-wallpaper.png', copyright: 'Covelet test fixture' }] }) });
      }
      if (url.origin === 'https://www.bing.com' && ['/covelet-playwright-wallpaper.png', '/th'].includes(url.pathname)) {
        return fulfill({ status: 200, contentType: 'image/png', body: pixel });
      }
      if (url.origin === 'https://www.bing.com' && url.pathname === '/search') {
        return fulfill({ status: 200, contentType: 'text/plain', body: `Search fixture: ${url.searchParams.get('q')}` });
      }
      unexpected.push({ method, url: url.href });
      await route.abort('blockedbyclient');
    });
  }
  return { objects, requests, unexpected, install, setAuthFailure(value) { authFailure = value; }, setWriteFailure(value) { writeFailure = value; } };
}

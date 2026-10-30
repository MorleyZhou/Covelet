import { tr, getLocale } from "../i18n/index.js";
import { canReadSite, readSiteInfo, siteOrigin } from './site-info.js';
import { readBrowserFavicon, supportsBrowserFavicons } from './browser-favicon.js';
import { fallbackSiteName } from './site-form.js';
import { discoverHighResolutionIcon } from './site-icon-discovery.js';
import { normalizeIconAddress, guessIconFit } from './site-icons.js';
import { navigationIcon, readCachedNavigationIcon, getNavigationIconFailure } from './navigation-icon-cache.js';

async function acquireIcon(source, { force = false, signal } = {}) {
  return (!force && await readCachedNavigationIcon(source)) || await navigationIcon(source, { force: true, signal });
}

// Automatic recognition never requests a new permission. A public homepage is
// read only when its exact origin has already been granted by the user.
export async function recognizeSite(input, {
  api = globalThis.chrome, browserIcon = readBrowserFavicon, remoteInfo = readSiteInfo, highResolutionIcon = discoverHighResolutionIcon,
  iconUrl = '', forceIcon = false, directIcon = acquireIcon, signal,
} = {}) {
  const origin = siteOrigin(input);
  let hasAccess = false, info = null, icon = null, selected = null, iconError = null;
  const explicitSource = iconUrl ? normalizeIconAddress(iconUrl) : '';
  const explicitWork = explicitSource ? (async () => {
    // A user-selected image is independent of the website's public metadata.
    // Never replace it with a different discovered picture or browser favicon.
    try {
      if (!api?.runtime?.id && directIcon === acquireIcon) throw Object.assign(Error(), { code: 'UNAVAILABLE' });
      const resource = await directIcon(explicitSource, { force: forceIcon, signal });
      if (resource) selected = { url: explicitSource, fit: guessIconFit(explicitSource),
        width: resource.width, height: resource.height, vector: resource.vector, adaptive: resource.adaptive };
      else iconError = { ...(getNavigationIconFailure(explicitSource) || { code: 'NETWORK' }), source: explicitSource };
    } catch (error) { iconError = { code: error.code || 'NETWORK', source: explicitSource,
      ...(Number.isInteger(error.httpStatus) ? { httpStatus: error.httpStatus } : {}) }; }
  })() : null;
  // Start the chosen image before independent homepage metadata. The user
  // should not wait for speculative icon discovery before their URL is tried.
  try { hasAccess = await canReadSite(origin, { api }); } catch { /* Use the local browser icon. */ }
  if (hasAccess && !signal?.aborted) {
    try { info = await remoteInfo(origin, { api, metadataOnly: true, signal }); } catch { /* Homepage failure does not block the image. */ }
  }
  if (explicitWork) await explicitWork;
  else {
    icon = info?.icon || null;
    // Probe only this newly added/requested site, never saved navigation.
    try {
      const links = [
        { url: `${origin}/apple-touch-icon.png`, rel: 'apple-touch-icon', sizes: '180x180' },
        { url: `${origin}/apple-touch-icon-precomposed.png`, rel: 'apple-touch-icon', sizes: '180x180' },
        ...(info?.iconUrl ? [{ url: info.iconUrl, rel: 'icon', sizes: '' }] : []),
      ];
      if (api?.runtime?.id || highResolutionIcon !== discoverHighResolutionIcon) selected = await highResolutionIcon(origin, { api, links: info?.iconLinks || links, forceIcon, signal });
    } catch (error) { iconError = { code: error.code || 'NETWORK', source: error.source || `${origin}/favicon.ico`,
      ...(Number.isInteger(error.httpStatus) ? { httpStatus: error.httpStatus } : {}) }; }
    if (!icon && !selected) {
      try { icon = await browserIcon(origin, { api }); } catch { /* Missing icons are ordinary fallback. */ }
    }
  }
  if (signal?.aborted) throw new DOMException(tr('已取消'), 'AbortError');
  const iconAvailable = Boolean(selected || icon);
  if (iconAvailable) iconError = null;
  const highResolution = Boolean(selected && (selected.vector || Math.min(selected.width, selected.height) >= 96));
  const nameFound = typeof info?.nameFound === 'boolean' ? info.nameFound
    : Boolean(info?.title && info.title !== new URL(origin).hostname && info.title !== fallbackSiteName(input));
  return {
    origin, title: info?.title || fallbackSiteName(input), nameFound, icon, iconUrl: selected?.url || (!explicitSource && icon ? info?.iconUrl || '' : ''),
    iconFit: selected?.fit, iconVariants: selected?.variants, highResolution, iconAvailable, iconError, hasAccess,
    message: selected ? '' : icon ? (info?.icon ? info.message : tr("已从浏览器获取图标，可继续修改名称。"))
      : iconError ? tr('图标不可用。') : info?.message || (!api?.runtime?.id ? tr("网页预览使用文字图标。")
        : supportsBrowserFavicons(api) ? tr("浏览器暂无此网站图标，将使用文字图标。")
          : tr("当前扩展的原生图标接口不可用，可重新加载更新后的扩展或使用文字图标。")),
  };
}

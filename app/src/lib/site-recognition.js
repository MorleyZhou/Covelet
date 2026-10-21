import { tr, getLocale } from "../i18n/index.js";
import { canReadSite, readSiteInfo, siteOrigin } from './site-info.js';
import { readBrowserFavicon, supportsBrowserFavicons } from './browser-favicon.js';
import { fallbackSiteName } from './site-form.js';
import { discoverHighResolutionIcon } from './site-icon-discovery.js';

// Automatic recognition never requests a new permission. A public homepage is
// read only when its exact origin has already been granted by the user.
export async function recognizeSite(input, {
  api = globalThis.chrome, browserIcon = readBrowserFavicon, remoteInfo = readSiteInfo, highResolutionIcon = discoverHighResolutionIcon,
} = {}) {
  const origin = siteOrigin(input);
  let hasAccess = false, info = null, icon = null, highResolution = null;
  try { hasAccess = await canReadSite(origin, { api }); } catch { /* Use the local browser icon. */ }
  if (hasAccess) {
    try { info = await remoteInfo(origin, { api, metadataOnly: true }); } catch { /* Homepage failure does not block the browser cache. */ }
  }
  icon = info?.icon || null;
  // Direct image discovery needs no page-reading grant. Probe only the site
  // currently being added; never scan saved navigation or imported bookmarks.
  // Metadata at a custom path remains available through the explicit HD action.
  try {
    const links = [
      { url: `${origin}/apple-touch-icon.png`, rel: 'apple-touch-icon', sizes: '180x180' },
      { url: `${origin}/apple-touch-icon-precomposed.png`, rel: 'apple-touch-icon', sizes: '180x180' },
      ...(info?.iconUrl ? [{ url: info.iconUrl, rel: 'icon', sizes: '' }] : []),
    ];
    // An already-authorized origin can expose custom touch/manifest paths.
    // Without access, stay with direct conventional image probes.
    highResolution = await highResolutionIcon(origin, { api, links: info?.iconLinks || links });
  } catch { /* Keep a real local/browser icon when no HD source is published. */ }
  if (!icon && !highResolution) {
    try { icon = await browserIcon(origin, { api }); } catch { /* Missing icons are ordinary fallback. */ }
  }
  return {
    origin, title: info?.title || fallbackSiteName(input), icon, iconUrl: highResolution?.url || info?.iconUrl || '',
    iconFit: highResolution?.fit, iconVariants: highResolution?.variants, highResolution: Boolean(highResolution), hasAccess,
    message: highResolution ? '' : icon ? (info?.icon ? info.message : tr("已从浏览器获取图标，可继续修改名称。"))
      : info?.message || (!api?.runtime?.id ? tr("网页预览使用文字图标。")
        : supportsBrowserFavicons(api) ? tr("浏览器暂无此网站图标，将使用文字图标。")
          : tr("当前扩展的原生图标接口不可用，可重新加载更新后的扩展或使用文字图标。")),
  };
}

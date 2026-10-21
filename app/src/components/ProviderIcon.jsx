import { tr, getLocale, providerName } from "../i18n/index.js";
import { useState } from "react";
import { Globe } from "@phosphor-icons/react";
import { validateProviderTemplate } from "../lib/model.js";

// Packaged from the providers' own official raster resources:
// https://www.bing.com/favicon.ico
// https://www.google.com/images/branding/googleg/1x/googleg_standard_color_128dp.png
// https://duckduckgo.com/favicon.ico
const BUILT_INS = {
  bing: { origin: "https://www.bing.com", asset: "./assets/search-engines/bing.png" },
  google: { origin: "https://www.google.com", asset: "./assets/search-engines/google.png" },
  duckduckgo: { origin: "https://duckduckgo.com", asset: "./assets/search-engines/duckduckgo.png" },
};

function imageSource(provider, src) {
  const builtin = BUILT_INS[provider?.id];
  if (builtin) {
    try {
      if (new URL(validateProviderTemplate(provider.template)).origin === builtin.origin) return builtin.asset;
    } catch { /* An edited or invalid template must not inherit another brand's logo. */ }
  }
  if (typeof src !== "string" || /[\u0000-\u0020\u007f\\]/u.test(src)) return null;
  if (src.startsWith("blob:")) {
    try { return new URL(src).protocol === "blob:" ? src : null; } catch { return null; }
  }
  // Custom icons may also use an explicitly packaged raster asset. Do not accept
  // remote URLs, data/SVG images, encoded traversal or arbitrary page paths here.
  const path = src.replace(/^\.\//u, "").replace(/^\//u, "");
  if (/^assets\/[a-z\d_./-]+\.(?:png|jpe?g|webp|ico|avif)$/iu.test(path)
    && !path.split("/").some((part) => part === "." || part === "..")) return `./${path}`;
  return null;
}

/** Render only packaged or already-resolved local icons; never fetch a favicon. */
export default function ProviderIcon({ provider, src, className = "", fallback = "globe", onUnavailable }) {
  const source = imageSource(provider, src);
  const [failedSource, setFailedSource] = useState(null);
  if (source && source !== failedSource) {
    return <img
      className={`provider-logo ${className}`.trim()}
      src={source}
      alt=""
      aria-hidden="true"
      draggable={false}
      decoding="async"
      onError={() => {
        setFailedSource(source);
        onUnavailable?.(source);
      }}
    />;
  }
  if (fallback === "name") {
    return <span className={`provider-name ${className}`.trim()}>{provider ? providerName(provider) : tr("搜索引擎")}</span>;
  }
  return <Globe className={`provider-fallback ${className}`.trim()} aria-hidden="true" />;
}

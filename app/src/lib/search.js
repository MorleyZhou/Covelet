import { tr, getLocale } from "../i18n/index.js";
import { buildProviderUrl } from "./model.js";

// Submission priority belongs to the caller. Matching never changes an engine
// setting, navigates, or consumes an explicitly selected local search result.
export function resolveProviderKeyword(text, providers) {
  if (typeof text !== 'string' || !Array.isArray(providers)) return null;
  const match = /^([A-Za-z][A-Za-z0-9_-]{0,19}) +([\s\S]+)$/u.exec(text.trim());
  if (!match) return null;
  const query = match[2].trim();
  if (!query) return null;
  const keyword = match[1].toLowerCase();
  const matches = providers.filter((provider) => typeof provider?.keyword === 'string'
    && /^[A-Za-z][A-Za-z0-9_-]{0,19}$/u.test(provider.keyword) && provider.keyword.toLowerCase() === keyword);
  // A malformed unvalidated dictionary must not silently choose one of two
  // engines. Valid navigation already guarantees unique normalized keywords.
  return matches.length === 1 ? { provider: matches[0], query } : null;
}

export async function submitWebSearch(
  text,
  providerId,
  providers,
  options = {},
) {
  const query = text.trim();
  if (!query) return;
  if (providerId === "browser") {
    const chrome = options.api ?? globalThis.chrome;
    if (!chrome?.search?.query)
      throw new Error(
        tr("浏览器默认搜索需要在 Covelet 扩展中使用。预览中可临时选择其他引擎。"),
      );
    await chrome.search.query({
      text: query,
      disposition: options.newTab ? "NEW_TAB" : "CURRENT_TAB",
    });
    return;
  }
  const provider = providers.find((item) => item.id === providerId);
  if (!provider) throw new Error(tr("搜索引擎不存在，请重新选择。"));
  const url = buildProviderUrl(provider.template, query);
  const navigate =
    options.navigate ??
    ((target, newTab) =>
      newTab
        ? window.open(target, "_blank", "noopener,noreferrer")
        : window.location.assign(target));
  navigate(url, Boolean(options.newTab));
}

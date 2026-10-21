import { tr, getLocale } from "../i18n/index.js";
import { buildProviderUrl } from "./model.js";

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

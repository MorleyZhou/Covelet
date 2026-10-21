import { tr, getLocale, initializeLanguage } from "./i18n/index.js";
import { useLanguage } from './i18n/react.js';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { loadState, saveState, getAssetUrl } from './lib/storage.js';
import { letterIcon, normalizeUrl, DEFAULT_ICON_BACKGROUND } from './lib/model.js';
import { preferredIconAddress, normalizeIconAddress, siteIconAddress, guessIconFit, withDiscoveredIcon } from './lib/site-icons.js';
import { useNavigationIcon } from './lib/use-navigation-icon.js';
import { useAdaptedIcon } from './lib/use-visual-enhancements.js';
import IconArtwork from './components/IconArtwork.jsx';
import { currentPageIconLinks, discoverHighResolutionIcon } from './lib/site-icon-discovery.js';
import { readBrowserFavicon } from './lib/browser-favicon.js';
import { iconTextColor } from './lib/site-form.js';
import IconBackground from './components/IconBackground.jsx';
import { saveReadingItem } from './lib/personal-tools.js';
import './owntab.css';
import './popup.css';

function AddCurrentPage() {
  useLanguage();
  const [form, setForm] = useState({ name: '', url: '', iconUrl: '', iconFit: 'contain' });
  const [initializing, setInitializing] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [preview, setPreview] = useState(''), [failed, setFailed] = useState([]);
  const original = useRef(null), iconEdited = useRef(false);
  const [destination, setDestination] = useState('navigation');
  useEffect(() => {
    let active = true, objectUrl, selectedHd = false;
    const controller = new AbortController();
    (async () => {
      try {
        const [tabs, state] = await Promise.all([chrome.tabs.query({ active: true, currentWindow: true }), loadState()]);
        const tab = tabs[0];
        let url = '';
        try { url = normalizeUrl(tab?.url || ''); } catch { /* Internal browser pages can be entered manually. */ }
        const existing = state.entries.find((entry) => entry.type === 'site' && entry.url === url);
        if (!active) return;
        original.current = existing ? structuredClone(existing) : null;
        let iconUrl = existing ? siteIconAddress(existing) : preferredIconAddress(url);
        try { if (!existing && tab?.favIconUrl) iconUrl = normalizeIconAddress(tab.favIconUrl); } catch { /* Nonportable browser icons use the origin fallback. */ }
        const name = existing?.name || String(tab?.title || (url ? new URL(url).hostname : '')).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
        setForm({ name, url, iconUrl, iconFit: existing?.iconFit || guessIconFit(iconUrl), ...(existing?.iconVariants ? { iconVariants: existing.iconVariants } : {}),
          ...(existing?.iconBackground ? { iconBackground: existing.iconBackground } : {}) });
        if (!url) setError(tr("此页面无法添加，请填写网站地址。"));
        setInitializing(false);
        if (existing?.icon.kind === 'image') {
          try {
            const localUrl = await getAssetUrl(existing.icon.value);
            if (active && !iconEdited.current) { objectUrl = localUrl; setPreview(localUrl); }
            else URL.revokeObjectURL(localUrl);
          } catch { /* A missing legacy image retains its URL/name fallback. */ }
        }
        if (url && !existing) {
          const hd = (async () => {
            const links = await currentPageIconLinks(tab.id);
            const result = await discoverHighResolutionIcon(url, { links, activeTab: true, signal: controller.signal });
            if (!active || iconEdited.current) return;
            selectedHd = true; setPreview('');
            setForm((current) => withDiscoveredIcon(current, result));
          })();
          const browser = readBrowserFavicon(url).then((blob) => {
            if (!active || iconEdited.current || selectedHd || !blob) return;
            objectUrl = URL.createObjectURL(blob); setPreview(objectUrl);
          });
          await Promise.allSettled([hd, browser]);
        }
      } catch (reason) { if (active) { setError(reason.message || tr("无法读取导航，请重新打开扩展。")); setInitializing(false); } }
    })();
    return () => { active = false; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, []);
  const patch = (value) => setForm((current) => {
    const next = { ...current, ...value };
    if (Object.hasOwn(value, 'iconUrl') && !Object.hasOwn(value, 'iconVariants')) delete next.iconVariants;
    return next;
  });
  async function save(event) {
    event.preventDefault();
    if (busy || initializing || event.nativeEvent?.isComposing) return;
    setBusy(true); setError('');
    try {
      const url = normalizeUrl(form.url), name = form.name.trim();
      if (!name) throw Error(tr("请填写网站名称。"));
      if (destination === 'reading') { await saveReadingItem({ title: name, url }); window.close(); return; }
      const iconUrl = normalizeIconAddress(form.iconUrl || preferredIconAddress(url));
      const latest = await loadState();
      const existing = original.current && latest.entries.find((entry) => entry.id === original.current.id);
      if (original.current && (!existing || JSON.stringify(existing) !== JSON.stringify(original.current))) throw Error(tr("此导航已在其他页面修改，请重新打开扩展。"));
      const duplicate = !existing && latest.entries.find((entry) => entry.type === 'site' && entry.url === url);
      if (duplicate) throw Error(tr("这个网址已在导航中。"));
      const keepLocal = existing?.icon.kind === 'image' && !iconEdited.current && new URL(existing.url).origin === new URL(url).origin;
      const entry = { ...(existing || { id: crypto.randomUUID(), type: 'site', groupId: 'group-home', parentId: null, page: 0,
        order: latest.entries.filter((item) => item.parentId === null).length }), name, url, iconUrl,
        icon: keepLocal ? { ...existing.icon } : { kind: 'url', value: iconUrl }, iconFit: form.iconFit };
      if (form.iconBackground) entry.iconBackground = form.iconBackground;
      else delete entry.iconBackground;
      if (form.iconVariants) entry.iconVariants = form.iconVariants;
      else delete entry.iconVariants;
      await saveState({ ...latest, entries: existing ? latest.entries.map((item) => item.id === entry.id ? entry : item) : [...latest.entries, entry] }, latest.revision);
      window.close();
    } catch (reason) { setError(reason.message || tr("添加失败，请重试。")); setBusy(false); }
  }
  const preferLocal = original.current?.icon.kind === 'image' && !iconEdited.current;
  const variants = form.iconVariants;
  const scheme = iconTextColor(form.iconBackground || DEFAULT_ICON_BACKGROUND) === '#fff' ? 'dark' : 'light';
  const variant = !preferLocal && variants?.light && variants?.dark ? variants[scheme] : null;
  const source = variant?.url || form.iconUrl;
  const cached = useNavigationIcon(preferLocal ? '' : source, scheme);
  const image = (preferLocal ? [preview, source] : [cached?.url, source, preview]).find((url) => url && !failed.includes(url)) || '';
  const adapted = useAdaptedIcon(image, image.startsWith('blob:'));
  const iconBackground = form.iconBackground || adapted.background || (variant && scheme === 'dark' ? '#242426' : DEFAULT_ICON_BACKGROUND);
  const fullBleed = adapted.fullBleed || (variant?.fit || form.iconFit) === 'cover' && !cached?.vector;
  return <main className="quick-add theme-system">
    <h1>{destination === 'reading' ? tr("添加到稍后读") : original.current ? tr("编辑网站") : tr("添加网站")}</h1>
    <div className="popup-destination" aria-label={tr("保存位置")}><button type="button" aria-pressed={destination === 'navigation'} disabled={busy} onClick={() => setDestination('navigation')}>{tr("网站导航")}</button><button type="button" aria-pressed={destination === 'reading'} disabled={busy} onClick={() => setDestination('reading')}>{tr("稍后读")}</button></div>
    <form className="form-stack" onSubmit={save}>
      <label>{tr("名称")}<input required maxLength={200} disabled={busy || initializing} value={form.name} onChange={(event) => patch({ name: event.target.value })} /></label>
      <label>{tr("网址")}<input required maxLength={4096} disabled={busy || initializing} value={form.url} placeholder="https://example.com" onChange={(event) => {
        const url = event.target.value;
        let previous, next;
        try { previous = new URL(normalizeUrl(form.url)).origin; } catch { /* Partial input. */ }
        try { next = new URL(normalizeUrl(url)).origin; } catch { /* Partial input. */ }
        if (previous !== next) { iconEdited.current = true; setPreview(''); setFailed([]); patch({ url, iconUrl: preferredIconAddress(url), iconFit: guessIconFit(preferredIconAddress(url)) }); }
        else patch({ url });
      }} /></label>
      {destination === 'navigation' && <><IconBackground value={iconBackground} onChange={(iconBackground) => patch({ iconBackground })}
        onReset={() => setForm((current) => { const next = { ...current }; delete next.iconBackground; return next; })}
        preview={<span className="site-icon" style={{ colorScheme: scheme, backgroundColor: iconBackground, color: iconTextColor(iconBackground) }}>
          {image ? <IconArtwork src={image} scheme={scheme} className={fullBleed ? 'full-bleed-icon' : undefined} onError={(url) => setFailed((sources) => [...sources, url])} /> : <span className="letter-icon">{letterIcon(form.name).value}</span>}
        </span>} />
      <label>{tr("图标地址")}<input type="url" maxLength={4096} disabled={busy || initializing} value={form.iconUrl} placeholder="https://example.com/icon.png" onChange={(event) => {
        iconEdited.current = true; setPreview(''); setFailed([]); patch({ iconUrl: event.target.value, iconFit: guessIconFit(event.target.value) });
      }} /></label></>}
      {error && <p className="form-error" role="alert">{tr(error)}</p>}
      <div className="quick-add-actions"><button className="button" type="button" disabled={busy} onClick={() => window.close()}>{tr("取消")}</button>
        <button className="button primary" type="submit" disabled={busy || initializing}>{busy ? tr("保存中…") : tr("保存")}</button></div>
    </form>
  </main>;
}

initializeLanguage().then(() => createRoot(document.getElementById('root')).render(<AddCurrentPage />));

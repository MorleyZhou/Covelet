import { userErrorMessage } from './lib/user-error.js';
import { tr, getLocale, initializeLanguage } from "./i18n/index.js";
import { useLanguage } from './i18n/react.js';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { loadState, saveStateWithPrivacy, getAssetUrl, subscribeState } from './lib/storage.js';
import { letterIcon, moveEntry, normalizeUrl, DEFAULT_ICON_BACKGROUND } from './lib/model.js';
import { preferredIconAddress, normalizeIconAddress, siteIconAddress, guessIconFit, withDiscoveredIcon, navigationIconDisplaySources } from './lib/site-icons.js';
import { useNavigationIcon } from './lib/use-navigation-icon.js';
import { cacheNavigationIconBlob, prepareSavedNavigationIcon, navigationIcon, getNavigationIconFailure } from './lib/navigation-icon-cache.js';
import { requestNavigationIconAccess } from './lib/navigation-icon-intake.js';
import { iconFailureMessage } from './lib/icon-feedback.js';
import { useSyncedDataRevision } from './lib/use-synced-data.js';
import { useAdaptedIcon } from './lib/use-visual-enhancements.js';
import IconArtwork from './components/IconArtwork.jsx';
import { currentPageIconLinks, discoverHighResolutionIcon } from './lib/site-icon-discovery.js';
import { readBrowserFavicon } from './lib/browser-favicon.js';
import { iconTextColor } from './lib/site-form.js';
import IconBackground from './components/IconBackground.jsx';
import { saveReadingItem } from './lib/personal-tools.js';
import { loadContentPreferences, useContentPreferences, getContentMetadata } from './lib/content-preferences.js';
import ContentMetadataEditor from './components/ContentMetadataEditor.jsx';
import { privateContentKeys, PresentationContext } from './lib/presentation.js';
import { initializeLocalData } from './lib/initialize-local-data.js';
import { PrivacyPasswordForm } from './components/PrivacyPassword.jsx';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './components/ui/tabs.jsx';
import './owntab.css';
import './popup.css';
import { Input } from './components/ui/input.jsx';
import { Button } from './components/ui/button.jsx';
import { Disclosure } from './components/ui/disclosure.jsx';
import NavigationDestination from './components/NavigationDestination.jsx';
import { appendSiteAt, desktopDestinationValue, destinationChanged, inheritedSitePrivacy, navigationDestination, siteAtDestination, siteDestinationValue } from './lib/navigation-destinations.js';

const hiddenEntry = (entry, preferences) => Boolean(preferences.presentation && entry
  && privateContentKeys({ entries: [entry] }, preferences).has(`site:${entry.id}`));

function AddCurrentPage() {
  useLanguage();
  const syncRevision = useSyncedDataRevision();
  const contentPreferences = useContentPreferences();
  const [form, setForm] = useState({ name: '', url: '', iconUrl: '', iconFit: 'contain' });
  const currentForm = useRef(form); currentForm.current = form;
  const [displayForm, setDisplayForm] = useState({ name: '', url: '', iconUrl: '', iconFit: 'contain' });
  const [initializing, setInitializing] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [preview, setPreview] = useState(''), [failed, setFailed] = useState([]);
  const [iconInfo, setIconInfo] = useState({ phase: 'idle' }), iconOperation = useRef(null);
  const iconPending = ['permission', 'loading'].includes(iconInfo.phase), locked = busy || iconPending;
  const [localAsset, setLocalAsset] = useState({ id: '', url: '', phase: 'missing' });
  const assetLease = useRef(null), assetTimers = useRef(new Map());
  const original = useRef(null), iconEdited = useRef(false), previewBlob = useRef(null);
  const [destination, setDestination] = useState('navigation');
  const [navigation, setNavigation] = useState(null), [targetValue, setTargetValue] = useState('');
  const navigationSelectionRevision = useRef(null);
  const [metadata, setMetadata] = useState({ description: '', tagIds: [] });
  const metadataRevision = useRef(0);
  const metadataBase = useRef({ description: '', tagIds: [] });
  const [metadataBusy, setMetadataBusy] = useState(false);
  const currentOriginal = navigation?.entries.find((entry) => entry.id === original.current?.id) || original.current;
  const privateBlocked = hiddenEntry(currentOriginal, contentPreferences.data);
  useEffect(() => subscribeState((next) => setNavigation((current) => current && current.revision > next.revision ? current : next)), []);
  useEffect(() => {
    if (!contentPreferences.ready) return;
    let active = true, objectUrl, selectedHd = false;
    const controller = new AbortController();
    (async () => {
      try {
        // activeTab exposes only the invoked page; no tabs permission or window capture.
        const [tabs, state] = await Promise.all([chrome.tabs.query({ active: true, currentWindow: true }), loadState()]);
        const tab = tabs[0];
        let url = '';
        try { url = normalizeUrl(tab?.url || ''); } catch { /* Internal browser pages can be entered manually. */ }
        const existing = state.entries.find((entry) => entry.type === 'site' && entry.url === url);
        if (!active) return;
        original.current = existing ? structuredClone(existing) : null;
        metadataBase.current = existing ? getContentMetadata(contentPreferences.data, `site:${existing.id}`) : { description: '', tagIds: [] };
        setMetadata(metadataBase.current);
        metadataRevision.current = contentPreferences.data.revision;
        setNavigation((current) => current && current.revision > state.revision ? current : state);
        navigationSelectionRevision.current = state.revision;
        setTargetValue(existing ? siteDestinationValue(state, existing) : desktopDestinationValue(state));
        let iconUrl = existing ? siteIconAddress(existing) : preferredIconAddress(url);
        try { if (!existing && tab?.favIconUrl) iconUrl = normalizeIconAddress(tab.favIconUrl); } catch { /* Nonportable browser icons use the origin fallback. */ }
        const name = existing?.name || String(tab?.title || (url ? new URL(url).hostname : '')).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
        const draft = { name, url, iconUrl, iconFit: existing?.iconFit || guessIconFit(iconUrl), ...(existing?.iconVariants ? { iconVariants: existing.iconVariants } : {}),
          ...(existing?.iconBackground ? { iconBackground: existing.iconBackground } : {}) };
        setForm(draft); setDisplayForm({ ...draft, ...(existing?.icon ? { icon: existing.icon } : {}) });
        if (!url) setError(tr("此页面无法添加，请填写网站地址。"));
        setInitializing(false);
        if (url && !existing) {
          const hd = (async () => {
            const links = await currentPageIconLinks(tab.id);
            const result = await discoverHighResolutionIcon(url, { links, activeTab: true, signal: controller.signal });
            if (!active || iconEdited.current) return;
            selectedHd = true; previewBlob.current = null; setPreview('');
            setForm((current) => withDiscoveredIcon(current, result));
            setDisplayForm((current) => withDiscoveredIcon(current, result));
          })();
          const browser = readBrowserFavicon(url).then((blob) => {
            if (!active || iconEdited.current || selectedHd || !blob) return;
            previewBlob.current = blob; objectUrl = URL.createObjectURL(blob); setPreview(objectUrl);
          });
          await Promise.allSettled([hd, browser]);
        }
      } catch (reason) { if (active) { setError(userErrorMessage(reason, tr("无法读取导航，请重新打开扩展。"))); setInitializing(false); } }
    })();
    return () => { active = false; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [contentPreferences.ready]);
  const localAssetId = displayForm.icon?.kind === 'image' ? displayForm.icon.value : '';
  // Keep the active asset's URL owned until its decoded replacement is ready.
  // A draft edit must not borrow a URL an unrelated effect already revoked.
  useEffect(() => {
    let active = true;
    const release = (lease) => {
      if (!lease) return;
      const timer = setTimeout(() => { assetTimers.current.delete(timer); URL.revokeObjectURL(lease.url); }, 400);
      assetTimers.current.set(timer, lease.url);
    };
    if (!localAssetId || privateBlocked || !contentPreferences.ready) {
      const previous = assetLease.current; assetLease.current = null;
      setLocalAsset({ id: localAssetId, url: '', phase: 'missing' }); release(previous);
      return () => { active = false; };
    }
    setLocalAsset((current) => ({ id: localAssetId, url: current.id === localAssetId ? current.url : '', phase: 'loading' }));
    getAssetUrl(localAssetId).then((url) => {
      if (!active) { URL.revokeObjectURL(url); return; }
      const previous = assetLease.current; assetLease.current = { id: localAssetId, url };
      setLocalAsset({ id: localAssetId, url, phase: 'ready' }); setFailed([]); release(previous);
    }).catch(() => {
      if (!active) return;
      const previous = assetLease.current; assetLease.current = null;
      setLocalAsset({ id: localAssetId, url: '', phase: 'missing' }); release(previous);
    });
    return () => { active = false; };
  }, [localAssetId, syncRevision, privateBlocked, contentPreferences.ready]);
  useEffect(() => () => {
    iconOperation.current?.abort();
    for (const [timer, url] of assetTimers.current) { clearTimeout(timer); URL.revokeObjectURL(url); }
    if (assetLease.current) URL.revokeObjectURL(assetLease.current.url);
  }, []);
  const patch = (value) => setForm((current) => {
    const next = { ...current, ...value };
    if (Object.hasOwn(value, 'iconUrl') && !Object.hasOwn(value, 'iconVariants')) delete next.iconVariants;
    return next;
  });
  function getIcon() {
    if (locked || initializing || !contentPreferences.ready || privateBlocked) return;
    let source;
    try { source = normalizeIconAddress(form.iconUrl || preferredIconAddress(normalizeUrl(form.url))); }
    catch (reason) { setIconInfo({ phase: 'error', message: userErrorMessage(reason) }); return; }
    const authorization = requestNavigationIconAccess([{ source }]);
    iconOperation.current?.abort();
    const controller = new AbortController(); iconOperation.current = controller;
    iconEdited.current = true; setIconInfo({ phase: 'permission' }); setError('');
    Promise.resolve(authorization).then(async (granted) => {
      if (controller.signal.aborted) return;
      setIconInfo({ phase: 'loading' });
      const item = await navigationIcon(source, { force: true, signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!item) throw Error(iconFailureMessage(getNavigationIconFailure(source)));
      const next = withDiscoveredIcon({ ...currentForm.current, icon: { kind: 'url', value: source } }, { url: source, fit: guessIconFit(source) });
      setForm(next); setDisplayForm(next); previewBlob.current = null; setPreview(''); setFailed([]);
      setIconInfo({ phase: 'ready' });
    }).catch((reason) => {
      if (!controller.signal.aborted) setIconInfo({ phase: 'error', message: userErrorMessage(reason) });
    });
  }
  async function save(event) {
    event.preventDefault();
    if (locked || metadataBusy || initializing || !contentPreferences.ready || privateBlocked || event.nativeEvent?.isComposing) return;
    setBusy(true); setError('');
    try {
      const url = normalizeUrl(form.url), name = form.name.trim();
      if (!name) throw Error(tr("请填写网站名称。"));
      if (destination === 'navigation' && iconEdited.current) {
        await requestNavigationIconAccess([{ source: normalizeIconAddress(form.iconUrl || preferredIconAddress(url)) }]);
      }
      const [latest, preferences] = await Promise.all([loadState(), loadContentPreferences()]);
      const existing = original.current && latest.entries.find((entry) => entry.id === original.current.id);
      if (hiddenEntry(existing, preferences) || hiddenEntry(latest.entries.find((entry) => entry.type === 'site' && entry.url === url), preferences)) {
        throw Error(tr('请先输入密码解除隐藏。'));
      }
      if (destination === 'reading') { await saveReadingItem({ title: name, url }, { metadata, expectedMetadata: { description: '', tagIds: [] }, expectedPreferencesRevision: metadataRevision.current }); window.close(); return; }
      const iconUrl = normalizeIconAddress(form.iconUrl || preferredIconAddress(url));
      if (original.current && (!existing || JSON.stringify(existing) !== JSON.stringify(original.current))) throw Error(tr("此导航已在其他页面修改，请重新打开扩展。"));
      // A legacy desktop without an identity can be renumbered by another tab.
      if (/^page:\d+$/.test(targetValue) && navigationSelectionRevision.current !== latest.revision) throw destinationChanged();
      const target = navigationDestination(latest, targetValue, preferences);
      const duplicate = latest.entries.find((entry) => entry.id !== existing?.id && siteAtDestination(entry, target) && entry.url === url);
      if (duplicate) throw Error(tr("这个网址已在导航中。"));
      const keepLocal = existing?.icon.kind === 'image' && !iconEdited.current && new URL(existing.url).origin === new URL(url).origin;
      const entry = { ...(existing || { id: crypto.randomUUID(), type: 'site', groupId: 'group-home' }), name, url, iconUrl,
        icon: keepLocal ? { ...existing.icon } : { kind: 'url', value: iconUrl }, iconFit: form.iconFit };
      if (form.iconBackground) entry.iconBackground = form.iconBackground;
      else delete entry.iconBackground;
      if (form.iconVariants) entry.iconVariants = form.iconVariants;
      else delete entry.iconVariants;
      if (!keepLocal && previewBlob.current && !iconEdited.current) {
        await cacheNavigationIconBlob(iconUrl, previewBlob.current);
      }
      const iconReady = await prepareSavedNavigationIcon(entry, existing, { iconEdited: iconEdited.current });
      if (!iconReady && (existing || iconEdited.current)) throw Error(iconFailureMessage(getNavigationIconFailure(iconUrl)));
      let next = appendSiteAt(latest, entry, target);
      if (existing) {
        next = { ...latest, entries: latest.entries.map((item) => item.id === entry.id ? entry : item) };
        if (!siteAtDestination(existing, target)) next = moveEntry(next, entry.id, target);
      }
      await saveStateWithPrivacy(next, latest.revision, (current, commit) => {
        if (hiddenEntry(existing, current)) throw Error(tr('请先输入密码解除隐藏。'));
        const currentTarget = navigationDestination(latest, targetValue, current);
        return commit(inheritedSitePrivacy(existing, currentTarget, current), {
          metadata: [{ key: `site:${entry.id}`, ...metadata, expectedMetadata: metadataBase.current }], expectedRevision: metadataRevision.current,
        });
      });
      window.close();
    } catch (reason) {
      if (reason.code === 'TARGET_CHANGED' || reason.code === 'REVISION_CONFLICT') {
        setTargetValue('');
        const latest = await loadState().catch(() => null);
        if (latest) setNavigation(latest);
      }
      setError(userErrorMessage(reason, tr("添加失败，请重试。"))); setBusy(false);
    }
  }
  const preferLocal = displayForm.icon?.kind === 'image';
  const variants = displayForm.iconVariants;
  const scheme = iconTextColor(form.iconBackground || DEFAULT_ICON_BACKGROUND) === '#fff' ? 'dark' : 'light';
  const variant = !preferLocal && variants?.light && variants?.dark ? variants[scheme] : null;
  const displaySources = navigationIconDisplaySources({ ...displayForm, type: 'site' }, scheme, true);
  const asset = localAsset.id === localAssetId ? localAsset : { url: '', phase: localAssetId ? 'loading' : 'missing' };
  const source = preferLocal && asset.phase !== 'missing' ? '' : displaySources.explicitFallback || displaySources.primary;
  const cached = useNavigationIcon(privateBlocked || !contentPreferences.ready ? '' : source, scheme, undefined, 0, displaySources.fallback);
  const image = privateBlocked || !contentPreferences.ready ? '' : [asset.url, cached?.url, preview].find((url) => url && !failed.includes(url)) || '';
  const adapted = useAdaptedIcon(image, image.startsWith('blob:'));
  const usingVariant = variant && cached.source === variant.url;
  const iconBackground = form.iconBackground || adapted.background || (usingVariant && scheme === 'dark' ? '#242426' : DEFAULT_ICON_BACKGROUND);
  const fullBleed = adapted.fullBleed || (usingVariant ? variant.fit : displayForm.iconFit) === 'cover' && !cached?.vector;
  const visualPending = image.startsWith('blob:') && adapted.phase === 'processing';
  const imagePending = initializing || visualPending || preferLocal && asset.phase === 'loading' || Boolean(source) && cached.phase === 'loading';
  const renderedImage = fullBleed ? image : adapted.url || image;
  if (!contentPreferences.ready) return <main className="quick-add theme-system"><h1>Covelet</h1>{contentPreferences.error && <p className="form-error" role="alert">{contentPreferences.error}</p>}</main>;
  return <PresentationContext.Provider value={{ active: contentPreferences.data.presentation,
    hiddenKeys: privateContentKeys(navigation, contentPreferences.data), requestUnlock: () => {} }}>
    <Tabs value={destination} onValueChange={setDestination} asChild><main className="quick-add theme-system">
    <h1>{privateBlocked ? tr('已隐藏') : destination === 'reading' ? tr("添加到稍后读") : original.current ? tr("编辑网站") : tr("添加网站")}</h1>
    <TabsList className="popup-destination" aria-label={tr("保存位置")}><TabsTrigger value="navigation" disabled={locked}>{tr("网站导航")}</TabsTrigger><TabsTrigger value="reading" disabled={locked}>{tr("稍后读")}</TabsTrigger></TabsList>
    <TabsContent value={destination} className="popup-destination-panel">{privateBlocked
      ? <PrivacyPasswordForm purpose="unlock" onBusyChange={setBusy} onCancel={() => window.close()} /> : <form className="form-stack" onSubmit={save}>
      <label>{tr("名称")}<Input required maxLength={200} disabled={locked || initializing} value={form.name} onChange={(event) => patch({ name: event.target.value })} /></label>
      <label>{tr("网址")}<Input required maxLength={4096} disabled={locked || initializing} value={form.url} placeholder="https://example.com" onChange={(event) => {
        const url = event.target.value;
        let previous, next;
        try { previous = new URL(normalizeUrl(form.url)).origin; } catch { /* Partial input. */ }
        try { next = new URL(normalizeUrl(url)).origin; } catch { /* Partial input. */ }
        if (previous !== next) { iconEdited.current = true; setIconInfo({ phase: 'idle' }); setError(''); patch({ url, iconUrl: preferredIconAddress(url), iconFit: guessIconFit(preferredIconAddress(url)) }); }
        else patch({ url });
      }} /></label>
      <ContentMetadataEditor preferences={contentPreferences.data} contentKey={original.current ? `site:${original.current.id}` : undefined}
        value={metadata} onChange={setMetadata} disabled={locked || initializing} onBusyChange={setMetadataBusy}
        onPreferencesChange={(next) => { metadataRevision.current = next.revision; }} />
      {destination === 'navigation' && <>{navigation && <NavigationDestination state={navigation} preferences={contentPreferences.data} value={targetValue}
        onChange={(value) => { setTargetValue(value); navigationSelectionRevision.current = navigation.revision; }} disabled={locked || initializing} />}
      <IconBackground value={iconBackground} onChange={(iconBackground) => patch({ iconBackground })}
        onReset={() => setForm((current) => { const next = { ...current }; delete next.iconBackground; return next; })}
        preview={<span className="site-icon" style={{ colorScheme: scheme, backgroundColor: iconBackground, color: iconTextColor(iconBackground) }}>
          <IconArtwork src={visualPending ? '' : renderedImage} identity={image} pending={imagePending} scheme={scheme} className={fullBleed ? 'full-bleed-icon' : undefined} onError={(url) => setFailed((sources) => [...sources, url])} />
          {!image && !imagePending && <span className="letter-icon">{letterIcon(form.name).value}</span>}
        </span>} />
      <label>{tr("图标地址")}<Input type="url" maxLength={4096} disabled={locked || initializing} value={form.iconUrl} placeholder="https://example.com/icon.png" onChange={(event) => {
        iconEdited.current = true; setIconInfo({ phase: 'idle' }); setError(''); patch({ iconUrl: event.target.value, iconFit: guessIconFit(event.target.value) });
      }} /></label>
      <Button variant="secondary" type="button" disabled={locked || initializing || !(form.iconUrl || form.url)} aria-busy={iconPending} onClick={getIcon}>
        {iconPending ? tr('正在获取图标…') : tr('获取图标')}
      </Button>
      {iconInfo.phase === 'error' && <p className="form-error" role="alert">{iconInfo.message}</p>}
      </>}
      {error && <p className="form-error" role="alert">{tr(error)}</p>}
      <div className="quick-add-actions"><Button variant="secondary" className="button" type="button" disabled={locked} onClick={() => window.close()}>{tr("取消")}</Button>
        <Button variant="default" className="button primary" type="submit" disabled={locked || metadataBusy || initializing || destination === 'navigation' && !targetValue}>{busy ? tr("保存中…") : tr("保存")}</Button></div>
    </form>}</TabsContent>
  </main></Tabs></PresentationContext.Provider>;
}

initializeLanguage().then(initializeLocalData).then(() => {
  document.body.classList.add('theme-system');
  createRoot(document.getElementById('root')).render(<AddCurrentPage />);
}).catch((error) => {
  createRoot(document.getElementById('root')).render(<main className="quick-add"><p role="alert">{userErrorMessage(error, tr('无法打开本机数据，原数据已保留。'))}</p><Disclosure title={tr('技术详情')}><p>{error.message}</p></Disclosure></main>);
});

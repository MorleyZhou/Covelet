import { tr, getLocale, builtinName, providerName, formatNumber } from "./i18n/index.js";
import { useLanguage } from './i18n/react.js';
import LanguageSettings from './components/LanguageSettings.jsx';
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  MagnifyingGlass,
  Globe,
  CaretDown,
  Plus,
  GearSix,
  X,
  ArrowLeft,
  Folder,
  PencilSimple,
  Trash,
  ArrowSquareOut,
  ArrowUUpLeft,
  ArrowUp,
  SquaresFour,
  UploadSimple,
  DownloadSimple,
  Check,
  PuzzlePiece,
  CornersOut,
  CornersIn,
} from "@phosphor-icons/react";
import {
  createEmptyState,
  createInitialState,
  normalizeUrl,
  validateProviderTemplate,
  searchEntries,
  moveEntry,
  deleteEntry,
  migrateNavigationState,
  parseBookmarks,
  applyBookmarkImport,
  letterIcon,
  DEFAULT_ICON_BACKGROUND,
  configureWidget,
} from "./lib/model.js";
import {
  loadState,
  saveState,
  subscribeState,
  putImage,
  getAssetUrl,
  exportBackup,
  inspectBackup,
  restoreBackup,
  restoreSnapshot,
  getSyncStatus,
  subscribeSyncStatus,
  setSyncEnabled,
  syncNow,
  getSyncConflicts,
  restoreSyncConflict,
} from "./lib/storage.js";
import { submitWebSearch } from "./lib/search.js";
import { createWallpaperProvider } from "./lib/wallpaper.js";
import { useIconDrag } from "./lib/use-icon-drag.js";
import { supportsSiteInfo, requestSiteAccess } from "./lib/site-info.js";
import { recognizeSite } from "./lib/site-recognition.js";
import Select from "./components/Select.jsx";
import ContextMenu from "./components/ContextMenu.jsx";
import IconBackground from "./components/IconBackground.jsx";
import BackgroundPicker from "./components/BackgroundPicker.jsx";
import FolderName from "./components/FolderName.jsx";
import ProviderIcon from "./components/ProviderIcon.jsx";
import { readCachedProviderIcon, fetchProviderIconForSave } from "./lib/provider-icons.js";
import { fallbackSiteName, applyRecognizedSite, iconTextColor } from "./lib/site-form.js";
import { useWallpaperAppearance, useAdaptedIcon, useVisualRuntimeStatus } from "./lib/use-visual-enhancements.js";
import { createAdaptiveAppearance } from "./lib/adaptive-appearance.js";
import { useNavigationContrast } from "./lib/use-navigation-contrast.js";
import { VISUAL_SHADE_BACKGROUND } from "./lib/navigation-contrast.js";
import { colorBackgroundCss } from "./lib/background-colors.js";
import { startCloudSync } from "./lib/cloud-sync.js";
import ExtensionCenter from "./components/ExtensionCenter.jsx";
import GitHubWidget from "./components/GitHubWidget.jsx";
import DesktopPages from "./components/DesktopPages.jsx";
import { layoutDesktop } from "./lib/desktop-layout.js";
import { applyDesktopDrop, deleteDesktopEntries } from "./lib/desktop-edit.js";
import { useLayoutEdit } from "./lib/use-layout-edit.js";
import { DesktopEditBar, DesktopScreenManager } from "./components/DesktopEditControls.jsx";
import { readBrowserFavicon } from "./lib/browser-favicon.js";
import { createPreferenceSaver } from "./lib/preference-saving.js";
import { preferredIconAddress, normalizeIconAddress, siteIconAddress, guessIconFit, withDiscoveredIcon } from "./lib/site-icons.js";
import { useIconScheme } from './lib/use-icon-scheme.js';
import { useNavigationIcon } from './lib/use-navigation-icon.js';
import IconArtwork from './components/IconArtwork.jsx';
import { discoverHighResolutionIcon } from "./lib/site-icon-discovery.js";
import ClockWidget from "./components/ClockWidget.jsx";
import PersonalWidget from "./components/PersonalTools.jsx";
import { focusDesktopNeighbor } from "./lib/desktop-focus.js";
import { CLOCK_WIDGET_ID, GITHUB_WIDGET_ID } from "./lib/widget-model.js";
import { removeClockState } from "./lib/clock-runtime.js";
import "./owntab.css";
import { DialogSurface } from './components/DialogSurface.jsx';
import { MessageDialog } from './components/PromptDialog.jsx';

const uid = () => crypto.randomUUID();
const DialogError = createContext("");
const AdaptIcons = createContext(false);
const demo =
  import.meta.env.DEV && new URLSearchParams(location.search).has("demo");
const dailyWallpaper = createWallpaperProvider();
const defaultFaviconWork = new Map();

function useSiteFavicon(entry, enabled = true) {
  const [cached, setCached] = useState(null);
  let origin = '';
  try { if (enabled && entry.type === 'site') origin = new URL(normalizeUrl(entry.url)).origin; } catch { /* An unfinished form has no icon yet. */ }
  useEffect(() => {
    if (!origin) return;
    let active = true, url;
    if (!defaultFaviconWork.has(origin)) {
      defaultFaviconWork.set(origin, readBrowserFavicon(origin));
      if (defaultFaviconWork.size > 128) defaultFaviconWork.delete(defaultFaviconWork.keys().next().value);
    }
    defaultFaviconWork.get(origin).then((blob) => {
      if (!active || !blob) return;
      url = URL.createObjectURL(blob); setCached({ source: origin, url });
    }).catch(() => {});
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [origin]);
  return origin && cached?.source === origin ? cached.url : '';
}

function SearchProviderIcon({ provider, epoch, fallback = "globe" }) {
  const [cached, setCached] = useState(null);
  const template = provider?.template;
  useEffect(() => {
    let active = true, url;
    setCached(null);
    if (template) readCachedProviderIcon(template).then((blob) => {
      if (!active || !blob) return;
      url = URL.createObjectURL(blob);
      setCached({ template, url });
    }).catch(() => {});
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [template, epoch]);
  return <ProviderIcon key={template} provider={provider} src={cached?.template === template ? cached.url : undefined} fallback={fallback} />;
}

function WidgetTile({ item, editing, className, children, ...props }) {
  return <div {...props} className={`${className} widget-tile widget-size-${item.config.size}`}>
    <div className="widget-live-content" inert={editing || undefined}>{children}</div><span className="site-name widget-caption">{builtinName(item.extensionId, item.name)}</span>
  </div>;
}


function useAsset(id) {
  const [asset, setAsset] = useState({ id: null, url: "" });
  useEffect(() => {
    let cancelled = false,
      objectUrl;
    setAsset({ id, url: "" });
    if (id)
      getAssetUrl(id)
        .then((value) => {
          objectUrl = value;
          if (!cancelled) setAsset({ id, url: value });
          else URL.revokeObjectURL(value);
        })
        .catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id]);
  return asset.id === id ? asset.url : "";
}

function useDailyWallpaper(enabled) {
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (!enabled) { setResult(null); return; }
    let active = true, loading = false, currentResult;
    async function refresh() {
      if (loading) return;
      loading = true;
      try {
        const next = await dailyWallpaper.load();
        if (!active) {
          dailyWallpaper.dispose(next);
          return;
        }
        if (currentResult) dailyWallpaper.dispose(currentResult);
        currentResult = next;
        setResult(next);
      } catch {
        if (active) setResult({ source: "builtin", message: tr("每日壁纸暂不可用，正在显示内置背景。") });
      } finally { loading = false; }
    }
    refresh();
    const timer = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 15 * 60 * 1000);
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
      if (currentResult) dailyWallpaper.dispose(currentResult);
    };
  }, [enabled]);
  return result;
}
function SiteIcon({ entry, small = false, children = [] }) {
  const [failedImage, setFailedImage] = useState({ source: "", urls: [] });
  const [surfaceRef, automaticScheme] = useIconScheme();
  const visualEnabled = useContext(AdaptIcons);
  const localImage = useAsset(
    entry.icon?.kind === "image" ? entry.icon.value : null,
  );
  const variants = entry.icon?.kind === 'image' ? null : entry.iconVariants;
  const paired = Boolean(variants?.light && variants?.dark);
  const scheme = entry.iconBackground ? iconTextColor(entry.iconBackground) === '#fff' ? 'dark' : 'light' : automaticScheme;
  const variant = visualEnabled && paired ? variants[scheme] : null;
  const address = entry.type === 'site' && entry.icon?.kind !== 'image' ? variant?.url || siteIconAddress(entry) : '';
  const cachedImage = useNavigationIcon(address, visualEnabled ? scheme : 'light', surfaceRef);
  const source = JSON.stringify([entry.id, entry.url, entry.icon, entry.iconUrl, entry.iconVariants]);
  const failedUrls = failedImage.source === source ? failedImage.urls : [];
  const nativeImage = useSiteFavicon(entry);
  const image = [localImage, cachedImage?.url, address, siteIconAddress(entry), nativeImage].find((url) => url && !failedUrls.includes(url)) || '';
  const themedArtwork = Boolean((variant || cachedImage?.adaptive) && [cachedImage?.url, address].includes(image));
  const adapted = useAdaptedIcon(image, visualEnabled && entry.type === "site" && image.startsWith('blob:'));
  const fullBleed = adapted.fullBleed || (variant?.fit || entry.iconFit) === 'cover' && !cachedImage?.vector;
  const renderedImage = fullBleed ? image : adapted.url && !failedUrls.includes(adapted.url) ? adapted.url : image;
  const background = entry.iconBackground || adapted.background || (themedArtwork && scheme === 'dark' ? '#242426' : DEFAULT_ICON_BACKGROUND);
  const hasImage = renderedImage && !failedUrls.includes(renderedImage);
  // Adapt the surrounding surface only. Never recolor an actual site image.
  // Full app artwork keeps its own edge color so it does not acquire a second
  // circular/rounded frame when the wallpaper changes.
  const autoSurface = visualEnabled && !small && !entry.iconBackground && (!(hasImage && fullBleed) || themedArtwork);
  const surfaceTone = hasImage ? themedArtwork ? 'themed' : adapted.surfaceTone || adapted.monochrome || 'mixed' : 'text';
  const surfaceProps = autoSurface ? { 'data-icon-surface': surfaceTone,
    ...(!themedArtwork && adapted.ink ? { 'data-icon-ink': JSON.stringify(adapted.ink) } : {}) } : {};
  const style = { colorScheme: scheme, backgroundColor: autoSurface ? `var(--navigation-icon-background, ${background})` : background,
    color: autoSurface ? `var(--navigation-icon-ink, ${iconTextColor(background)})` : iconTextColor(background) };
  if (entry.type === "folder")
    return (
      <span ref={surfaceRef} {...surfaceProps} className={`site-icon folder-icon folder-preview ${small ? "small" : ""}`} style={style}>
        {children.length ? <span className="folder-mini-grid" aria-hidden="true">{children.slice(0, 9).map((child) => <SiteIcon key={child.id} entry={child} small />)}</span> : <Folder weight="duotone" size="58%" />}
      </span>
    );
  return (
    <span
      ref={surfaceRef}
      {...surfaceProps}
      className={`site-icon ${small ? "small" : ""}`}
      style={style}
    >
      {hasImage ? (
        <IconArtwork src={renderedImage} scheme={scheme} className={fullBleed ? 'full-bleed-icon' : adapted.adapted && renderedImage === adapted.url ? "adapted-icon" : undefined}
          onError={(url) => setFailedImage((current) => ({ source, urls: [...(current.source === source ? current.urls : []), url].slice(-8) }))} />
      ) : (
        <span className="letter-icon">
          {letterIcon(entry.name).value}
        </span>
      )}
    </span>
  );
}
function DragArtwork({ entry, entries, snapshot, compact = false }) {
  const holder = useRef(null);
  const scale = snapshot && compact ? Math.min(1, 64 / Math.max(snapshot.width, snapshot.height)) : 1;
  useLayoutEffect(() => {
    if (!snapshot || !holder.current) return;
    snapshot.node.style.transform = `scale(${scale})`;
    holder.current.replaceChildren(snapshot.node);
    snapshot.restoreScroll();
    return () => { snapshot.node.remove(); };
  }, [snapshot, scale]);
  return entry.type === 'widget' ? snapshot && <span className="drag-widget-snapshot" ref={holder} aria-hidden="true" style={{ width: snapshot.width * scale, height: snapshot.height * scale }} />
    : <SiteIcon entry={entry} children={entries.filter((child) => child.parentId === entry.id).sort((a, b) => a.order - b.order)} />;
}

function Modal({ title, titleContent, onClose, onBack, backLabel = tr("返回"), closeDisabled = false, children, wide = false, maximizable = false, className = "" }) {
  const ref = useRef(null);
  const [maximized, setMaximized] = useState(false), [surface, setSurface] = useState(null);
  useLayoutEffect(() => { setSurface(ref.current); }, []);
  const previousTitle = useRef(null);
  const opener = useRef(document.activeElement);
  const dialogError = useContext(DialogError);
  useEffect(() => () => { if (opener.current?.isConnected) opener.current.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    if (!ref.current.open) ref.current.showModal();
    const selector = previousTitle.current ? ".modal-title h2" : titleContent ? ".modal-title > .icon-button" : "input:not([type=file]),[role=combobox],textarea,[role=tab][aria-selected=true]";
    ref.current.querySelector(selector)?.focus();
    ref.current.querySelector('[data-autofocus]')?.focus();
    previousTitle.current = title;
  }, [title]);
  const closeButton = <button type="button" className="icon-button" disabled={closeDisabled} onClick={onClose} aria-label={tr("关闭")}><X size={22} /></button>;
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className={`modal ${wide ? "wide" : ""} ${className} ${maximized ? 'is-maximized' : ''}`}
      data-maximized={maximized || undefined}
      onCancel={(e) => {
        e.preventDefault();
        if (!closeDisabled) onClose();
      }}
      onClick={(e) => {
        if (!closeDisabled && e.target === ref.current) {
          const box = ref.current.getBoundingClientRect();
          if (
            e.clientX < box.left ||
            e.clientX > box.right ||
            e.clientY < box.top ||
            e.clientY > box.bottom
          )
            onClose();
        }
      }}
    >
      <div className={`modal-title ${titleContent ? "folder-title" : ""}`}>
        {onBack && <button type="button" className="icon-button" disabled={closeDisabled} onClick={onBack} aria-label={backLabel}><ArrowLeft size={22} /></button>}
        {titleContent && closeButton}
        {titleContent || <h2 tabIndex={-1}>{title}</h2>}
        {maximizable && <button type="button" className="icon-button modal-maximize" aria-pressed={maximized}
          aria-label={maximized ? tr('还原窗口') : tr('最大化')} title={maximized ? tr('还原窗口') : tr('最大化')}
          onClick={() => setMaximized((value) => !value)}>{maximized ? <CornersIn size={20} /> : <CornersOut size={20} />}</button>}
        {!titleContent && closeButton}
      </div>
      <DialogSurface.Provider value={surface}>
        <MessageDialog message={dialogError} />
        {children}
      </DialogSurface.Provider>
    </dialog>
  );
}

export function App() {
  useLanguage();
  useEffect(() => { if (!demo) return startCloudSync(); }, []);
  const [state, setState] = useState(null),
    [folderId, setFolder] = useState(null);
  const [query, setQuery] = useState(""),
    [provider, setProvider] = useState("browser"),
    [engineMenu, setEngineMenu] = useState(false),
    [candidate, setCandidate] = useState(-1),
    [focused, setFocused] = useState(false);
  const [modal, setModal] = useState(null),
    [entry, setEntry] = useState(null),
    [context, setContext] = useState(null);
  const [notice, setNotice] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [undo, setUndo] = useState(null),
    [importPlan, setImportPlan] = useState(null),
    [backupPlan, setBackupPlan] = useState(null);
  const [siteInfo, setSiteInfo] = useState({ phase: "idle", message: "" });
  const preferenceState = useRef(state);
  preferenceState.current = state;
  const [activeScreen, setActiveScreen] = useState('0:0'), [draftPage, setDraftPage] = useState(null);
  const desktopScreen = useRef({ key: '0:0', page: 0, columns: 8, items: [] });
  const [screenManager, setScreenManager] = useState(false);
  const layoutPress = useRef(null), layoutLongClick = useRef(false);
  const mainRef = useRef(null), wallpaperRef = useRef(null);
  const [providerIconEpoch, setProviderIconEpoch] = useState(0);
  const siteRequest = useRef(0), manualFields = useRef({ name: false }), originalSiteOrigin = useRef(null);
  const inputRef = useRef(null),
    bookmarkInput = useRef(null),
    backupInput = useRef(null);
  useEffect(() => {
    const sequence = ++siteRequest.current;
    if (modal?.kind !== "entry" || entry?.type !== "site" || !entry.url) {
      setSiteInfo({ phase: "idle", message: "" });
      return;
    }
    let normalized;
    try { normalized = normalizeUrl(entry.url); } catch { return; }
    const origin = new URL(normalized).origin;
    if (!modal.isNew && origin === originalSiteOrigin.current) return;
    const entryId = entry.id;
    const timer = setTimeout(async () => {
      if (siteRequest.current !== sequence) return;
      setEntry((value) => {
        if (value?.id !== entryId || siteRequest.current !== sequence) return value;
        const name = manualFields.current.name ? value.name : fallbackSiteName(normalized);
        return { ...value, name, icon: value.icon.kind !== "letter" ? value.icon : letterIcon(name) };
      });
      if (siteRequest.current === sequence) fillSiteInfo(normalized, entryId, sequence);
    }, 700);
    return () => clearTimeout(timer);
  }, [modal?.kind, entry?.id, entry?.url]);
  const notify = (text, kind = "info") =>
    setNotice({ text, kind, id: Date.now() });
  const layoutEditor = useLayoutEdit({ state, columns: desktopScreen.current.columns, activeKey: activeScreen,
    blocked: Boolean(modal || folderId || context || screenManager), onActiveChange: setActiveScreen,
    onError: (message) => notify(message, 'error'), onCancelDrag: () => cancelDrag(),
    onBegin: () => { cancelDrag(); stopLayoutPress(); setFolder(null); setContext(null); setEngineMenu(false); setQuery(''); setFocused(false); setUndo(null); setNotice(null); setDraftPage(null); focusDesktop(); },
    onEnd: () => { stopLayoutPress(); setContext(null); setScreenManager(false); setDraftPage(null); focusDesktop(); },
    onSave: async (next, revision) => {
      const saved = demo ? { ...migrateNavigationState(next), revision: preferenceState.current.revision + 1 } : await saveState(next, revision);
      const removedClocks = state.entries.filter((item) => item.type === 'widget' && item.extensionId === CLOCK_WIDGET_ID && !saved.entries.some((entry) => entry.id === item.id));
      setState(saved); preferenceState.current = saved; setError('');
      for (const clock of removedClocks) await removeClockState(clock.id).catch((reason) => notify(reason.message, 'error'));
      return saved;
    },
  });
  const desktopState = layoutEditor.draft || state;
  useEffect(() => {
    if (['clock', 'personal-tool'].includes(modal?.kind) && state && !state.entries.some((item) => item.id === modal.id && item.type === 'widget' && !item.detached)) setModal(null);
  }, [state, modal?.kind, modal?.id]);
  useEffect(() => {
    const alert = (event) => { if (event.detail?.title) notify(`${event.detail.title}${event.detail.message ? ` · ${event.detail.message}` : ''}`); };
    window.addEventListener('covelet-clock-alert', alert);
    return () => window.removeEventListener('covelet-clock-alert', alert);
  }, []);
  useEffect(() => {
    let mounted = true;
    (demo ? Promise.resolve(createInitialState()) : loadState())
      .then((value) => {
        if (mounted) {
          setState(value);
        }
      })
      .catch((e) => {
        if (mounted) setError(e.message);
      });
    const off = demo
      ? () => {}
      : subscribeState((value) => {
          if (!mounted) return;
          setState(value);
          setFolder((id) =>
            value.entries.some((e) => e.id === id) ? id : null,
          );
        });
    return () => {
      mounted = false;
      off();
    };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 7000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const cancel = () => { clearTimeout(layoutPress.current?.timer); layoutPress.current = null; };
    window.addEventListener('blur', cancel); window.addEventListener('pointerup', cancel);
    return () => { cancel(); window.removeEventListener('blur', cancel); window.removeEventListener('pointerup', cancel); };
  }, []);
  useEffect(() => {
    if (!context && !engineMenu) return;
    const dismiss = (e) => {
      if (!e.target.closest("[data-popover]")) {
        setContext(null);
        setEngineMenu(false);
      }
    };
    document.addEventListener("pointerdown", dismiss);
    const escape = (event) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        setContext(null);
        setEngineMenu(false);
      }
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [context, engineMenu]);
  useEffect(() => {
    if (!state) return;
    if (
      provider !== "browser" &&
      !state.providers.some((p) => p.id === provider)
    )
      setProvider("browser");
    if (folderId) {
      const folder = state.entries.find(
        (e) => e.id === folderId && e.type === "folder",
      );
      if (!folder) setFolder(null);
    }
  }, [state, provider, folderId]);
  const settings = state?.settings;
  const wallpaper = useDailyWallpaper(["bing", "image"].includes(settings?.background.kind));
  const imageUrl = ["bing", "image"].includes(settings?.background.kind)
    ? wallpaper?.url || "./assets/alpine-lake.png"
    : settings?.background.kind === "builtin" ? "./assets/alpine-lake.png" : null;
  const visualEnabled = Boolean(settings?.visualEnhancement);
  const wallpaperAppearance = useWallpaperAppearance(imageUrl, visualEnabled);
  const adaptive = visualEnabled && wallpaperAppearance.phase === "ready"
    ? createAdaptiveAppearance(wallpaperAppearance.palette, settings.shade) : null;
  const candidates =
    state && query.trim() ? searchEntries(state, query).slice(0, 6) : [];
  const currentFolder = state?.entries.find((item) => item.id === folderId);
  const selectedProvider = state?.providers.find((item) => item.id === provider);
  const items =
    desktopState?.entries
      .filter((item) => item.parentId === null && !item.detached)
      .sort((a, b) => a.order - b.order) ?? [];
  const { drag, tileProps, cancelDrag } = useIconDrag({ state: desktopState, page: Number(activeScreen.split(':')[0]), screenKey: activeScreen,
    editing: layoutEditor.editing, selectedIds: layoutEditor.selectedIds, onSelect: layoutEditor.setSelectedIds,
    onCancel: (message) => notify(message, "error"),
    onPageHover: (target) => {
      if (target.create) layoutEditor.addPage(target.page);
      setActiveScreen(target.key);
    },
    onDrop: async (ids, target, revision) => {
      try {
        if (layoutEditor.editing && target.kind === 'delete') { requestLayoutDelete(ids); return; }
        const result = applyDesktopDrop(desktopState, ids, target, desktopScreen.current.columns, uid);
        if (layoutEditor.editing) {
          layoutEditor.replaceDraft(result.state, target.kind === 'combine' ? [result.revealId] : ids);
          revealDesktopEntry(result.state, result.revealId); return;
        }
        const saved = await commit(result.state, undefined, revision);
        if (saved) {
          if (folderId && !target.parentId) setFolder(null);
          revealDesktopEntry(saved, result.revealId);
          setDraftPage(null);
        }
      } catch (err) { notify(err.message, "error"); }
    },
  });
  useNavigationContrast({ rootRef: mainRef, wallpaperRef, enabled: visualEnabled, background: settings?.background,
    sample: wallpaperAppearance.palette?.sample, shade: settings?.shade, blur: settings?.blur, theme: settings?.theme,
    screenKey: activeScreen, entries: desktopState?.entries, editing: layoutEditor.editing, showLabels: settings?.showLabels, drag });
  function revealDesktopEntry(next, id) {
    const entry = next.entries.find((item) => item.id === id);
    const root = entry?.parentId || id;
    const screen = layoutDesktop(next.entries, desktopScreen.current.columns, null, next.settings.pages).find((screen) => screen.items.some((item) => item.id === root));
    if (screen) setActiveScreen(screen.key);
  }
  function stopLayoutPress() {
    clearTimeout(layoutPress.current?.timer); layoutPress.current = null;
  }
  function focusDesktop() {
    requestAnimationFrame(() => document.querySelector('.desktop-page-viewport')?.focus({ preventScroll: true }));
  }
  function showLayoutMenu(x, y, source) {
    if (layoutEditor.saving) return;
    stopLayoutPress(); cancelDrag();
    setContext({ kind: 'layout', x, y, source });
  }
  function manageScreens() {
    if (!layoutEditor.editing || layoutEditor.saving) return;
    stopLayoutPress(); cancelDrag(); setContext(null); setScreenManager(true);
  }
  function requestLayoutDelete(ids) {
    if (!layoutEditor.editing || layoutEditor.saving || layoutEditor.conflict || !ids.length || modal?.kind === 'layout-delete') return;
    const selected = desktopState.entries.filter((item) => ids.includes(item.id) && item.parentId === null && !item.detached);
    if (!selected.length) return;
    const children = desktopState.entries.filter((item) => selected.some((root) => root.type === 'folder' && root.id === item.parentId));
    cancelDrag(); setContext(null);
    setModal({ kind: 'layout-delete', ids: selected.map((item) => item.id), draft: desktopState,
      title: selected.length === 1 ? tr("删除“{0}”？", [selected[0].type === "widget" ? builtinName(selected[0].extensionId, selected[0].name) : selected[0].name]) : tr("删除所选 {0} 项？", [selected.length]),
      children: children.length, clock: selected.some((item) => item.type === 'widget' && item.extensionId === CLOCK_WIDGET_ID) });
  }
  function confirmLayoutDelete() {
    if (modal?.kind !== 'layout-delete' || !layoutEditor.editing || layoutEditor.saving || layoutEditor.conflict) return;
    try {
      if (modal.draft !== desktopState) throw Error(tr("所选项目已发生变化，请重新选择。"));
      layoutEditor.replaceDraft(deleteDesktopEntries(desktopState, modal.ids, desktopScreen.current.columns), []);
      setModal(null); focusDesktop();
    } catch (reason) { notify(reason.message, 'error'); }
  }
  async function commit(next, message, expected = state.revision) {
    setError("");
    try {
      const checked = migrateNavigationState(next),
        saved = demo
          ? { ...checked, revision: state.revision + 1 }
          : await saveState(checked, expected);
      setState(saved);
      if (message) notify(message);
      return saved;
    } catch (e) {
      setError(e.message);
      notify(e.message, "error");
      return null;
    }
  }
  function openClock(item) {
    if (layoutEditor.editing || modal || drag) return;
    stopLayoutPress(); cancelDrag(); setContext(null); setEngineMenu(false); setQuery(''); setFocused(false);
    setModal({ kind: item.extensionId === CLOCK_WIDGET_ID ? 'clock' : 'personal-tool', id: item.id });
  }
  function openEntry(item) {
    if (item.type === 'widget' && [CLOCK_WIDGET_ID, 'notes', 'read-later'].includes(item.extensionId)) {
      revealDesktopEntry(state, item.id); openClock(item); return;
    }
    if (item.type === "folder") {
      revealDesktopEntry(state, item.id);
      setFolder(item.id);
      setQuery("");
      setFocused(false);
    } else if (settings.openNewTab)
      window.open(item.url, "_blank", "noopener,noreferrer");
    else location.assign(item.url);
  }
  async function saveFolderName(name, originalName) {
    const folder = state.entries.find((item) => item.id === folderId && item.type === "folder");
    if (!folder) throw Error(tr("文件夹已被移除。"));
    if (folder.name !== originalName) throw Error(tr("文件夹名称已在其他页面更新，请重新编辑。"));
    const entries = state.entries.map((item) => item.id === folder.id
      ? { ...item, name, icon: item.icon.kind === "letter" ? letterIcon(name) : item.icon }
      : item);
    return Boolean(await commit({ ...state, entries }, undefined, state.revision));
  }
  async function submit(e) {
    e.preventDefault();
    if (candidate >= 0 && candidates[candidate]) {
      openEntry(candidates[candidate]);
      return;
    }
    if (!query.trim()) return;
    try {
      if (
        /^https?:\/\//i.test(query) ||
        /^(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}(?::\d+)?(?:[/?#].*)?$/u.test(
          query.trim(),
        )
      ) {
        const url = normalizeUrl(query);
        if (settings.openNewTab)
          window.open(url, "_blank", "noopener,noreferrer");
        else location.assign(url);
      } else
        await submitWebSearch(query, provider, state.providers, {
          newTab: settings.openNewTab,
        });
    } catch (e) {
      notify(e.message, "error");
    }
  }
  function newEntry() {
    setEntry({
      id: uid(),
      type: "site",
      name: "",
      url: "",
      groupId: "group-home",
      parentId: null,
      page: desktopScreen.current.page,
      icon: letterIcon(""),
      order: state.entries.filter((e) => e.parentId === null).length,
    });
    setModal({ kind: "entry", revision: state.revision, isNew: true, targetIndex: desktopScreen.current.items.at(-1)?.order + 1 || undefined });
    setError("");
    manualFields.current = { name: false };
    originalSiteOrigin.current = null;
    siteRequest.current++;
    setSiteInfo({ phase: "idle", message: "" });
  }
  function editEntry(item) {
    if (item.type === 'widget') {
      setContext(null); setError('');
      setModal({ kind: 'extensions', initialExtension: item.extensionId, editingId: item.id });
      return;
    }
    setEntry(structuredClone(item));
    setModal({ kind: "entry", revision: state.revision, isNew: false });
    setContext(null);
    setError("");
    manualFields.current = { name: false };
    originalSiteOrigin.current = item.type === "site" ? new URL(item.url).origin : null;
    siteRequest.current++;
    setSiteInfo({ phase: "idle", message: "" });
  }
  function closeEntry() {
    siteRequest.current++;
    setModal(null);
    setEntry(null);
  }
  async function useWidget(config, original, extensionId = original?.extensionId || GITHUB_WIDGET_ID) {
    const latest = demo ? preferenceState.current : await loadState();
    const existing = latest.entries.find((item) => item.id === original?.id);
    if (original && (!existing || Boolean(existing.detached) !== Boolean(original.detached) || JSON.stringify(existing.config) !== JSON.stringify(original.config))) throw new Error(tr("组件已在其他页面修改或移除，请重新打开扩展。"));
    if (!original && latest.entries.some((item) => item.type === 'widget' && item.extensionId === extensionId)) throw new Error(tr("组件已在其他页面添加，请重新打开扩展。"));
    const next = configureWidget(latest, extensionId, config, original?.id, { page: desktopScreen.current.page });
    const saved = await commit(next, undefined, latest.revision);
    if (!saved) throw new Error(tr("组件未保存，请重试。"));
    setModal(null);
    const widget = saved.entries.find((item) => original ? item.id === original.id : item.type === 'widget' && item.extensionId === extensionId);
    revealDesktopEntry(saved, widget.id);
    setDraftPage(null);
    requestAnimationFrame(() => document.getElementById(`widget-title-${widget.id}`)?.focus({ preventScroll: true }));
  }
  async function removeEntry(item) {
    const before = state,
      saved = await commit(deleteEntry(state, item.id), tr("已删除"));
    if (saved) {
      if (item.type === 'widget' && item.extensionId === CLOCK_WIDGET_ID) await removeClockState(item.id).catch((reason) => notify(reason.message, 'error'));
      setUndo({ before, revision: saved.revision });
      if (folderId === item.id) setFolder(null);
    }
    setContext(null);
    setModal(null);
  }
  async function undoDelete() {
    if (!undo) return;
    const saved = await commit(
      { ...undo.before, revision: state.revision },
      undefined,
      undo.revision,
    );
    if (saved) { setUndo(null); setNotice(null); }
  }
  async function fillSiteInfo(url, entryId, sequence, explicit = false) {
    if (siteRequest.current !== sequence) return;
    const origin = new URL(normalizeUrl(url)).origin;
    setSiteInfo({ phase: "loading", message: explicit ? tr("正在获取名称…") : "" });
    try {
      const info = await recognizeSite(url);
      if (siteRequest.current !== sequence) return;
      let icon;
      if (info.highResolution && info.iconUrl) icon = { kind: 'url', value: info.iconUrl };
      else if (info.icon) {
        try {
          const id = await putImage(info.icon, "icon");
          icon = { kind: "image", value: id };
        } catch { /* An unavailable image uses the existing or text icon. */ }
        if (siteRequest.current !== sequence) return;
      }
      setEntry((value) => {
        if (siteRequest.current !== sequence || value?.id !== entryId) return value;
        const next = applyRecognizedSite(value, { title: info.title, icon }, { entryId, origin, preserveName: manualFields.current.name, preserveIcon: true });
        return info.iconUrl && !manualFields.current.icon ? withDiscoveredIcon(next, { url: info.iconUrl, fit: info.iconFit, variants: info.iconVariants }) : next;
      });
      const missingName = explicit && info.title === fallbackSiteName(url);
      setSiteInfo({ phase: missingName ? "error" : "ready", message: missingName ? tr("未获取到名称，请手动填写。") : "", hasAccess: info.hasAccess });
    } catch (err) {
      if (siteRequest.current === sequence) {
        setSiteInfo({ phase: "error", message: explicit ? tr("获取名称失败，请重试或手动填写。") : "" });
      }
    }
  }
  function authorizeSiteInfo() {
    let access;
    const sequence = ++siteRequest.current, entryId = entry.id, url = entry.url;
    try {
      // Invoke the browser permission request immediately in this click gesture.
      access = siteInfo.hasAccess ? Promise.resolve(true) : requestSiteAccess(url);
    } catch (err) { setSiteInfo({ phase: "error", message: err.message }); return; }
    setSiteInfo({ phase: "permission", message: tr("请允许读取此网站以获取名称。") });
    Promise.resolve(access).then((allowed) => {
      if (siteRequest.current !== sequence) return;
      if (allowed) fillSiteInfo(url, entryId, sequence, true);
      else {
        setSiteInfo({ phase: "access", message: tr("未获得读取权限，请手动填写名称。") });
      }
    }).catch((err) => { if (siteRequest.current === sequence) setSiteInfo({ phase: "error", message: err.message }); });
  }
  function findHdIcon() {
    const url = entry.url, entryId = entry.id, sequence = ++siteRequest.current;
    let permission;
    try { permission = requestSiteAccess(url); }
    catch (reason) { setSiteInfo({ phase: 'error', message: reason.message }); return; }
    setSiteInfo({ phase: 'loading', message: '' });
    Promise.resolve(permission).then(async (allowed) => {
      if (!allowed) throw Error(tr("未获得读取权限，已保留原图。"));
      const result = await discoverHighResolutionIcon(url);
      if (sequence !== siteRequest.current) return;
      manualFields.current.icon = true;
      setEntry((value) => value?.id === entryId ? withDiscoveredIcon({ ...value, icon: { kind: 'url', value: result.url } }, result) : value);
      setSiteInfo({ phase: 'ready', message: '', hasAccess: true });
    }).catch((reason) => { if (sequence === siteRequest.current) setSiteInfo({ phase: 'error', message: reason.message }); });
  }
  async function saveEntry(e) {
    e.preventDefault();
    siteRequest.current++;
    try {
      const value = { ...entry, name: entry.name.trim() };
      if (value.type === "site") {
        value.url = normalizeUrl(value.url);
        value.iconUrl = value.iconUrl ? normalizeIconAddress(value.iconUrl) : preferredIconAddress(value.url);
      }
      else {
        delete value.url;
        value.parentId = null;
      }
      if (value.icon.kind === "letter")
        value.icon = letterIcon(value.name);
      let next = {
        ...state,
        entries: modal.isNew
          ? [...state.entries, value]
          : state.entries.map((item) => (item.id === value.id ? value : item)),
      };
      if (modal.isNew) {
        next = moveEntry(next, value.id, { page: value.page, index: modal.targetIndex });
      }
      const saved = await commit(next, undefined, modal.revision);
      if (saved) {
        revealDesktopEntry(saved, value.id);
        setDraftPage(null);
        setModal(null);
        setEntry(null);
      }
    } catch (e) {
      setError(e.message);
    }
  }
  async function readBookmarks(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw Error(tr("书签文件不能超过 5 MB"));
      const plan = parseBookmarks(await file.text());
      const preview = applyBookmarkImport(state, plan);
      plan.addedSites =
        preview.entries.filter((item) => item.type === "site").length -
        state.entries.filter((item) => item.type === "site").length;
      plan.addedFolders =
        preview.entries.filter((item) => item.type === "folder").length -
        state.entries.filter((item) => item.type === "folder").length;
      plan.skippedDuplicates = plan.sites.length - plan.addedSites;
      setImportPlan(plan);
      setModal({ kind: "bookmarks", revision: state.revision });
    } catch (e) {
      notify(e.message, "error");
    }
  }
  async function readBackup(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    try {
      setBackupPlan(await inspectBackup(file));
      setModal({ kind: "restore", revision: state.revision });
    } catch (e) {
      notify(e.message, "error");
    } finally {
      setBusy(false);
    }
  }
  async function download(currentState) {
    setBusy(true);
    try {
      const blob = await exportBackup(currentState || preferenceState.current),
        url = URL.createObjectURL(blob),
        a = document.createElement("a");
      a.href = url;
      a.download = "Covelet-backup.zip";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify(tr("完整备份已导出"));
    } catch (e) {
      notify(e.message, "error");
    } finally {
      setBusy(false);
    }
  }
  function renderTiles(list, placements) {
    return list.map((item) => {
      const target = drag?.target?.id === item.id ? drag.target : null;
      const children = desktopState.entries.filter((entry) => entry.parentId === item.id).sort((a, b) => a.order - b.order);
      const editing = layoutEditor.editing && item.parentId === null, selected = editing && layoutEditor.selectedIds.includes(item.id);
      const Tile = item.type === 'widget' ? WidgetTile : 'div';
      const placement = placements?.get(item.id);
      return <Tile key={item.id} {...(item.type === 'widget' ? { item, editing } : {})}
        role={editing ? 'button' : undefined} tabIndex={editing ? 0 : undefined} aria-label={editing ? builtinName(item.extensionId, item.name) : undefined} aria-pressed={editing ? selected : undefined}
        data-grid-row={placement ? placement.row - 1 : undefined} data-grid-column={placement ? placement.column - 1 : undefined}
        style={placement ? { gridColumn: `${placement.column} / span ${placement.columns}`, gridRow: `${placement.row} / span ${placement.rows}` } : undefined}
        className={`site-tile ${drag?.ids.includes(item.id) ? "dragging" : ""} ${selected ? 'is-selected' : ''} ${target?.kind === "combine" ? "combine-target" : ""} ${target?.kind === "move" ? `insert-${target.side}` : ""}`}
        {...tileProps(item)}
        onContextMenu={(event) => {
          event.preventDefault();
          if (drag) return;
          const source = editing ? event.currentTarget : event.currentTarget.querySelector('.site-link, [id^="widget-title-"]');
          const box = source.getBoundingClientRect();
          setContext({ kind: editing ? 'layout' : "entry", item, source, x: event.clientX || box.left, y: event.clientY || box.bottom });
        }}
        onKeyDown={(event) => {
          if (editing && !drag && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && !event.altKey) {
            event.preventDefault(); event.stopPropagation();
            layoutEditor.setSelectedIds([...new Set([...layoutEditor.selectedIds, ...list.filter((entry) => entry.parentId === null && !entry.detached).map((entry) => entry.id)])]);
            return;
          }
          if (editing && !drag && !event.ctrlKey && !event.metaKey && !event.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
            event.preventDefault(); event.stopPropagation(); focusDesktopNeighbor(event.currentTarget, event.key); return;
          }
          if (editing && event.key === ' ') {
            event.preventDefault(); event.stopPropagation();
            if (!event.repeat) layoutEditor.setSelectedIds(selected ? layoutEditor.selectedIds.filter((id) => id !== item.id) : [...layoutEditor.selectedIds, item.id]);
            return;
          }
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          event.stopPropagation();
          if (drag) return;
          const source = editing ? event.currentTarget : event.currentTarget.querySelector('.site-link, [id^="widget-title-"]');
          const box = source.getBoundingClientRect();
          setContext({ kind: editing ? 'layout' : "entry", item, source, keyboard: true, x: box.left, y: box.bottom + 6 });
        }}>
        {item.type === 'widget' ? item.extensionId === CLOCK_WIDGET_ID
          ? <ClockWidget entry={item} open={modal?.kind === 'clock' && modal.id === item.id} onOpen={() => openClock(item)} onClose={() => setModal(null)} Dialog={Modal} portalTarget={mainRef.current} />
          : ['notes', 'read-later'].includes(item.extensionId) ? <PersonalWidget entry={item} open={modal?.kind === 'personal-tool' && modal.id === item.id} onOpen={() => openClock(item)} onClose={() => setModal(null)} Dialog={Modal} portalTarget={mainRef.current} />
          : <GitHubWidget entry={item} /> : item.type === "site" ? <a className="site-link" inert={editing || undefined} tabIndex={editing ? -1 : undefined} href={item.url} draggable={false} target={settings.openNewTab ? "_blank" : undefined} rel="noreferrer noopener" title={`${item.name}\n${item.url}`}>
          <SiteIcon entry={item} /><span className="site-name">{item.name}</span>
        </a> : <button className="site-link" inert={editing || undefined} tabIndex={editing ? -1 : undefined} title={item.name} aria-label={item.name} aria-haspopup="dialog" onClick={() => openEntry(item)}>
          <SiteIcon entry={item} children={children} /><span className="site-name">{item.name}</span>
        </button>}
        {selected && <span className="layout-selection-mark" aria-hidden="true"><Check size={13} weight="bold" /></span>}
      </Tile>;
    });
  }
  function renderDragGhost() {
    if (!drag) return null;
    const dragged = drag.items || [drag.item];
    const anchor = drag.previewAnchor;
    const artwork = (item, index = 0) => <DragArtwork entry={item} entries={desktopState.entries} snapshot={drag.previews?.get(item.id)} compact={index > 0} />;
    return <div className={`icon-drag-ghost ${dragged.length > 1 ? 'is-multiple' : ''} ${anchor ? 'is-widget' : ''}`} aria-hidden="true"
      style={anchor ? { left: drag.x - anchor.x, top: drag.y - anchor.y, width: anchor.width, height: anchor.height } : { left: drag.x, top: drag.y }}>
      {dragged.length > 1 ? dragged.slice(0, 4).map((item, index) => <span key={item.id} className="icon-drag-stack" style={{ '--stack-index': index, zIndex: 5 - index }}>{artwork(item, index)}</span>) : artwork(drag.item)}
      {dragged.length > 1 && <b className="drag-count">{dragged.length}</b>}
      <span className="drag-target-label">{drag.target?.label || tr("松开取消")}</span>
    </div>;
  }
  function renderContextMenu() {
    if (!context) return null;
    if (context.kind === 'layout') return <ContextMenu context={context} label={tr("布局操作")} onClose={() => setContext(null)} items={layoutEditor.editing ? [
      { label: tr("屏幕管理"), icon: <SquaresFour size={18} />, action: manageScreens, disabled: layoutEditor.saving },
      { label: tr("保存布局"), icon: <Check size={18} />, action: layoutEditor.save, disabled: layoutEditor.saving || layoutEditor.conflict },
      { label: tr("退出编辑"), icon: <X size={18} />, action: layoutEditor.cancel, disabled: layoutEditor.saving },
    ] : [{ label: tr("编辑布局"), icon: <PencilSimple size={18} />, action: layoutEditor.begin }]} />;
    const item = context.item;
    return <ContextMenu context={context} label={item.type === 'widget' ? tr("组件操作") : tr("网站操作")} onClose={() => setContext(null)} items={[
      ...(item.type === 'widget' && item.extensionId === GITHUB_WIDGET_ID ? [{ label: tr('打开'), icon: <ArrowSquareOut size={18} />, action: () => window.open(`https://github.com/${item.config.username}`, '_blank', 'noopener,noreferrer') }] : []),
      { label: item.type === 'widget' ? tr("配置组件") : tr("编辑"), icon: <PencilSimple size={18} />, action: () => editEntry(item) },
      { label: tr("编辑布局"), icon: <SquaresFour size={18} />, action: layoutEditor.begin },
      { divider: true },
      { label: item.type === 'widget' ? tr("移除组件") : item.type === "folder" ? tr("解散文件夹") : tr("删除网站"), icon: <Trash size={18} />, danger: true, action: () => removeEntry(item) },
    ]} />;
  }
  if (!state)
    return (
      <main className="loading-screen">
        {error ? (
          <>
            <h1>{tr("暂时无法读取本地数据")}</h1>
            <p>{tr(error)}</p>
            <button onClick={() => location.reload()}>{tr("重新读取")}</button>
          </>
        ) : (
          <span>Covelet</span>
        )}
      </main>
    );
  const background = ["color", "gradient"].includes(settings.background.kind)
    ? colorBackgroundCss(settings.background)
    : undefined;
  return (
    <DialogError.Provider value={notice?.kind === "error" ? notice.text : ""}>
      <AdaptIcons.Provider value={visualEnabled}>
      <main
        ref={mainRef}
        className={`owntab theme-${settings.theme} ${visualEnabled ? 'visual-enhanced' : ''} ${adaptive ? "adaptive-wallpaper" : ""} ${layoutEditor.editing ? 'layout-editing' : ''}`}
        style={{
          ...adaptive?.style,
          "--content-width": `${settings.width}px`,
          "--icon-size": `${settings.iconSize}px`,
          "--grid-gap": `${settings.gap}px`,
        }}
      >
        <div
          ref={wallpaperRef}
          className="wallpaper"
          style={{
            ...(imageUrl
              ? { backgroundImage: `url("${imageUrl}")` }
              : background
                ? { background }
                : {}),
            filter: `blur(${settings.blur}px)`,
          }}
        />
        <div
          className="wallpaper-shade"
          style={{ backgroundColor: `rgba(0,0,0,${(adaptive?.shade ?? settings.shade) / 100})`,
            ...(visualEnabled ? { backgroundImage: VISUAL_SHADE_BACKGROUND } : {}) }}
        />
        <header className="page-header">
          <div className="header-actions" inert={layoutEditor.editing || undefined}>
            <button className="header-icon" type="button" aria-label={tr("添加网站")} title={tr("添加网站")} onClick={newEntry}><Plus size={25} /></button>
            <button
              className="header-icon"
              aria-label={tr("打开扩展")}
              title={tr("扩展")}
              onClick={() => {
                setModal({ kind: "extensions" });
                setError("");
              }}
            >
              <PuzzlePiece size={27} />
            </button>
            <button
              className="header-icon"
              aria-label={tr("打开设置")}
              title={tr("设置")}
              onClick={() => {
                setModal({ kind: "settings", revision: state.revision });
                setError("");
              }}
            >
              <GearSix size={29} />
            </button>
          </div>
        </header>
        <section className="search-area" aria-label={tr("搜索")} inert={layoutEditor.editing || undefined}>
          <form className="search-box" onSubmit={submit} role="search">
            <div className="engine-selector" data-popover>
              <button
                type="button"
                className="engine-button"
                aria-label={tr("选择搜索引擎，当前为{0}", [providerName(selectedProvider)])}
                title={providerName(selectedProvider)}
                aria-expanded={engineMenu}
                onClick={() => setEngineMenu(!engineMenu)}
              >
                {selectedProvider
                  ? <SearchProviderIcon provider={selectedProvider} epoch={providerIconEpoch} fallback="name" />
                  : <MagnifyingGlass className="provider-symbol" size={24} weight="light" aria-hidden="true" />}
                <CaretDown className="engine-caret" size={13} aria-hidden="true" />
              </button>
              {engineMenu && (
                <div className="popover engine-popover">
                  <button
                    type="button"
                    onClick={() => {
                      setProvider("browser");
                      setEngineMenu(false);
                    }}
                  >
                    <MagnifyingGlass className="provider-symbol" size={22} weight="light" aria-hidden="true" />
                    <span className="engine-name">{tr("浏览器默认搜索")}</span>
                    {provider === "browser" && <Check size={17} />}
                  </button>
                  <div className="popover-divider" />
                  {state.providers.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        setProvider(p.id);
                        setEngineMenu(false);
                        inputRef.current?.focus();
                      }}
                    >
                      <SearchProviderIcon provider={p} epoch={providerIconEpoch} />
                      <span className="engine-name">{providerName(p)}</span>
                      {provider === p.id && <Check size={17} />}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <input
              ref={inputRef}
              type="text"
              value={query}
              aria-label={tr("搜索或输入网址")}
              placeholder={tr("搜索或输入网址")}
              autoComplete="off"
              spellCheck="false"
              role="combobox"
              aria-expanded={Boolean(focused && candidates.length)}
              aria-controls="search-candidates"
              aria-activedescendant={
                candidate >= 0 ? `candidate-${candidate}` : undefined
              }
              onFocus={() => setFocused(true)}
              onBlur={() => setTimeout(() => setFocused(false), 120)}
              onChange={(e) => {
                setQuery(e.target.value);
                setCandidate(-1);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setFocused(true);
                  setCandidate((n) => Math.min(n + 1, candidates.length - 1));
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setCandidate((n) => Math.max(n - 1, -1));
                }
                if (e.key === "Escape") {
                  setFocused(false);
                  setCandidate(-1);
                  setEngineMenu(false);
                }
              }}
            />
            <button className="search-submit" type="submit" aria-label={tr("搜索")}>
              <MagnifyingGlass size={33} weight="light" />
            </button>
          </form>
          {focused && candidates.length > 0 && (
            <div id="search-candidates" role="listbox" className="suggestions">
              {candidates.map((item, i) => (
                <button
                  key={item.id}
                  id={`candidate-${i}`}
                  role="option"
                  aria-selected={candidate === i}
                  className={candidate === i ? "selected" : ""}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => openEntry(item)}
                >
                  <SiteIcon entry={item} small />
                  <span>
                    <strong>{item.type === "widget" ? builtinName(item.extensionId, item.name) : item.name}</strong>
                    <small>
                      {item.parentId ? state.entries.find((entry) => entry.id === item.parentId)?.name : tr("桌面")}
                      {item.type === "site"
                        ? ` · ${new URL(item.url).hostname}`
                        : tr(" · 文件夹")}
                    </small>
                  </span>
                  <ArrowSquareOut size={18} />
                </button>
              ))}
            </div>
          )}
        </section>
          <section className={`navigation-shelf ${drag ? "is-dragging" : ""}`} aria-label={tr("网站导航")} inert={layoutEditor.saving || undefined}
            onKeyDown={(event) => {
              if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
              if (event.target.closest('[data-entry-id]')) return;
              event.preventDefault(); event.stopPropagation();
              const source = event.currentTarget.querySelector('.desktop-page-viewport'), box = source.getBoundingClientRect();
              showLayoutMenu(box.left + 16, box.top + 16, source);
            }}
            onContextMenu={(event) => {
              if (event.defaultPrevented) return;
              event.preventDefault();
              showLayoutMenu(event.clientX, event.clientY, event.currentTarget.querySelector('.desktop-page-viewport'));
            }}
            onPointerDownCapture={(event) => {
              stopLayoutPress(); layoutLongClick.current = false;
              if (event.button !== 0 || event.pointerType === 'touch' || layoutEditor.editing || layoutEditor.saving || event.shiftKey || event.target.closest('dialog')
                || event.target.closest('input,textarea,[data-layout-control],.clock-widget button,.github-widget button,.github-widget a')) return;
              const source = event.target.closest('.site-link') || event.currentTarget.querySelector('.desktop-page-viewport');
              const press = { x: event.clientX, y: event.clientY };
              press.timer = setTimeout(() => {
                if (layoutPress.current !== press) return;
                layoutLongClick.current = true; showLayoutMenu(press.x, press.y, source);
              }, 650);
              layoutPress.current = press;
            }}
            onPointerMoveCapture={(event) => {
              const press = layoutPress.current;
              if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) stopLayoutPress();
            }} onPointerUpCapture={stopLayoutPress} onPointerCancel={stopLayoutPress} onPointerLeave={stopLayoutPress}
            onClickCapture={(event) => {
              if (!layoutLongClick.current) return;
              layoutLongClick.current = false; event.preventDefault(); event.stopPropagation();
            }}
            onClick={(event) => {
              if (layoutEditor.editing && !event.defaultPrevented && !event.target.closest('[data-entry-id],button,a')) layoutEditor.setSelectedIds([]);
            }}>
            <DesktopPages settings={desktopState.settings} entries={items} activeKey={activeScreen} draftPage={draftPage} drag={drag} editing={layoutEditor.editing}
              onActiveChange={setActiveScreen} onScreenChange={(screen) => { desktopScreen.current = screen; }}
              onNewPage={(page) => layoutEditor.addPage(page)} renderTiles={renderTiles} />
          </section>
        {layoutEditor.editing && <DesktopEditBar editor={layoutEditor} drag={drag} onManage={manageScreens} onDelete={requestLayoutDelete} />}
        {modal?.kind === 'layout-delete' && layoutEditor.editing && <Modal title={modal.title} onClose={() => setModal(null)}>
          <div className="form-stack">
            {modal.children > 0 && <p>{tr("文件夹内的 {0} 个网站也会删除。", [formatNumber(modal.children)])}</p>}
            {modal.clock && <p>{tr("保存后将清除所选时钟的计时记录和倒计时提醒。")}</p>}
            <div className="modal-footer"><button type="button" className="button" data-autofocus onClick={() => setModal(null)}>{tr("取消")}</button>
              <button type="button" className="button danger" disabled={layoutEditor.saving || layoutEditor.conflict} onClick={confirmLayoutDelete}>{tr("删除")}</button></div>
          </div>
        </Modal>}
        {screenManager && layoutEditor.editing && <DesktopScreenManager Dialog={Modal} state={desktopState} columns={desktopScreen.current.columns}
          activeKey={activeScreen} editor={layoutEditor} onSelect={setActiveScreen} onClose={() => { setScreenManager(false); focusDesktop(); }}
          renderIcon={(item) => <SiteIcon entry={item} small children={desktopState.entries.filter((entry) => entry.parentId === item.id).sort((a, b) => a.order - b.order)} />} />}
        {!folderId && renderContextMenu()}
        {!folderId && renderDragGhost()}
        {currentFolder && !modal && (
          <Modal title={currentFolder.name} titleContent={<FolderName name={currentFolder.name} onSave={saveFolderName} />} onClose={() => setFolder(null)} wide>
            <div className="folder-content" data-folder-panel>
              <div className="sites-grid folder-sites" data-drop-parent={currentFolder.id}>
                {renderTiles(state.entries.filter((item) => item.parentId === currentFolder.id).sort((a,b) => a.order-b.order))}
              </div>
              <div className={`folder-exit-zone ${drag?.target?.kind === "move" && drag.target.parentId === null ? "active" : ""}`} data-drop-root>
                <ArrowLeft size={18} />{tr("拖到这里移回桌面")}</div>
              {renderContextMenu()}
              {renderDragGhost()}
            </div>
          </Modal>
        )}
        {notice && (
          <div
            className={`toast ${notice.kind}`}
            role={notice.kind === "error" ? "alert" : "status"}
          >
            <span>{tr(notice.text)}</span>
            {undo && notice.kind !== "error" && (
              <button onClick={undoDelete}>
                <ArrowUUpLeft size={17} />{tr("撤销")}</button>
            )}
            <button
              className="icon-button"
              aria-label={tr("关闭提示")}
              onClick={() => setNotice(null)}
            >
              <X size={17} />
            </button>
          </div>
        )}
        {busy && (
          <div className="busy-indicator" role="status">{tr("正在处理本地文件…")}</div>
        )}
        <input
          ref={bookmarkInput}
          type="file"
          accept=".html,.htm,text/html"
          hidden
          onChange={readBookmarks}
        />
        <input
          ref={backupInput}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={readBackup}
        />
        {modal?.kind === "entry" && entry && (
          <Modal
            title={`${modal.isNew ? tr("添加") : tr("编辑")}${entry.type === "folder" ? tr("文件夹") : tr("网站")}`}
            onClose={closeEntry}
          >
            <form onSubmit={saveEntry} className="form-stack">
              {entry.type === "site" && (
                <>
                  <label>{tr("网址")}<input autoFocus required value={entry.url} maxLength={2048} placeholder="https://example.com" onChange={(event) => {
                      siteRequest.current++;
                      setSiteInfo({ phase: "idle", message: "" });
                      const url = event.target.value;
                      setEntry((value) => {
                        let previousOrigin, nextOrigin;
                        try { previousOrigin = new URL(normalizeUrl(value.url)).origin; } catch { /* Incomplete URL. */ }
                        try { nextOrigin = new URL(normalizeUrl(url)).origin; } catch { /* Incomplete URL. */ }
                        const changed = !nextOrigin || previousOrigin !== nextOrigin;
                        const name = changed && nextOrigin && !manualFields.current.name ? fallbackSiteName(url) : value.name;
                        if (changed) manualFields.current.icon = false;
                        const next = { ...value, url, name, icon: changed ? letterIcon(name) : value.icon };
                        return changed ? withDiscoveredIcon(next, { url: preferredIconAddress(url) }) : next;
                      });
                    }} />
                  </label>
                </>
              )}
              <div className="site-name-field">
                <div className="field-heading"><label htmlFor="entry-name">{tr("名称")}</label>{entry.type === "site" && <button className="field-action" type="button" disabled={!entry.url || !supportsSiteInfo() || ["loading", "permission"].includes(siteInfo.phase)} aria-describedby={!siteInfo.hasAccess && supportsSiteInfo() ? "site-name-permission" : undefined} onClick={authorizeSiteInfo}>{tr("获取名称")}</button>}</div>
                <input
                  id="entry-name"
                  autoFocus={entry.type === "folder"}
                  required
                  maxLength={200}
                  value={entry.name}
                  onChange={(e) => {
                    manualFields.current.name = true;
                    const name = e.target.value;
                    setEntry((value) => ({ ...value, name, icon: value.icon.kind !== "letter" ? value.icon : letterIcon(name) }));
                  }}
                  placeholder={
                    entry.type === "folder" ? tr("例如：工作资料") : tr("例如：GitHub")
                  }
                />
              </div>
              {entry.type === "site" && (siteInfo.message || supportsSiteInfo() && !siteInfo.hasAccess) && <div className="site-recognition">
                {supportsSiteInfo() && !siteInfo.hasAccess && <span className="hint" id="site-name-permission">{tr("获取名称时需允许读取此网站。")}</span>}
                {siteInfo.message && <span className="hint" role="status">{tr(siteInfo.message)}</span>}
              </div>}
              <IconBackground value={entry.iconBackground || DEFAULT_ICON_BACKGROUND}
                onChange={(iconBackground) => setEntry((value) => ({ ...value, iconBackground }))}
                onReset={() => setEntry((value) => { const next = { ...value }; delete next.iconBackground; return next; })}
                preview={<SiteIcon entry={entry} children={state.entries.filter((child) => child.parentId === entry.id).sort((a, b) => a.order - b.order)} />} />
              {entry.type === 'site' && <button type="button" className="field-action hd-icon-action" disabled={!entry.url || siteInfo.phase === 'loading'} onClick={findHdIcon}>{tr("获取高清图标")}</button>}
              {entry.type === 'site' && <label>{tr("图标地址")}<input type="url" value={entry.iconUrl ?? siteIconAddress(entry)} maxLength={4096}
                placeholder="https://example.com/icon.png" onChange={(event) => {
                  siteRequest.current++;
                  manualFields.current.icon = true;
                  const iconUrl = event.target.value;
                  let icon;
                  try { icon = { kind: 'url', value: normalizeIconAddress(iconUrl) }; } catch { /* Keep the name fallback while typing. */ }
                  setEntry((value) => withDiscoveredIcon({ ...value, icon: icon || letterIcon(value.name) }, { url: iconUrl }));
                }} /></label>}
              {error && (
                <p className="form-error" role="alert">
                  {tr(error)}
                </p>
              )}
              <div className="modal-footer">
                <button
                  type="button"
                  className="button"
                  onClick={closeEntry}
                >{tr("取消")}</button>
                <button
                  className="button primary"
                  type="submit"
                  disabled={busy}
                >
                  {modal.isNew ? tr("添加") : tr("保存")}
                </button>
              </div>
            </form>
          </Modal>
        )}
        {modal?.kind === "extensions" && (
          <ExtensionCenter Dialog={Modal} demo={demo} state={state} initialExtension={modal.initialExtension} editingId={modal.editingId} onUseWidget={useWidget} onClose={() => setModal(null)} />
        )}
        {modal?.kind === "settings" && (
          <Settings
            state={state}
            onClose={() => setModal(null)}
            readPreferences={() => demo ? Promise.resolve(preferenceState.current) : loadState()}
            writePreferences={async (next, revision) => {
              const saved = demo ? { ...migrateNavigationState(next), revision: revision + 1 } : await saveState(next, revision);
              preferenceState.current = saved;
              setState(saved);
              return saved;
            }}
            onExport={download}
            onImport={() => backupInput.current.click()}
            onBookmarks={() => bookmarkInput.current.click()}
            onSnapshot={async (latest) => {
              try {
                const result = await restoreSnapshot(latest.revision);
                setState(result);
                setModal(null);
                notify(tr("已恢复上一份本地快照"));
              } catch (e) {
                notify(e.message, "error");
              }
            }}
            wallpaper={wallpaper}
            providerIconEpoch={providerIconEpoch}
            onProviderIconReady={() => setProviderIconEpoch((value) => value + 1)}
            onRestoreConflict={async (id) => {
              try {
                const result = await restoreSyncConflict(id);
                setState(result);
                setModal(null);
                notify(tr("已恢复冲突版本"));
              } catch (e) { notify(e.message, "error"); }
            }}
          />
        )}
        {modal?.kind === "bookmarks" && importPlan && (
          <Modal title={tr("导入书签")} onClose={() => setModal(null)}>
            <div className="form-stack">
              <p>{tr("将添加 {0} 个网址和 {1} 个文件夹。相同位置的重复网址将跳过，保留现有内容。", [formatNumber(importPlan.addedSites ?? importPlan.sites.length), formatNumber(importPlan.addedFolders ?? importPlan.folders.length)])}</p>
              {importPlan.skippedDuplicates > 0 && (
                <p>{tr("将跳过 {0} 条重复网址。", [formatNumber(importPlan.skippedDuplicates)])}</p>
              )}
              {importPlan.invalid?.length > 0 && (
                <p className="form-error">{tr("已跳过 {0} 项无效地址。", [formatNumber(importPlan.invalid.length)])}</p>
              )}
              <div className="import-preview">
                {importPlan.folders.map((folder, i) => (
                  <p key={`f${i}`}><Folder size={16} />{folder.originalPath || folder.name} → {folder.name}</p>
                ))}
                {importPlan.sites.slice(0, 30).map((site, i) => (
                  <p key={i}>{site.name}<small>{site.folder || tr("桌面")} · {site.url}</small></p>
                ))}
              </div>
              <div className="modal-footer">
                <button className="button" onClick={() => setModal(null)}>{tr("取消")}</button>
                <button className="button primary" onClick={async () => {
                  try {
                    const saved = await commit(applyBookmarkImport(state, importPlan), tr("书签已导入"), modal.revision);
                    if (saved) setModal(null);
                  } catch (e) { notify(e.message, "error"); }
                }}>{tr("确认导入")}</button>
              </div>
            </div>
          </Modal>
        )}
        {modal?.kind === "restore" && backupPlan && (
          <Modal title={tr("恢复完整备份")} onClose={() => setModal(null)}>
            <div className="form-stack">
              <p>{tr("备份包含 {0} 个网站和 {1} 个自定义图片。", [formatNumber(backupPlan.summary.sites), formatNumber(backupPlan.summary.assets)])}</p>
              <p>{tr("恢复会替换当前网址、搜索选项、外观和布局，并保留上一份本地快照。 开启浏览器同步时，恢复结果也会参与同步。")}</p>
              {backupPlan.state.settings.background.kind === "image" && (
                <p className="hint">{tr("旧备份中的壁纸已完成校验，恢复时将改用 Bing 每日壁纸，不保存该壁纸图片；自定义图标会保留。")}</p>
              )}
              <div className="modal-footer">
                <button className="button" onClick={() => setModal(null)}>{tr("取消")}</button>
                <button
                  className="button primary"
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const result = await restoreBackup(
                        backupPlan,
                        modal.revision,
                      );
                      setState(result);
                      setFolder(null);
                      setModal(null);
                      notify(tr("完整备份已恢复"));
                    } catch (e) {
                      notify(e.message, "error");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >{tr("替换并恢复")}</button>
              </div>
            </div>
          </Modal>
        )}
        {settings.background.kind === "bing" && wallpaper?.source === "bing" && wallpaper.copyright && (
          <a className="wallpaper-credit" href={wallpaper.copyrightUrl} target="_blank" rel="noopener noreferrer" title={wallpaper.title}>
            {wallpaper.copyright}{wallpaper.stale ? tr(" · 缓存壁纸") : ""}
          </a>
        )}
      </main>
      </AdaptIcons.Provider>
    </DialogError.Provider>
  );
}

function Settings({
  state,
  onClose,
  readPreferences,
  writePreferences,
  onExport,
  onImport,
  onBookmarks,
  onSnapshot,
  wallpaper,
  providerIconEpoch,
  onProviderIconReady,
  onRestoreConflict,
}) {
  const [tab, setTab] = useState("appearance"),
    [draft, setDraft] = useState(structuredClone(state.settings)),
    [providers, setProviderDraft] = useState(structuredClone(state.providers)),
    [newName, setNewName] = useState(""),
    [editingProvider, setEditingProvider] = useState(null),
    [newTemplate, setNewTemplate] = useState(""),
    [error, setError] = useState("");
  const [syncStatus, setSyncStatus] = useState({ enabled: false, phase: demo ? "preview" : "disabled", message: demo ? tr("演示模式不连接浏览器同步。") : tr("浏览器同步尚未开启。") });
  const [syncBusy, setSyncBusy] = useState(false), [conflicts, setConflicts] = useState([]);
  const [saving, setSaving] = useState({ phase: "idle" });
  const panelRef = useRef(null);
  useLayoutEffect(() => { if (panelRef.current) panelRef.current.scrollTop = 0; }, [tab]);
  const visualStatus = useVisualRuntimeStatus();
  const settingsMounted = useRef(false), saveCallbacks = useRef(null);
  saveCallbacks.current = { readPreferences, writePreferences };
  const [saver] = useState(() => createPreferenceSaver({ initial: state,
    read: () => saveCallbacks.current.readPreferences(),
    write: (next, revision) => saveCallbacks.current.writePreferences(next, revision),
    onStatus: (status) => { if (settingsMounted.current) setSaving(status); },
  }));
  useEffect(() => {
    settingsMounted.current = true;
    return () => { settingsMounted.current = false; saver.flush().catch(() => {}); };
  }, []);
  function setProviders(value) {
    const next = typeof value === "function" ? value(providers) : value;
    setProviderDraft(next);
    saver.queue({ providers: next });
  }
  async function afterSave(action) {
    try { const latest = await saver.flush(); await action(latest); } catch { /* The save error stays visible. */ }
  }
  function closeSettings() { afterSave(onClose); }
  function addProvider() {
    try {
      if (!newName.trim()) throw Error(tr("请填写引擎名称"));
      const template = validateProviderTemplate(newTemplate);
      const value = { id: editingProvider ?? uid(), name: newName.trim(), template };
      // Saving an engine never prompts for a site's reading permission.
      const iconRequest = fetchProviderIconForSave(template);
      setProviders((current) => editingProvider
        ? current.map((item) => item.id === editingProvider ? value : item)
        : [...current, value]);
      setEditingProvider(null);
      setNewName("");
      setNewTemplate("");
      setError("");
      Promise.resolve(iconRequest).then(() => {
        onProviderIconReady();
      }).catch(() => {});
    } catch (err) { setError(err.message); }
  }
  function providerInputKeyDown(event) {
    if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    addProvider();
  }
  useEffect(() => {
    if (demo) return;
    let active = true;
    const update = async (status) => {
      if (!active) return;
      setSyncStatus(status);
      try {
        const list = await getSyncConflicts();
        if (active) setConflicts(list);
      } catch (err) { if (active) setError(err.message); }
    };
    Promise.resolve().then(getSyncStatus).then(update).catch((err) => { if (active) setError(err.message); });
    const off = subscribeSyncStatus(update);
    return () => { active = false; off(); };
  }, []);
  async function changeSync(action) {
    setSyncBusy(true);
    setError("");
    try {
      await action();
      setSyncStatus(await getSyncStatus());
      setConflicts(await getSyncConflicts());
    } catch (err) { setError(err.message); }
    finally { setSyncBusy(false); }
  }
  const patch = (value) => { setDraft((d) => ({ ...d, ...value })); saver.queue({ settings: value }); };
  const tabs = [["appearance", tr("外观")], ["layout", tr("布局")], ["search", tr("搜索")], ["enhancements", tr("增强")], ["data", tr("数据")]];
  return (
    <Modal title={tr("设置")} onClose={closeSettings} className="settings-modal preferences-modal" wide>
      <div className="settings-layout">
      <div className="settings-tabs" role="tablist" aria-label={tr("设置分类")} aria-orientation="vertical">
        {tabs.map(([id, name], index) => (
          <button
            role="tab"
            type="button"
            id={`settings-tab-${id}`}
            aria-controls="settings-panel"
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            key={id}
            onClick={() => { setTab(id); setError(""); }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + tabs.length) % tabs.length;
              setTab(tabs[next][0]); setError("");
              document.getElementById(`settings-tab-${tabs[next][0]}`)?.focus();
            }}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="settings-content">
      <div ref={panelRef} className="form-stack settings-scroll" role="tabpanel" id="settings-panel" aria-labelledby={`settings-tab-${tab}`} tabIndex={0}>
        {tab === "appearance" && (
          <>
            <LanguageSettings />
            <Select label={tr("主题")} value={draft.theme} onChange={(theme) => patch({ theme })}
              options={[{ value: "system", label: tr("跟随系统") }, { value: "light", label: tr("浅色") }, { value: "dark", label: tr("深色") }]} />
            <BackgroundPicker value={draft.background} onChange={(background) => patch({ background })} wallpaper={wallpaper} />
            <Range
              label={tr("背景遮罩")}
              value={draft.shade}
              min={0}
              max={90}
              suffix="%"
              onChange={(shade) => patch({ shade })}
            />
            <Range
              label={tr("背景模糊")}
              value={draft.blur}
              min={0}
              max={40}
              suffix="px"
              onChange={(blur) => patch({ blur })}
            />
          </>
        )}
        {tab === "enhancements" && (
          <div className="visual-enhancements">
            <section className="enhancement-row" aria-labelledby="visual-enhancement-heading">
              <label className="check-label enhancement-toggle">
                <span><strong id="visual-enhancement-heading">{tr("视觉增强")}</strong><span className="enhancement-description">{tr("自动适配文字颜色、图标和组件背景。")}</span></span>
                <input type="checkbox" role="switch" aria-label={tr("视觉增强")} checked={draft.visualEnhancement} onChange={(e) => patch({ visualEnhancement: e.target.checked })} />
              </label>
            </section>
            {draft.visualEnhancement && visualStatus.phase === "fallback" && <p className="hint" role="status">{tr(visualStatus.message)}</p>}
          </div>
        )}
        {tab === "layout" && (
          <>
            <Range
              label={tr("每行图标数量")}
              value={draft.columns}
              min={2}
              max={12}
              step={1}
              suffix={tr("个")}
              onChange={(columns) => patch({ columns })}
            />
            <Range
              label={tr("内容最大宽度")}
              value={draft.width}
              min={480}
              max={1600}
              step={20}
              suffix="px"
              onChange={(width) => patch({ width })}
            />
            <Range
              label={tr("图标大小")}
              value={draft.iconSize}
              min={48}
              max={144}
              step={4}
              suffix="px"
              onChange={(iconSize) => patch({ iconSize })}
            />
            <Range
              label={tr("图标间距")}
              value={draft.gap}
              min={8}
              max={64}
              step={4}
              suffix="px"
              onChange={(gap) => patch({ gap })}
            />
            <label className="check-label">
              <input
                type="checkbox"
                checked={draft.showLabels}
                onChange={(e) => patch({ showLabels: e.target.checked })}
              />{tr("显示网站名称")}</label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={draft.openNewTab}
                onChange={(e) => patch({ openNewTab: e.target.checked })}
              />{tr("在新标签页打开网站和搜索结果")}</label>
          </>
        )}
        {tab === "search" && (
          <>
            <p className="hint">{tr("新标签页默认使用浏览器搜索引擎。")}</p>
            <div className="provider-list">
              <div>
                <MagnifyingGlass className="provider-symbol" size={22} weight="light" aria-hidden="true" />
                <strong>{tr("浏览器默认搜索")}</strong>
                <span>{tr("默认")}</span>
              </div>
              {providers.map((p, index) => (
                <div key={p.id}>
                  <SearchProviderIcon provider={p} epoch={providerIconEpoch} />
                  <span className="provider-details">
                    {providerName(p)}
                    <small>{p.template}</small>
                  </span>
                  <button
                    className="icon-button"
                    type="button"
                    aria-label={tr("上移{0}", [providerName(p)])}
                    disabled={index === 0}
                    onClick={() => {
                      if (index === 0) return;
                      const value = [...providers];
                      [value[index - 1], value[index]] = [
                        value[index],
                        value[index - 1],
                      ];
                      setProviders(value);
                    }}
                  >
                    <ArrowUp size={18} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={tr("编辑{0}", [providerName(p)])}
                    onClick={() => {
                      setEditingProvider(p.id);
                      setNewName(p.name);
                      setNewTemplate(p.template);
                    }}
                  >
                    <PencilSimple size={18} />
                  </button>
                  <button
                    className="icon-button danger"
                    type="button"
                    aria-label={tr("删除{0}", [providerName(p)])}
                    onClick={() => {
                      setProviders(providers.filter((v) => v.id !== p.id));
                      if (editingProvider === p.id) { setEditingProvider(null); setNewName(""); setNewTemplate(""); }
                    }}
                  >
                    <Trash size={18} />
                  </button>
                </div>
              ))}
            </div>
            <label>{tr("引擎名称")}<input
                value={newName}
                maxLength={80}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={providerInputKeyDown}
                placeholder={tr("例如：站点搜索")}
              />
            </label>
            <label>{tr("搜索地址模板")}<input
                value={newTemplate}
                onChange={(e) => setNewTemplate(e.target.value)}
                onKeyDown={providerInputKeyDown}
                placeholder={tr("搜索地址，使用 {query} 表示关键词")}
              />
            </label>
            <button
              type="button"
              className="button"
              onClick={addProvider}
            >
              {editingProvider ? tr("保存引擎") : tr("添加引擎")}
            </button>
            {editingProvider && <button type="button" className="button quiet" onClick={() => { setEditingProvider(null); setNewName(""); setNewTemplate(""); setError(""); }}>{tr("取消修改")}</button>}
          </>
        )}
        {tab === "data" && (
          <>
            <fieldset className="sync-settings">
              <legend>{tr("浏览器原生同步")}</legend>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={syncStatus.enabled}
                  disabled={syncBusy || syncStatus.phase === "preview"}
                  aria-label={tr("启用浏览器同步")}
                  onChange={(event) => { const enabled = event.target.checked; changeSync(() => setSyncEnabled(enabled)); }}
                />{tr("启用浏览器同步")}</label>
              {['error', 'conflict', 'blocked'].includes(syncStatus.phase) && <p className="form-error" id="sync-status" role="alert">{tr(syncStatus.message)}</p>}
              {syncStatus.enabled && (
                <button type="button" className="button" disabled={syncBusy} onClick={() => changeSync(() => syncNow())}>{tr("重新同步")}</button>
              )}
              {conflicts.length > 0 && (
                <div className="sync-conflicts">
                  <strong>{tr("保留的冲突版本")} · {formatNumber(conflicts.length)}</strong>
                  {conflicts.map((conflict) => (
                    <div key={conflict.id}>
                      <span>{conflict.name || conflict.key}{conflict.deleted ? tr("（删除记录）") : ""}</span>
                      <button type="button" className="button" disabled={syncBusy} onClick={() => changeSync(() => onRestoreConflict(conflict.id))}>{tr("恢复此版本")}</button>
                    </div>
                  ))}
                </div>
              )}
            </fieldset>
            <div className="data-actions">
              <button type="button" className="button" onClick={() => afterSave(onBookmarks)}>
                <UploadSimple size={19} />{tr("导入浏览器书签")}</button>
              <button type="button" className="button" onClick={() => afterSave(onExport)}>
                <DownloadSimple size={19} />{tr("导出完整备份")}</button>
              <button type="button" className="button" onClick={() => afterSave(onImport)}>
                <UploadSimple size={19} />{tr("恢复完整备份")}</button>
              <button type="button" className="button" onClick={() => afterSave(onSnapshot)}>
                <ArrowUUpLeft size={19} />{tr("恢复上一份本地快照")}</button>
            </div>
            <a className="settings-privacy-link" href="https://sites.google.com/view/covelet-privacy" target="_blank" rel="noopener noreferrer">{tr("隐私政策")}</a>
          </>
        )}
        {error && (
          <p className="form-error" role="alert">
            {tr(error)}
          </p>
        )}
      </div>
      {saving.phase === "error" && <div className="settings-save-status">
          <p className="form-error" role="alert">{tr(saving.error?.message) || tr("设置未保存，请重试。")}</p>
          <div className="settings-retry-actions">
            {saving.error?.code !== "PREFERENCE_CONFLICT" && <button type="button" className="button" onClick={() => saver.retry().catch(() => {})}>{tr("重试")}</button>}
            <button type="button" className="button quiet" onClick={async () => {
              try {
                const latest = await saver.reload();
                setDraft(structuredClone(latest.settings)); setProviderDraft(structuredClone(latest.providers));
              } catch (reason) { setError(reason.message); }
            }}>{tr("放弃修改并重新载入")}</button>
          </div>
      </div>}
      </div>
      </div>
    </Modal>
  );
}
function Range({ label, value, onChange, suffix = "", ...props }) {
  return (
    <label className="range-label">
      <span>
        {label}
        <output>
          {formatNumber(value)}
          {suffix && ` ${suffix}`}
        </output>
      </span>
      <input
        type="range"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        {...props}
      />
    </label>
  );
}

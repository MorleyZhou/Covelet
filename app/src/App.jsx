import { tr, getLocale, builtinName, providerName, formatNumber } from "./i18n/index.js";
import { useLanguage } from './i18n/react.js';
import LanguageSettings from './components/LanguageSettings.jsx';
import { createContext, useContext, useEffect, useLayoutEffect, useCallback, useMemo, useRef, useState } from "react";
import { Dialog as UIDialog, DialogContent, DialogTitle } from './components/ui/dialog.jsx';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './components/ui/tabs.jsx';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator } from './components/ui/dropdown-menu.jsx';
import './components/ui/ui.css';
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
  NotePencil,
  BookOpen,
  Eye,
  EyeSlash,
  LockSimple,
  CircleNotch,
} from "@phosphor-icons/react";
import {
  createEmptyState,
  createInitialState,
  normalizeUrl,
  validateProviderTemplate,
  moveEntry,
  deleteEntry,
  migrateNavigationState,
  parseBookmarks,
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
} from "./lib/storage.js";
import { submitWebSearch } from "./lib/search.js";
import { createWallpaperProvider } from "./lib/wallpaper.js";
import { useIconDrag } from "./lib/use-icon-drag.js";
import { canReadSite, supportsSiteInfo } from "./lib/site-info.js";
import { recognizeSite } from "./lib/site-recognition.js";
import Select from "./components/Select.jsx";
import ContextMenu from "./components/ContextMenu.jsx";
import IconBackground from "./components/IconBackground.jsx";
import BackgroundPicker from "./components/BackgroundPicker.jsx";
import FolderName from "./components/FolderName.jsx";
import ProviderIcon from "./components/ProviderIcon.jsx";
import { readCachedProviderIcon, fetchProviderIconForSave } from "./lib/provider-icons.js";
import { fallbackSiteName, applyRecognizedSite, iconTextColor } from "./lib/site-form.js";
import { useWallpaperAppearance, useAdaptedIcon } from "./lib/use-visual-enhancements.js";
import { createAdaptiveAppearance } from "./lib/adaptive-appearance.js";
import { useNavigationContrast } from "./lib/use-navigation-contrast.js";
import { VISUAL_SHADE_BACKGROUND } from "./lib/navigation-contrast.js";
import { colorBackgroundCss } from "./lib/background-colors.js";
import { startCloudSync } from "./lib/cloud-sync.js";
import ExtensionCenter from "./components/ExtensionCenter.jsx";
import CloudSyncSettings from './components/CloudSyncSettings.jsx';
import PrivacyCheckup from './components/PrivacyCheckup.jsx';
import GitHubWidget from "./components/GitHubWidget.jsx";
import DesktopPages from "./components/DesktopPages.jsx";
import { layoutDesktop } from "./lib/desktop-layout.js";
import { applyDesktopDrop, deleteDesktopEntries } from "./lib/desktop-edit.js";
import { useLayoutEdit } from "./lib/use-layout-edit.js";
import { DesktopEditBar, DesktopScreenManager } from "./components/DesktopEditControls.jsx";
import { createPreferenceSaver } from "./lib/preference-saving.js";
import { preferredIconAddress, normalizeIconAddress, siteIconAddress, guessIconFit, withDiscoveredIcon, navigationIconDisplaySources } from "./lib/site-icons.js";
import { useIconScheme } from './lib/use-icon-scheme.js';
import { useNavigationIcon } from './lib/use-navigation-icon.js';
import { useSyncedDataRevision, subscribeSyncedData } from './lib/use-synced-data.js';
import { prepareSavedNavigationIcon, retainNavigationIconResources, navigationIcon, getNavigationIconFailure } from './lib/navigation-icon-cache.js';
import { prepareNavigationIconCache } from './lib/navigation-icon-startup.js';
import { prepareImportedNavigationIcons, requestNavigationIconAccess } from './lib/navigation-icon-intake.js';
import { iconFailureMessage } from './lib/icon-feedback.js';
import NavigationIconStatus from './components/NavigationIconStatus.jsx';
import IconArtwork from './components/IconArtwork.jsx';
import ClockWidget from "./components/ClockWidget.jsx";
import PersonalWidget, { PersonalToolsDialog, PersonalToolsTrashDialog } from "./components/PersonalTools.jsx";
import usePersonalTools from './lib/use-personal-tools.js';
import { searchCoveletContent } from './lib/content-search.js';
import { loadContentPreferences, useContentPreferences, saveContentSettings, setPresentationMode } from './lib/content-preferences.js';
import { PresentationContext, privateContentKeys } from './lib/presentation.js';
import ContentPreferences from './components/ContentPreferences.jsx';
import PrivacyPasswordDialog, { PrivacyPasswordForm } from './components/PrivacyPassword.jsx';
import BookmarkImport from './components/BookmarkImport.jsx';
import DesktopTemplates from './components/DesktopTemplates.jsx';
import RecoveryCenter, { downloadRecoveryFile } from './components/RecoveryCenter.jsx';
import { recoveryCenter } from './lib/recovery-center.js';
import { focusDesktopNeighbor } from "./lib/desktop-focus.js";
import { CLOCK_WIDGET_ID, GITHUB_WIDGET_ID } from "./lib/widget-model.js";
import { removeClockState } from "./lib/clock-runtime.js";
import "./owntab.css";
import { DialogSurface } from './components/DialogSurface.jsx';
import { MessageDialog } from './components/PromptDialog.jsx';
import { Button } from './components/ui/button.jsx';
import { Input } from './components/ui/input.jsx';
import { Switch } from './components/ui/switch.jsx';
import { Slider } from './components/ui/slider.jsx';

const uid = () => crypto.randomUUID();
const DialogError = createContext("");
const AdaptIcons = createContext(false);
const demo =
  import.meta.env.DEV && new URLSearchParams(location.search).has("demo");
const dailyWallpaper = createWallpaperProvider();
subscribeSyncedData(() => dailyWallpaper.invalidate());

function SearchProviderIcon({ provider, epoch, fallback = "globe" }) {
  const syncRevision = useSyncedDataRevision();
  const [cached, setCached] = useState(null);
  const template = provider?.template;
  useEffect(() => {
    let active = true, url;
    setCached(null);
    if (template) readCachedProviderIcon(template).then((blob) => {
      if (!active || !blob) return;
      url = URL.createObjectURL(blob);
      setCached({ template, syncRevision, url });
    }).catch(() => {});
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [template, epoch, syncRevision]);
  return <ProviderIcon key={template} provider={provider} src={cached?.template === template && cached.syncRevision === syncRevision ? cached.url : undefined} fallback={fallback} />;
}

function WidgetTile({ item, editing, className, children, presentationHidden = false, ...props }) {
  const { requestUnlock } = useContext(PresentationContext);
  return <div {...props} className={`${className} widget-tile widget-size-${item.config.size} ${presentationHidden ? 'presentation-private-widget' : ''}`}>
    <div key="live" className="widget-live-content" style={presentationHidden ? { display: 'none' } : undefined} aria-hidden={presentationHidden || undefined} inert={editing || presentationHidden || undefined}>{children}</div>
    {presentationHidden && <Button key="shield" variant="unstyled" size="unstyled" type="button" className="presentation-widget-lock" data-widget-launcher onClick={requestUnlock} aria-haspopup="dialog" aria-label={tr('输入密码查看隐藏内容')} title={tr('输入密码查看隐藏内容')}>
      <span className="presentation-private-icon" aria-hidden="true"><LockSimple size={26} /></span>
    </Button>}
    {(presentationHidden || item.config.size === 'mini' || !(['notes', 'read-later'].includes(item.extensionId))) && <span className="site-name widget-caption">{presentationHidden ? tr('已隐藏') : builtinName(item.extensionId, item.name)}</span>}
  </div>;
}


function useAsset(id) {
  const syncRevision = useSyncedDataRevision();
  const [asset, setAsset] = useState({ id: null, url: "", phase: 'missing' });
  useEffect(() => {
    let cancelled = false,
      objectUrl;
    setAsset({ id, url: "", phase: id ? 'loading' : 'missing' });
    if (id)
      getAssetUrl(id)
        .then((value) => {
          objectUrl = value;
          if (!cancelled) setAsset({ id, url: value, phase: 'ready' });
          else URL.revokeObjectURL(value);
        })
        .catch(() => { if (!cancelled) setAsset({ id, url: '', phase: 'missing' }); });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, syncRevision]);
  return asset.id === id ? asset : { id, url: '', phase: id ? 'loading' : 'missing' };
}

function useDailyWallpaper(enabled) {
  const syncRevision = useSyncedDataRevision();
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
        const unchanged = currentResult && next.source === currentResult.source && (next.source === 'bing'
          ? next.date === currentResult.date && next.imageUrl === currentResult.imageUrl
          : next.url === currentResult.url);
        if (unchanged) {
          // Returning to a tab often reads the same day's cached image. Keep
          // its live URL so the existing palette/sample remains valid.
          if (next.url !== currentResult.url) dailyWallpaper.dispose(next);
          currentResult = { ...next, url: currentResult.url };
          setResult(currentResult);
          return;
        }
        if (currentResult) dailyWallpaper.dispose(currentResult);
        currentResult = next;
        setResult(next);
      } catch {
        if (active) setResult(currentResult || { source: "builtin", message: tr("每日壁纸暂不可用，正在显示内置背景。") });
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
  }, [enabled, syncRevision]);
  return result;
}
function SiteIcon({ entry, small = false, children = [], initialAppearance }) {
  const [failedImage, setFailedImage] = useState({ source: "", urls: [] });
  const [surfaceRef, automaticScheme] = useIconScheme(initialAppearance?.scheme);
  const visualEnabled = useContext(AdaptIcons);
  const localAsset = useAsset(
    entry.icon?.kind === "image" ? entry.icon.value : null,
  );
  const variants = entry.icon?.kind === 'image' ? null : entry.iconVariants;
  const paired = Boolean(variants?.light && variants?.dark);
  const scheme = entry.iconBackground ? iconTextColor(entry.iconBackground) === '#fff' ? 'dark' : 'light' : automaticScheme;
  const variant = visualEnabled && paired ? variants[scheme] : null;
  const displaySources = navigationIconDisplaySources(entry, scheme, visualEnabled);
  const address = localAsset.phase === 'missing' ? displaySources.explicitFallback || displaySources.primary : displaySources.primary;
  const source = JSON.stringify([entry.id, entry.url, entry.icon, entry.iconUrl, entry.iconVariants]);
  const failedUrls = failedImage.source === source ? failedImage.urls : [];
  const cachedImage = useNavigationIcon(address, visualEnabled ? scheme : 'light', surfaceRef, 0, displaySources.fallback);
  const localImage = localAsset.url;
  const image = [localImage, cachedImage?.url].find((url) => url && !failedUrls.includes(url)) || '';
  const usingVariant = Boolean(variant && cachedImage.source === variant.url);
  const themedArtwork = Boolean((usingVariant || cachedImage?.adaptive) && cachedImage?.url === image);
  const adapted = useAdaptedIcon(image, visualEnabled && entry.type === "site" && image.startsWith('blob:'));
  const visualPending = visualEnabled && entry.type === 'site' && image.startsWith('blob:') && adapted.phase === 'processing';
  const presentation = adapted.phase === 'ready' || !initialAppearance ? adapted : { ...initialAppearance, ...adapted };
  const fullBleed = presentation.fullBleed || (usingVariant ? variant.fit : entry.iconFit) === 'cover' && !cachedImage?.vector;
  const renderedImage = fullBleed ? image : adapted.url && !failedUrls.includes(adapted.url) ? adapted.url : image;
  const background = entry.iconBackground || presentation.background || (themedArtwork && scheme === 'dark' ? '#242426' : DEFAULT_ICON_BACKGROUND);
  const hasImage = renderedImage && !failedUrls.includes(renderedImage) && !visualPending;
  const imagePending = visualPending || localAsset.phase === 'loading' || cachedImage.phase === 'loading';
  // Adapt the surrounding surface only. Never recolor an actual site image.
  // Full app artwork keeps its own edge color so it does not acquire a second
  // circular/rounded frame when the wallpaper changes.
  const autoSurface = visualEnabled && !small && !entry.iconBackground && (!(hasImage && fullBleed) || themedArtwork);
  const surfaceTone = hasImage ? themedArtwork ? 'themed' : presentation.surfaceTone || presentation.monochrome || 'mixed' : 'text';
  const surfaceProps = autoSurface ? { 'data-icon-surface': surfaceTone,
    ...(!themedArtwork && presentation.ink ? { 'data-icon-ink': JSON.stringify(presentation.ink) } : {}) } : {};
  const style = { ...(autoSurface && initialAppearance ? { '--navigation-icon-background': initialAppearance.background,
    '--navigation-icon-ink': initialAppearance.foreground } : {}),
    colorScheme: scheme, backgroundColor: autoSurface ? `var(--navigation-icon-background, ${background})` : background,
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
        <IconArtwork src={hasImage ? renderedImage : ''} identity={image} pending={imagePending} scheme={themedArtwork ? scheme : 'light'} className={fullBleed ? 'full-bleed-icon' : adapted.adapted && renderedImage === adapted.url ? "adapted-icon" : undefined}
          onError={(url) => setFailedImage((current) => ({ source,
            urls: [...(current.source === source ? current.urls : []), url].slice(-8) }))} />
      {!hasImage && !imagePending ? (
        <span className="letter-icon">
          {letterIcon(entry.name).value}
        </span>
      ) : null}
    </span>
  );
}
function DragArtwork({ entry, entries, snapshot, compact = false, hidden = false }) {
  const holder = useRef(null);
  const widgetSnapshot = entry.type === 'widget' && (!hidden || snapshot?.hidden) ? snapshot : null;
  const scale = widgetSnapshot && compact ? Math.min(1, 64 / Math.max(widgetSnapshot.width, widgetSnapshot.height)) : 1;
  useLayoutEffect(() => {
    if (!widgetSnapshot || !holder.current) return;
    widgetSnapshot.node.style.transform = `scale(${scale})`;
    holder.current.replaceChildren(widgetSnapshot.node);
    widgetSnapshot.restoreScroll();
    return () => { widgetSnapshot.node.remove(); };
  }, [widgetSnapshot, scale]);
  const shield = <span className="site-icon presentation-private-icon"><LockSimple size={26} /></span>;
  return entry.type === 'widget' ? widgetSnapshot ? <span className="drag-widget-snapshot" ref={holder} aria-hidden="true" style={{ width: widgetSnapshot.width * scale, height: widgetSnapshot.height * scale }} /> : hidden ? shield : null
    : hidden ? shield
    : <SiteIcon entry={entry} initialAppearance={snapshot} children={entries.filter((child) => child.parentId === entry.id).sort((a, b) => a.order - b.order)} />;
}

function Modal({ title, titleContent, onClose, onBack, backLabel = tr("返回"), closeDisabled = false, children, wide = false, maximizable = false, className = "", privacyKeys = [] }) {
  const ref = useRef(null);
  const presentation = useContext(PresentationContext), shielded = presentation.active && privacyKeys.some((key) => presentation.hiddenKeys.has(key));
  const [maximized, setMaximized] = useState(false), [surface, setSurface] = useState(null);
  const [contentSurface, setContentSurface] = useState(null);
  const setDialogRef = useCallback((node) => { ref.current = node; setSurface(node); }, []);
  const previousTitle = useRef(null);
  const opener = useRef(document.activeElement);
  const dialogError = useContext(DialogError);
  function focusContent() {
    if (!ref.current || ref.current.querySelector('[role=alertdialog]')) return;
    const selector = previousTitle.current ? ".modal-title h2" : titleContent ? ".modal-title > .icon-button" : "input:not([type=file]):not([type=hidden]):not([aria-hidden=true]),[role=combobox],textarea,[role=tab][aria-selected=true]";
    const target = ref.current.querySelector('[data-autofocus]') || ref.current.querySelector(selector) || ref.current.querySelector('button:not(:disabled)') || ref.current;
    target.focus({ preventScroll: true });
    previousTitle.current = title;
  }
  useEffect(() => { if (previousTitle.current && previousTitle.current !== title) focusContent(); }, [title]);
  const closeButton = <Button variant="unstyled" size="unstyled" type="button" className="icon-button" disabled={closeDisabled} onClick={onClose} aria-label={tr("关闭")}><X size={22} /></Button>;
  return (
    <UIDialog open onOpenChange={(open) => { if (!open && !closeDisabled) onClose(); }}>
    <DialogContent
      ref={setDialogRef}
      container={document.querySelector('.owntab') || document.body}
      aria-label={shielded ? tr('内容已隐藏') : title}
      aria-describedby={undefined}
      className={`modal ${wide ? "wide" : ""} ${className} ${maximized ? 'is-maximized' : ''}`}
      data-maximized={maximized || undefined}
      onOpenAutoFocus={(event) => { event.preventDefault(); focusContent(); }}
      onCloseAutoFocus={(event) => { event.preventDefault(); if (opener.current?.isConnected && !opener.current.matches(':disabled')) opener.current.focus({ preventScroll: true }); }}
      onEscapeKeyDown={(event) => { if (closeDisabled) event.preventDefault(); }}
      onInteractOutside={(event) => { if (closeDisabled) event.preventDefault(); }}
      onKeyDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <div className={`modal-title ${titleContent ? "folder-title" : ""}`}>
        {onBack && <Button variant="unstyled" size="unstyled" type="button" className="icon-button" disabled={closeDisabled} onClick={onBack} aria-label={backLabel}><ArrowLeft size={22} /></Button>}
        {titleContent && closeButton}
        {shielded ? <DialogTitle asChild><h2>{tr('内容已隐藏')}</h2></DialogTitle> : titleContent ? <DialogTitle className="visually-hidden">{title}</DialogTitle> : <DialogTitle asChild><h2 tabIndex={-1}>{title}</h2></DialogTitle>}
        {titleContent && <div style={{ display: shielded ? 'none' : 'contents' }} inert={shielded || undefined} aria-hidden={shielded || undefined}>{titleContent}</div>}
        {!shielded && maximizable && <Button variant="unstyled" size="unstyled" type="button" className="icon-button modal-maximize" aria-pressed={maximized}
          aria-label={maximized ? tr('还原窗口') : tr('最大化')} title={maximized ? tr('还原窗口') : tr('最大化')}
          onClick={() => setMaximized((value) => !value)}>{maximized ? <CornersIn size={20} /> : <CornersOut size={20} />}</Button>}
        {!titleContent && closeButton}
      </div>
      <DialogSurface.Provider value={contentSurface}>
        {shielded && <div className="presentation-dialog-shield"><p className="hint">{tr('此内容已隐藏，解锁后可继续编辑，未保存的修改会保留。')}</p>
          <PrivacyPasswordForm purpose="unlock" disabled={closeDisabled} Heading="h3" /></div>}
        <div ref={setContentSurface} className="modal-preserved-content" style={{ display: shielded ? 'none' : 'contents' }} inert={shielded || undefined} aria-hidden={shielded || undefined}>
          <MessageDialog message={dialogError} />{children}
        </div>
      </DialogSurface.Provider>
    </DialogContent>
    </UIDialog>
  );
}

export function App() {
  useLanguage();
  const { data: personalData, error: personalDataError } = usePersonalTools({ loadCore: false });
  const { data: contentPreferences, error: contentPreferencesError, ready: contentPreferencesReady } = useContentPreferences();
  const [privacyBusy, setPrivacyBusy] = useState(false);
  const [privacyDialog, setPrivacyDialog] = useState(null);
  const privacyOperation = useRef(false);
  const [presentationHint, setPresentationHint] = useState('');
  const engineChoice = useRef(false);
  const composingSearch = useRef(false);
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
  const [entryIconInfo, setEntryIconInfo] = useState({ phase: 'idle' }), [iconPreview, setIconPreview] = useState(null);
  const iconOperation = useRef(null);
  const entryIconPending = ['permission', 'loading'].includes(entryIconInfo.phase);
  const [entrySaving, setEntrySaving] = useState(false), entrySavePending = useRef(false);
  const siteInfoPending = ["loading", "permission"].includes(siteInfo.phase);
  const [iconProgress, setIconProgress] = useState(null);
  useEffect(() => { setIconProgress(null); }, [modal?.kind]);
  const preferenceState = useRef(state);
  preferenceState.current = state;
  const [activeScreen, setActiveScreen] = useState('0:0'), [draftPage, setDraftPage] = useState(null);
  const desktopScreen = useRef({ key: '0:0', page: 0, columns: 8, items: [] });
  const [screenManager, setScreenManager] = useState(false);
  const layoutPress = useRef(null), layoutLongClick = useRef(false);
  const mainRef = useRef(null), wallpaperRef = useRef(null);
  const [providerIconEpoch, setProviderIconEpoch] = useState(0);
  const siteRequest = useRef(0), manualFields = useRef({ name: false }), originalSiteOrigin = useRef(null);
  useEffect(() => { if (entry && !manualFields.current.icon) setIconPreview(entry); }, [entry]);
  const siteAccess = useRef({ origin: '', granted: false });
  const inputRef = useRef(null),
    suggestionsRef = useRef(null),
    bookmarkInput = useRef(null),
    backupInput = useRef(null);
  useEffect(() => {
    siteAccess.current = { origin: '', granted: false };
    if (modal?.kind !== 'entry' || entry?.type !== 'site' || !entry.url || !supportsSiteInfo()) return;
    let origin;
    try { origin = new URL(normalizeUrl(entry.url)).origin; } catch { return; }
    let active = true, check = 0;
    const refresh = () => {
      const version = ++check;
      siteAccess.current = { origin, granted: false };
      canReadSite(origin).then((granted) => {
        if (active && check === version) siteAccess.current = { origin, granted };
      }).catch(() => { /* An unknown grant is checked by Chrome on the explicit click. */ });
    };
    const permissions = globalThis.chrome.permissions;
    refresh();
    permissions.onAdded?.addListener(refresh);
    permissions.onRemoved?.addListener(refresh);
    return () => {
      active = false;
      permissions.onAdded?.removeListener(refresh);
      permissions.onRemoved?.removeListener(refresh);
    };
  }, [modal?.kind, entry?.id, entry?.url]);
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
  const presentation = contentPreferences.presentation;
  const hiddenKeys = useMemo(() => privateContentKeys(state, contentPreferences), [state, contentPreferences]);
  const privacyKey = presentation ? `hidden:${[...hiddenKeys].sort().join('\n')}` : 'public';
  const requestPrivacyUnlock = useCallback(() => setPrivacyDialog('unlock'), []);
  const presentationContext = useMemo(() => ({ active: presentation, hiddenKeys, requestUnlock: requestPrivacyUnlock }), [presentation, hiddenKeys, requestPrivacyUnlock]);
  const privateEntryIds = useMemo(() => (state?.entries || []).filter((item) => hiddenKeys.has(`${item.type}:${item.id}`)).map((item) => item.id), [state, hiddenKeys]);
  useEffect(() => {
    setPresentationHint('');
    stopLayoutPress(); cancelDrag();
    if (!presentation) { setPrivacyDialog((value) => value === 'unlock' ? null : value); return; }
    setContext((current) => current?.item && hiddenKeys.has(`${current.item.type}:${current.item.id}`) ? null : current);
    layoutEditor.setSelectedIds((ids) => ids.filter((id) => !privateEntryIds.includes(id)));
  }, [presentation, privacyKey]);
  async function togglePresentation() {
    if (privacyOperation.current) return;
    if (presentation) { requestPrivacyUnlock(); return; }
    privacyOperation.current = true; setPrivacyBusy(true); setPresentationHint('');
    try { await setPresentationMode(true); }
    catch (reason) {
      if (reason.code === 'PRIVACY_SETUP_REQUIRED') setPrivacyDialog('setup');
      else setPresentationHint(reason.message || tr('无法切换隐藏状态，请重试。'));
    } finally { privacyOperation.current = false; setPrivacyBusy(false); }
  }
  useEffect(() => {
    if (['clock', 'personal-tool'].includes(modal?.kind) && state && !state.entries.some((item) => item.id === modal.id && item.type === 'widget' && !item.detached)) setModal(null);
  }, [state, modal?.kind, modal?.id]);
  useEffect(() => {
    const alert = (event) => { if (event.detail?.title) notify(`${event.detail.title}${event.detail.message ? ` · ${event.detail.message}` : ''}`); };
    window.addEventListener('covelet-clock-alert', alert);
    return () => window.removeEventListener('covelet-clock-alert', alert);
  }, []);
  useEffect(() => {
    let mounted = true, initial = true;
    (demo ? Promise.resolve(createInitialState()) : loadState())
      .then(async (value) => {
        if (!mounted || !initial) return;
        await prepareNavigationIconCache(value);
        if (mounted && initial) {
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
          initial = false;
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
  const candidates = useMemo(() => state && query.trim()
    ? searchCoveletContent(state, personalData, query, { aliases: contentPreferences.aliases, hiddenKeys: presentation ? hiddenKeys : [], limit: 24 }) : [],
  [state, personalData, query, contentPreferences, presentation, hiddenKeys]);
  useEffect(() => { setCandidate((value) => Math.min(value, candidates.length - 1)); }, [candidates.length]);
  useLayoutEffect(() => {
    const list = suggestionsRef.current, option = list?.children[candidate];
    if (!focused || !option) return;
    // Keep keyboard selection visible without scrolling the desktop behind it.
    const bounds = list.getBoundingClientRect(), selected = option.getBoundingClientRect();
    if (selected.top < bounds.top + 8) list.scrollTop += selected.top - bounds.top - 8;
    else if (selected.bottom > bounds.bottom - 8) list.scrollTop += selected.bottom - bounds.bottom + 8;
  }, [candidate, focused, query, state?.revision, personalData?.revision]);
  const currentFolder = state?.entries.find((item) => item.id === folderId);
  const selectedProvider = state?.providers.find((item) => item.id === provider);
  const items =
    desktopState?.entries
      .filter((item) => item.parentId === null && !item.detached)
      .sort((a, b) => a.order - b.order) ?? [];
  const { drag, tileProps, cancelDrag } = useIconDrag({ state: desktopState, page: Number(activeScreen.split(':')[0]), screenKey: activeScreen,
    editing: layoutEditor.editing, selectedIds: layoutEditor.selectedIds, onSelect: layoutEditor.setSelectedIds,
    hiddenIds: presentation ? privateEntryIds : [],
    privacyKey,
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
    const selected = desktopState.entries.filter((item) => ids.includes(item.id) && item.parentId === null && !item.detached && (!presentation || !hiddenKeys.has(`${item.type}:${item.id}`)));
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
  async function commitImportedNavigation(next, addedIds, expected, message) {
    const imported = { entries: next.entries.filter((item) => addedIds.has(item.id)) };
    const release = retainNavigationIconResources(imported);
    try {
      const icons = await prepareImportedNavigationIcons(imported, {
        onIconProgress: setIconProgress, isCurrent: () => preferenceState.current.revision === expected,
      });
      if (icons.cancelled) throw Error(tr('数据已更新，已停止本次图标补齐，请重试。'));
      const preferences = await loadContentPreferences();
      if (preferences.presentation && imported.entries.some((item) => item.parentId && preferences.privateKeys.includes(`folder:${item.parentId}`))) throw Error(tr('请先输入密码解除隐藏。'));
      const saved = await commit(next, message, expected);
      if (saved && icons.failed) notify(tr('部分图标无法读取，可在备份与恢复中心授权图片网站后重试，或编辑网址后重新获取。'), 'error');
      return saved;
    } finally { release(); }
  }
  function openClock(item) {
    if (presentation && hiddenKeys.has(`widget:${item.id}`)) { requestPrivacyUnlock(); return; }
    if (layoutEditor.editing || modal || drag) return;
    stopLayoutPress(); cancelDrag(); setContext(null); setEngineMenu(false); setQuery(''); setFocused(false);
    setModal({ kind: item.extensionId === CLOCK_WIDGET_ID ? 'clock' : item.extensionId === GITHUB_WIDGET_ID ? 'github-tool' : 'personal-tool', id: item.id });
  }
  function openEntry(item) {
    if (presentation && hiddenKeys.has(`${item.type}:${item.id}`)) { requestPrivacyUnlock(); return; }
    if (item.type === 'widget' && ([CLOCK_WIDGET_ID, GITHUB_WIDGET_ID, 'notes', 'read-later'].includes(item.extensionId))) {
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
  function openContent(item) {
    if (['site', 'folder'].includes(item.type)) { openEntry(item.entry); return; }
    if (presentation && hiddenKeys.has(`${item.type}:${item.id}`)) { requestPrivacyUnlock(); return; }
    setQuery(''); setFocused(false); setCandidate(-1); setFolder(null); setContext(null);
    setModal({ kind: 'personal-content', type: item.type, recordId: item.id });
  }
  async function saveFolderName(name, originalName) {
    if (presentation && hiddenKeys.has(`folder:${folderId}`)) throw Error(tr('请先输入密码解除隐藏。'));
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
    if (composingSearch.current || e.nativeEvent.isComposing) return;
    if (candidate >= 0 && candidates[candidate]) {
      openContent(candidates[candidate]);
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
    setIconPreview(null); setEntryIconInfo({ phase: 'idle' }); iconOperation.current?.abort();
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
    if (presentation && hiddenKeys.has(`${item.type}:${item.id}`)) { requestPrivacyUnlock(); return; }
    if (item.type === 'widget') {
      setContext(null); setError('');
      setModal({ kind: 'extensions', initialExtension: item.extensionId, editingId: item.id });
      return;
    }
    setEntry(structuredClone(item));
    setIconPreview(structuredClone(item)); setEntryIconInfo({ phase: 'idle' }); iconOperation.current?.abort();
    setModal({ kind: "entry", revision: state.revision, isNew: false });
    setContext(null);
    setError("");
    manualFields.current = { name: false };
    originalSiteOrigin.current = item.type === "site" ? new URL(item.url).origin : null;
    siteRequest.current++;
    setSiteInfo({ phase: "idle", message: "" });
  }
  function closeEntry() {
    if (entrySavePending.current) return;
    siteRequest.current++;
    iconOperation.current?.abort();
    setModal(null);
    setEntry(null);
  }
  async function useWidget(config, original, extensionId = original?.extensionId || GITHUB_WIDGET_ID, { close = true } = {}) {
    const latest = demo ? preferenceState.current : await loadState();
    const existing = latest.entries.find((item) => item.id === original?.id);
    if (original && (!existing || Boolean(existing.detached) !== Boolean(original.detached) || JSON.stringify(existing.config) !== JSON.stringify(original.config))) throw new Error(tr("组件已在其他页面修改或移除，请重新打开扩展。"));
    if (!original && latest.entries.some((item) => item.type === 'widget' && item.extensionId === extensionId)) throw new Error(tr("组件已在其他页面添加，请重新打开扩展。"));
    const next = configureWidget(latest, extensionId, config, original?.id, { page: desktopScreen.current.page });
    const saved = await commit(next, undefined, latest.revision);
    if (!saved) throw new Error(tr("组件未保存，请重试。"));
    if (close) setModal(null);
    const widget = saved.entries.find((item) => original ? item.id === original.id : item.type === 'widget' && item.extensionId === extensionId);
    revealDesktopEntry(saved, widget.id);
    setDraftPage(null);
    if (close) requestAnimationFrame(() => document.getElementById(`widget-title-${widget.id}`)?.focus({ preventScroll: true }));
  }
  async function detachWidget(original) {
    const latest = demo ? preferenceState.current : await loadState(), current = latest.entries.find((item) => item.id === original.id);
    if (!current || current.type !== 'widget' || JSON.stringify(current) !== JSON.stringify(original)) throw Error(tr('组件已在其他页面修改或移除，请重新打开扩展。'));
    if (presentation && hiddenKeys.has(`widget:${current.id}`)) { requestPrivacyUnlock(); return; }
    const entries = latest.entries.map((item) => { if (item.id !== current.id) return item; const next = { ...item, detached: true }; delete next.position; return next; });
    const saved = await commit({ ...latest, entries }, undefined, latest.revision);
    if (!saved) throw Error(tr('组件未保存，请重试。'));
    setUndo({ before: latest, revision: saved.revision }); setModal(null);
  }
  async function removeEntry(item) {
    if (presentation && hiddenKeys.has(`${item.type}:${item.id}`)) { requestPrivacyUnlock(); return; }
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
  async function fillSiteInfo(url, entryId, sequence, explicit = false, iconOptions = {}) {
    if (siteRequest.current !== sequence) return;
    setSiteInfo({ phase: "loading", message: "" });
    try {
      const origin = new URL(normalizeUrl(url)).origin;
      const info = await recognizeSite(url, iconOptions);
      if (siteRequest.current !== sequence) return;
      let icon;
      if (info.iconAvailable && info.iconUrl || info.highResolution && info.iconUrl) icon = { kind: 'url', value: info.iconUrl };
      else if (info.icon) {
        try {
          const id = await putImage(info.icon, "icon");
          icon = { kind: "image", value: id };
        } catch { /* An unavailable image uses the existing or text icon. */ }
        if (siteRequest.current !== sequence) return;
      }
      setEntry((value) => {
        if (siteRequest.current !== sequence || value?.id !== entryId) return value;
        const next = applyRecognizedSite(value, {
          title: info.nameFound ? info.title : undefined,
          icon: manualFields.current.icon && !iconOptions.iconUrl ? undefined : icon,
        }, { entryId, origin, preserveName: manualFields.current.name, preserveIcon: true });
        return info.iconUrl && (!manualFields.current.icon || iconOptions.iconUrl) ? withDiscoveredIcon(next, { url: info.iconUrl, fit: info.iconFit, variants: info.iconVariants }) : next;
      });
      const errors = explicit ? [
        !info.nameFound && !entry?.name.trim() && !manualFields.current.name && "未获取到名称，请手动填写。",
        !icon && !info.iconUrl && iconFailureMessage(info.iconError),
      ].filter(Boolean) : [];
      setSiteInfo({ phase: errors.length ? "error" : "ready", message: "", errors, hasAccess: info.hasAccess });
      if (iconOptions.iconUrl && icon && info.iconUrl) {
        setIconPreview((current) => withDiscoveredIcon({ ...(current || entry), icon }, { url: info.iconUrl, fit: info.iconFit, variants: info.iconVariants }));
        setEntryIconInfo({ phase: 'ready', source: info.iconUrl });
      }
    } catch {
      if (siteRequest.current === sequence) {
        setSiteInfo({ phase: "error", message: "", errors: explicit ? [
          !entry?.name.trim() && !manualFields.current.name && "未获取到名称，请手动填写。",
          iconFailureMessage(null),
        ].filter(Boolean) : [] });
      }
    }
  }
  function getSiteInfo() {
    if (!entry?.url || siteInfoPending || entryIconPending) return;
    let access;
    const sequence = ++siteRequest.current, entryId = entry.id, url = entry.url;
    iconOperation.current?.abort(); const controller = new AbortController(); iconOperation.current = controller;
    try {
      const source = entry.iconUrl || siteIconAddress(entry);
      access = !supportsSiteInfo() ? undefined : requestNavigationIconAccess([{ source: url }, ...(source ? [{ source }] : [])]);
    } catch { /* Name access must not block independent icon discovery. */ }
    setSiteInfo({ phase: access ? "permission" : "loading", message: "" });
    Promise.resolve(access).catch(() => false).then(() => {
      if (siteRequest.current !== sequence) return;
      // Denied page access can still yield a public image or browser-cache icon.
      return fillSiteInfo(url, entryId, sequence, true, { iconUrl: entry.iconUrl || siteIconAddress(entry), forceIcon: true, signal: controller.signal });
    });
  }
  function getEntryIcon() {
    if (!entry || entryIconPending || siteInfoPending || entrySaving) return;
    let source;
    try { source = normalizeIconAddress(entry.iconUrl || siteIconAddress(entry)); }
    catch (reason) { setEntryIconInfo({ phase: 'error', message: reason.message }); return; }
    const sequence = ++siteRequest.current, id = entry.id;
    iconOperation.current?.abort(); const controller = new AbortController(); iconOperation.current = controller;
    const authorization = requestNavigationIconAccess([{ source }]);
    setEntryIconInfo({ phase: 'permission', source }); setSiteInfo({ phase: 'idle', message: '' });
    Promise.resolve(authorization).catch(() => false).then(async () => {
      if (sequence !== siteRequest.current) return;
      setEntryIconInfo({ phase: 'loading', source });
      const item = await navigationIcon(source, { force: true, signal: controller.signal });
      if (sequence !== siteRequest.current) return;
      if (!item) { setEntryIconInfo({ phase: 'error', source, message: iconFailureMessage(getNavigationIconFailure(source)) }); return; }
      const next = withDiscoveredIcon({ ...entry, icon: { kind: 'url', value: source } }, { url: source, fit: guessIconFit(source) });
      manualFields.current.icon = true;
      setEntry((current) => current?.id === id ? withDiscoveredIcon({ ...current, icon: next.icon }, { url: source, fit: next.iconFit }) : current);
      setIconPreview(next); setEntryIconInfo({ phase: 'ready', source });
    }).catch(() => { if (sequence === siteRequest.current) setEntryIconInfo({ phase: 'error', source, message: iconFailureMessage(getNavigationIconFailure(source)) }); });
  }
  async function saveEntry(e) {
    e.preventDefault();
    if (entrySavePending.current || entryIconPending || siteInfoPending || e.nativeEvent?.isComposing) return;
    entrySavePending.current = true; setEntrySaving(true);
    siteRequest.current++;
    setSiteInfo({ phase: "idle", message: "" });
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
      const previous = state.entries.find((item) => item.id === value.id);
      if (manualFields.current.icon && value.type === 'site' && value.icon?.kind !== 'image') {
        await requestNavigationIconAccess([{ source: siteIconAddress(value) }]);
      }
      const iconsReady = await prepareSavedNavigationIcon(value, previous, { iconEdited: Boolean(manualFields.current.icon) });
      if (!iconsReady && (previous || manualFields.current.icon)) throw Error(iconFailureMessage(getNavigationIconFailure(siteIconAddress(value))));
      if (!demo) {
        const preferences = await loadContentPreferences();
        if (preferences.presentation && privateContentKeys(state, preferences).has(`${value.type}:${value.id}`)) throw Error(tr('请先输入密码解除隐藏。'));
      }
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
        if (!iconsReady) notify(iconFailureMessage(getNavigationIconFailure(siteIconAddress(value))), 'error');
        revealDesktopEntry(saved, value.id);
        setDraftPage(null);
        setModal(null);
        setEntry(null);
      }
    } catch (e) {
      setError(e.message);
    } finally { entrySavePending.current = false; setEntrySaving(false); }
  }
  async function readBookmarks(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw Error(tr("书签文件不能超过 5 MB"));
      const plan = parseBookmarks(await file.text());
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
    if (demo) return;
    setBusy(true);
    try {
      const blob = await recoveryCenter.exportCompleteBackup();
      downloadRecoveryFile(blob, 'Covelet-complete-backup.json');
    } catch (e) {
      notify(e.message, "error");
    } finally {
      setBusy(false);
    }
  }
  function renderTiles(list, placements) {
    return list.map((item) => {
      const target = drag?.target?.id === item.id ? drag.target : null;
      const children = desktopState.entries.filter((entry) => entry.parentId === item.id && (!presentation || !hiddenKeys.has(`site:${entry.id}`))).sort((a, b) => a.order - b.order);
      const editing = layoutEditor.editing && item.parentId === null && (!presentation || !hiddenKeys.has(`${item.type}:${item.id}`)), selected = editing && layoutEditor.selectedIds.includes(item.id);
      const Tile = item.type === 'widget' ? WidgetTile : 'div';
      const placement = placements?.get(item.id);
      if (presentation && item.type !== 'widget' && hiddenKeys.has(`${item.type}:${item.id}`)) return <div key={item.id} className={`site-tile presentation-private-tile ${drag?.ids.includes(item.id) ? 'dragging' : ''}`}
        {...tileProps(item)}
        onContextMenu={(event) => event.preventDefault()}
        data-grid-row={placement ? placement.row - 1 : undefined} data-grid-column={placement ? placement.column - 1 : undefined}
        style={placement ? { gridColumn: `${placement.column} / span ${placement.columns}`, gridRow: `${placement.row} / span ${placement.rows}` } : undefined}>
        <Button variant="unstyled" size="unstyled" type="button" className="site-link" onClick={requestPrivacyUnlock} aria-haspopup="dialog" aria-label={tr('输入密码查看隐藏内容')} title={tr('输入密码查看隐藏内容')}>
          <span className="site-icon presentation-private-icon" aria-hidden="true"><LockSimple size={26} /></span><span className="site-name">{tr('已隐藏')}</span>
        </Button></div>;
      return <Tile key={item.id} {...(item.type === 'widget' ? { item, editing, presentationHidden: presentation && hiddenKeys.has(`widget:${item.id}`) } : {})}
        role={editing ? 'button' : undefined} tabIndex={editing ? 0 : undefined} aria-label={editing ? builtinName(item.extensionId, item.name) : undefined} aria-pressed={editing ? selected : undefined}
        data-grid-row={placement ? placement.row - 1 : undefined} data-grid-column={placement ? placement.column - 1 : undefined}
        style={placement ? { gridColumn: `${placement.column} / span ${placement.columns}`, gridRow: `${placement.row} / span ${placement.rows}` } : undefined}
        className={`site-tile ${drag?.ids.includes(item.id) ? "dragging" : ""} ${selected ? 'is-selected' : ''} ${target?.kind === "combine" ? "combine-target" : ""} ${target?.kind === "move" ? `insert-${target.side}` : ""}`}
        {...tileProps(item)}
        onContextMenu={(event) => {
          event.preventDefault();
          if (presentation && hiddenKeys.has(`${item.type}:${item.id}`)) return;
          if (drag) return;
          const source = editing ? event.currentTarget : event.currentTarget.querySelector('.site-link, [id^="widget-title-"]');
          const box = source.getBoundingClientRect();
          setContext({ kind: editing ? 'layout' : "entry", item, source, x: event.clientX || box.left, y: event.clientY || box.bottom });
        }}
        onKeyDown={(event) => {
          if (presentation && hiddenKeys.has(`${item.type}:${item.id}`)) return;
          if (editing && !drag && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && !event.altKey) {
            event.preventDefault(); event.stopPropagation();
            layoutEditor.setSelectedIds([...new Set([...layoutEditor.selectedIds, ...list.filter((entry) => entry.parentId === null && !entry.detached && (!presentation || !hiddenKeys.has(`${entry.type}:${entry.id}`))).map((entry) => entry.id)])]);
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
          ? <ClockWidget entry={item} open={modal?.kind === 'clock' && modal.id === item.id} onOpen={() => openClock(item)} onClose={() => setModal(null)} onSaveConfig={(config) => useWidget(config, item, item.extensionId, { close: false })} Dialog={Modal} portalTarget={mainRef.current} />
          : ['notes', 'read-later'].includes(item.extensionId) ? <PersonalWidget entry={item} open={modal?.kind === 'personal-tool' && modal.id === item.id} onOpen={() => openClock(item)} onClose={() => setModal(null)} Dialog={Modal} portalTarget={mainRef.current} />
          : <GitHubWidget entry={item} open={modal?.kind === 'github-tool' && modal.id === item.id} onOpen={() => openClock(item)} onClose={() => setModal(null)} onSaveConfig={(config) => useWidget(config, item, item.extensionId, { close: false })} Dialog={Modal} portalTarget={mainRef.current} /> : item.type === "site" ? <a className="site-link" inert={editing || undefined} tabIndex={editing ? -1 : undefined} href={item.url} draggable={false} target={settings.openNewTab ? "_blank" : undefined} rel="noreferrer noopener" title={`${item.name}\n${item.url}`}>
          <SiteIcon entry={item} /><span className="site-name">{item.name}</span>
        </a> : <Button variant="unstyled" size="unstyled" className="site-link" inert={editing || undefined} tabIndex={editing ? -1 : undefined} title={item.name} aria-label={item.name} aria-haspopup="dialog" onClick={() => openEntry(item)}>
          <SiteIcon entry={item} children={children} /><span className="site-name">{item.name}</span>
        </Button>}
        {selected && <span className="layout-selection-mark" aria-hidden="true"><Check size={13} weight="bold" /></span>}
      </Tile>;
    });
  }
  function renderDragGhost() {
    if (!drag || drag.privacyKey !== privacyKey) return null;
    const dragged = drag.items || [drag.item];
    const anchor = drag.previewAnchor;
    const visibleEntries = presentation ? desktopState.entries.filter((item) => !hiddenKeys.has(`${item.type}:${item.id}`)) : desktopState.entries;
    const artwork = (item, index = 0) => <DragArtwork entry={item} entries={visibleEntries} snapshot={drag.previews?.get(item.id)} compact={index > 0} hidden={presentation && hiddenKeys.has(`${item.type}:${item.id}`)} />;
    return <div className={`icon-drag-ghost ${dragged.length > 1 ? 'is-multiple' : ''} ${anchor ? 'is-widget' : ''}`} aria-hidden="true"
      style={anchor ? { left: drag.x - anchor.x, top: drag.y - anchor.y, width: anchor.width, height: anchor.height } : { left: drag.x, top: drag.y }}>
      {dragged.length > 1 ? dragged.slice(0, 4).map((item, index) => <span key={item.id} className="icon-drag-stack" style={{ '--stack-index': index, zIndex: 5 - index }}>{artwork(item, index)}</span>) : artwork(drag.item)}
      {dragged.length > 1 && <b className="drag-count">{dragged.length}</b>}
      <span className="drag-target-label">{drag.target?.label || tr("松开取消")}</span>
    </div>;
  }
  function renderContextMenu() {
    if (!context || presentation && context.item && hiddenKeys.has(`${context.item.type}:${context.item.id}`)) return null;
    if (context.kind === 'layout') return <ContextMenu context={context} label={tr("布局操作")} onClose={() => setContext(null)} items={layoutEditor.editing ? [
      { label: tr("屏幕管理"), icon: <SquaresFour size={18} />, action: manageScreens, disabled: layoutEditor.saving },
      { label: tr("保存布局"), icon: <Check size={18} />, action: layoutEditor.save, disabled: layoutEditor.saving || layoutEditor.conflict },
      { label: tr("退出编辑"), icon: <X size={18} />, action: layoutEditor.cancel, disabled: layoutEditor.saving },
    ] : [
      { label: tr("编辑布局"), icon: <PencilSimple size={18} />, action: layoutEditor.begin },
      { label: tr('桌面方案与分享'), icon: <SquaresFour size={18} />, action: () => setModal({ kind: 'desktop-templates' }) },
    ]} />;
    const item = context.item;
    return <ContextMenu context={context} label={item.type === 'widget' ? tr("组件操作") : tr("网站操作")} onClose={() => setContext(null)} items={[
      ...(item.type === 'widget' && item.extensionId === GITHUB_WIDGET_ID ? [{ label: tr('打开'), icon: <ArrowSquareOut size={18} />, action: () => window.open(`https://github.com/${item.config.username}`, '_blank', 'noopener,noreferrer') }] : []),
      { label: item.type === 'widget' ? tr("配置组件") : tr("编辑"), icon: <PencilSimple size={18} />, action: () => editEntry(item) },
      ...(item.type === 'site' ? [{ label: tr('搜索别名'), icon: <MagnifyingGlass size={18} />, action: () => setModal({ kind: 'content-preferences', key: `site:${item.id}` }) }] : []),
      { label: contentPreferences.privateKeys.includes(`${item.type}:${item.id}`) ? tr('取消私密标记') : tr('标记为私密'), icon: <EyeSlash size={18} />, action: () => saveContentSettings(`${item.type}:${item.id}`, { private: !contentPreferences.privateKeys.includes(`${item.type}:${item.id}`) }).catch((reason) => notify(reason.message, 'error')) },
      { label: tr("编辑布局"), icon: <SquaresFour size={18} />, action: layoutEditor.begin },
      { divider: true },
      { label: item.type === 'widget' ? tr("移除组件") : item.type === "folder" ? tr("解散文件夹") : tr("删除网站"), icon: <Trash size={18} />, danger: true, action: () => removeEntry(item) },
    ]} />;
  }
  if (!state || !contentPreferencesReady)
    return (
      <main className="loading-screen">
        {error || contentPreferencesError ? (
          <>
            <h1>{tr("暂时无法读取本地数据")}</h1>
            <p>{tr(error || contentPreferencesError)}</p>
            <Button variant="unstyled" size="unstyled" onClick={() => location.reload()}>{tr("重新读取")}</Button>
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
      <PresentationContext.Provider value={presentationContext}>
      <AdaptIcons.Provider value={visualEnabled}>
      <main
        ref={mainRef}
        className={`owntab theme-${settings.theme} ${visualEnabled ? 'visual-enhanced' : ''} ${adaptive ? "adaptive-wallpaper" : ""} ${layoutEditor.editing ? 'layout-editing' : ''} ${presentation ? 'presentation-active' : ''}`}
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
            <Button variant="unstyled" size="unstyled" className="header-icon" type="button" aria-label={tr("添加网站")} title={tr("添加网站")} onClick={newEntry}><Plus size={25} /></Button>
            <Button variant="unstyled" size="unstyled" className="header-icon" type="button" disabled={privacyBusy || Boolean(modal) || Boolean(privacyDialog)} aria-pressed={presentation} aria-label={presentation ? tr('关闭隐藏') : tr('开启隐藏')} title={presentation ? tr('关闭隐藏') : tr('开启隐藏')}
              onClick={togglePresentation}>{presentation ? <EyeSlash size={25} /> : <Eye size={25} />}</Button>
            <Button variant="unstyled" size="unstyled"
              className="header-icon"
              aria-label={tr("打开扩展")}
              title={tr("扩展")}
              onClick={() => {
                setModal({ kind: "extensions" });
                setError("");
              }}
            >
              <PuzzlePiece size={27} />
            </Button>
            <Button variant="unstyled" size="unstyled"
              className="header-icon"
              aria-label={tr("打开设置")}
              title={tr("设置")}
              onClick={() => {
                setModal({ kind: "settings", revision: state.revision });
                setError("");
              }}
            >
              <GearSix size={29} />
            </Button>
          </div>
        </header>
        {presentationHint && <p className="presentation-status" role="status">{presentationHint}</p>}
        <section className="search-area" aria-label={tr("搜索")} inert={layoutEditor.editing || undefined}>
          <form className="search-box" onSubmit={submit} role="search">
            <div className="engine-selector" data-popover>
              <DropdownMenu open={engineMenu} modal={false} onOpenChange={(open) => { if (open) engineChoice.current = false; setEngineMenu(open); }}>
              <DropdownMenuTrigger asChild><Button variant="unstyled" size="unstyled"
                type="button"
                className="engine-button"
                aria-label={tr("选择搜索引擎，当前为{0}", [providerName(selectedProvider)])}
                title={providerName(selectedProvider)}
                aria-expanded={engineMenu}
              >
                {selectedProvider
                  ? <SearchProviderIcon provider={selectedProvider} epoch={providerIconEpoch} fallback="name" />
                  : <MagnifyingGlass className="provider-symbol" size={24} weight="light" aria-hidden="true" />}
                <CaretDown className="engine-caret" size={13} aria-hidden="true" />
              </Button></DropdownMenuTrigger>
              <DropdownMenuContent container={document.querySelector('.owntab') || document.body} className="search-engine-menu" align="start"
                onCloseAutoFocus={(event) => { if (engineChoice.current) { event.preventDefault(); inputRef.current?.focus({ preventScroll: true }); } }}>
                <DropdownMenuRadioGroup value={provider} onValueChange={(value) => { engineChoice.current = true; setProvider(value); setEngineMenu(false); }}>
                  <DropdownMenuRadioItem value="browser">
                    <MagnifyingGlass className="provider-symbol" size={22} weight="light" aria-hidden="true" />
                    <span className="engine-name">{tr("浏览器默认搜索")}</span>
                  </DropdownMenuRadioItem>
                  <DropdownMenuSeparator />
                  {state.providers.map((p) => (
                    <DropdownMenuRadioItem
                      key={p.id}
                      value={p.id}
                    >
                      <SearchProviderIcon provider={p} epoch={providerIconEpoch} />
                      <span className="engine-name">{providerName(p)}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <Input unstyled
              ref={inputRef}
              type="text"
              value={query}
              aria-label={tr("搜索或输入网址")}
              placeholder={tr("搜索或输入网址")}
              autoComplete="off"
              spellCheck="false"
              onCompositionStart={() => { composingSearch.current = true; }}
              onCompositionEnd={() => { composingSearch.current = false; }}
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
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
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
            <Button variant="unstyled" size="unstyled" className="search-submit" type="submit" aria-label={tr("搜索")}>
              <MagnifyingGlass size={33} weight="light" />
            </Button>
          </form>
          {focused && candidates.length > 0 && (
            <div ref={suggestionsRef} id="search-candidates" role="listbox" className="suggestions">
              {candidates.map((item, i) => (
                <Button variant="unstyled" size="unstyled"
                  key={item.key}
                  id={`candidate-${i}`}
                  role="option"
                  aria-selected={candidate === i}
                  className={candidate === i ? "selected" : ""}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => openContent(item)}
                  onContextMenu={(event) => { event.preventDefault(); setModal({ kind: 'content-preferences', key: item.key }); setFocused(false); }}
                >
                  {['site', 'folder'].includes(item.type) ? <SiteIcon entry={item.entry} small children={state.entries.filter((entry) => entry.parentId === item.id && (!presentation || !hiddenKeys.has(`site:${entry.id}`)))} /> : <span className="content-result-icon">{item.type === 'note' ? <NotePencil size={22} /> : <BookOpen size={22} />}</span>}
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.type === 'site' ? tr('网站') : item.type === 'folder' ? tr('文件夹') : item.type === 'note' ? tr('便笺') : tr('稍后读')}{item.subtitle ? ` · ${item.subtitle}` : ''}</small>
                  </span>
                  <ArrowSquareOut size={18} />
                </Button>
              ))}
            </div>
          )}
          {focused && query.trim() && (personalDataError || contentPreferencesError) && <p className="content-search-error" role="status">{tr('部分本机内容暂时无法搜索。')}</p>}
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
              if (event.button !== 0 || event.pointerType === 'touch' || layoutEditor.editing || layoutEditor.saving || event.shiftKey || event.target.closest('dialog, [data-ui-modal]')
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
        {modal?.kind === 'layout-delete' && layoutEditor.editing && <Modal title={modal.title} privacyKeys={modal.ids.flatMap((id) => desktopState.entries.filter((item) => item.id === id || item.parentId === id).map((item) => `${item.type}:${item.id}`))} onClose={() => setModal(null)}>
          <div className="form-stack">
            {modal.children > 0 && <p>{tr("文件夹内的 {0} 个网站也会删除。", [formatNumber(modal.children)])}</p>}
            {modal.clock && <p>{tr("保存后将清除所选时钟的计时记录和倒计时提醒。")}</p>}
            <div className="modal-footer"><Button variant="secondary" type="button" className="button" data-autofocus onClick={() => setModal(null)}>{tr("取消")}</Button>
              <Button variant="destructive" type="button" className="button" disabled={layoutEditor.saving || layoutEditor.conflict} onClick={confirmLayoutDelete}>{tr("删除")}</Button></div>
          </div>
        </Modal>}
        {screenManager && layoutEditor.editing && <DesktopScreenManager Dialog={Modal} state={desktopState} columns={desktopScreen.current.columns}
          hiddenIds={presentation ? privateEntryIds : []}
          activeKey={activeScreen} editor={layoutEditor} onSelect={setActiveScreen} onClose={() => { setScreenManager(false); focusDesktop(); }}
          renderIcon={(item) => <SiteIcon entry={item} small children={desktopState.entries.filter((entry) => entry.parentId === item.id && (!presentation || !hiddenKeys.has(`${entry.type}:${entry.id}`))).sort((a, b) => a.order - b.order)} />} />}
        {!folderId && renderContextMenu()}
        {!folderId && renderDragGhost()}
        {currentFolder && !modal && (
          <Modal title={currentFolder.name} privacyKeys={[`folder:${currentFolder.id}`]} titleContent={<FolderName name={currentFolder.name} onSave={saveFolderName} />} onClose={() => { cancelDrag(); setFolder(null); }} wide>
            <div className="folder-content" data-folder-panel={currentFolder.id}>
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
              <Button variant="unstyled" size="unstyled" onClick={undoDelete}>
                <ArrowUUpLeft size={17} />{tr("撤销")}</Button>
            )}
            <Button variant="unstyled" size="unstyled"
              className="icon-button"
              aria-label={tr("关闭提示")}
              onClick={() => setNotice(null)}
            >
              <X size={17} />
            </Button>
          </div>
        )}
        {busy && (
          <div className="busy-indicator" role="status">{tr('处理中…')}</div>
        )}
        <Input
          ref={bookmarkInput}
          type="file"
          accept=".html,.htm,text/html"
          hidden
          onChange={readBookmarks}
        />
        <Input
          ref={backupInput}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={readBackup}
        />
        {modal?.kind === "entry" && entry && (
          <Modal
            privacyKeys={modal.isNew ? [] : [`${entry.type}:${entry.id}`]}
            title={`${modal.isNew ? tr("添加") : tr("编辑")}${entry.type === "folder" ? tr("文件夹") : tr("网站")}`}
            closeDisabled={entrySaving}
            onClose={closeEntry}
          >
            <form onSubmit={saveEntry} className="form-stack">
              <fieldset disabled={entrySaving} style={{ display: 'contents', border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              {entry.type === "site" && (
                <>
                  <label>{tr("网址")}<Input autoFocus required value={entry.url} maxLength={2048} placeholder="https://example.com" onChange={(event) => {
                      siteRequest.current++;
                      iconOperation.current?.abort(); setEntryIconInfo({ phase: 'idle' });
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
                <div className="field-heading"><label htmlFor="entry-name">{tr("名称")}</label>{entry.type === "site" && <Button variant="unstyled" size="unstyled" className="field-action" type="button" disabled={!entry.url || siteInfoPending || entryIconPending} aria-label={tr(siteInfoPending ? "正在获取信息…" : "获取信息")} aria-busy={siteInfoPending} onClick={getSiteInfo}>
                  {siteInfoPending && <CircleNotch size={14} className="site-info-spinner" aria-hidden="true" />}
                  <span role="status" aria-live="polite">{tr(siteInfoPending ? "正在获取信息…" : "获取信息")}</span>
                </Button>}</div>
                <Input
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
              {entry.type === "site" && (siteInfo.message || siteInfo.errors?.length > 0) && <div className="site-recognition">
                {siteInfo.message && <span className="hint" role="status">{tr(siteInfo.message)}</span>}
                {siteInfo.errors?.map((message) => <span className="hint" role="status" key={message}>{tr(message)}</span>)}
              </div>}
              <IconBackground value={entry.iconBackground || DEFAULT_ICON_BACKGROUND}
                onChange={(iconBackground) => setEntry((value) => ({ ...value, iconBackground }))}
                onReset={() => setEntry((value) => { const next = { ...value }; delete next.iconBackground; return next; })}
                preview={<SiteIcon entry={iconPreview ? { ...iconPreview, name: entry.name, iconBackground: entry.iconBackground } : entry} children={state.entries.filter((child) => child.parentId === entry.id && (!presentation || !hiddenKeys.has(`${child.type}:${child.id}`))).sort((a, b) => a.order - b.order)} />} />
              {entry.type === 'site' && <label>{tr("图标地址")}<Input type="url" value={entry.iconUrl ?? siteIconAddress(entry)} maxLength={4096}
                placeholder="https://example.com/icon.png" onChange={(event) => {
                  // An older acquisition must not replace the newly typed source.
                  siteRequest.current++; iconOperation.current?.abort();
                  setEntryIconInfo({ phase: 'idle' }); setSiteInfo({ phase: 'idle', message: '' });
                  manualFields.current.icon = true;
                  const iconUrl = event.target.value;
                  let icon;
                  try { icon = { kind: 'url', value: normalizeIconAddress(iconUrl) }; } catch { /* Keep the name fallback while typing. */ }
                  setEntry((value) => withDiscoveredIcon({ ...value, icon: icon || letterIcon(value.name) }, { url: iconUrl }));
                }} /></label>}
              {entry.type === 'site' && <div className="form-stack">
                <Button variant="secondary" type="button" disabled={entrySaving || entryIconPending || siteInfoPending || !(entry.iconUrl || entry.url)} aria-busy={entryIconPending} onClick={getEntryIcon}>
                  {entryIconPending && <CircleNotch size={14} className="site-info-spinner" aria-hidden="true" />}
                  {entryIconPending ? tr('正在获取图标…') : tr('获取图标')}
                </Button>
                {entryIconInfo.phase === 'error' && <p className="form-error" role="alert">{entryIconInfo.message}</p>}
              </div>}
              {error && (
                <p className="form-error" role="alert">
                  {tr(error)}
                </p>
              )}
              <div className="modal-footer">
                <Button variant="secondary"
                  type="button"
                  className="button"
                  onClick={closeEntry}
                >{tr("取消")}</Button>
                <Button variant="default"
                  className="button primary"
                  type="submit"
                  disabled={busy || entryIconPending || siteInfoPending}
                >
                  {entrySaving ? tr('保存中…') : modal.isNew ? tr("添加") : tr("保存")}
                </Button>
              </div>
              </fieldset>
            </form>
          </Modal>
        )}
        {modal?.kind === "extensions" && (
          <ExtensionCenter Dialog={Modal} state={state} initialExtension={modal.initialExtension} editingId={modal.editingId} onUseWidget={useWidget} onRemoveWidget={detachWidget} onConfigureFunctional={() => setModal({ kind: 'sync-settings' })} onClose={() => setModal(null)} />
        )}
        {modal?.kind === 'sync-settings' && <Modal title={tr('自定义存储同步')} className="settings-modal sync-settings-modal" wide maximizable closeDisabled={busy} onClose={() => { if (!busy) setModal(null); }}><CloudSyncSettings demo={demo} onBusyChange={setBusy} onLocalOnly={() => { setModal(null); notify(tr('已关闭同步，仅在本机保存数据。')); }} /></Modal>}
        {modal?.kind === 'personal-content' && <PersonalToolsDialog key={`${modal.type}:${modal.recordId}`} kind={modal.type} initialRecordId={modal.recordId} Dialog={Modal} onClose={() => setModal(null)} />}
        {modal?.kind === 'tools-trash' && <PersonalToolsTrashDialog Dialog={Modal} onClose={() => setModal(null)} />}
        {modal?.kind === 'content-preferences' && <Modal title={tr('内容与隐私')} privacyKeys={modal.key ? [modal.key] : []} closeDisabled={busy} onClose={() => { if (!busy) setModal(null); }}>
          <ContentPreferences navigation={state} tools={personalData} preferences={contentPreferences} initialKey={modal.key} onBusyChange={setBusy} onClose={() => setModal(null)} />
        </Modal>}
        {modal?.kind === 'desktop-templates' && <Modal title={tr('桌面方案与分享')} className="desktop-templates-modal" closeDisabled={busy} onClose={() => { if (!busy) setModal(null); }} wide maximizable>
          <DesktopTemplates state={state} privateEntryIds={privateEntryIds} iconProgress={iconProgress} onBusyChange={setBusy} onClose={() => setModal(null)} onApply={async (prepared) => {
            const before = state;
            const existing = new Set(before.entries.map((entry) => entry.id));
            const added = new Set(prepared.state.entries.filter((entry) => !existing.has(entry.id)).map((entry) => entry.id));
            const saved = await commitImportedNavigation(prepared.state, added, prepared.sourceRevision, tr('桌面方案已应用。'));
            if (!saved) return false;
            setUndo({ before, revision: saved.revision });
            if (prepared.revealId) revealDesktopEntry(saved, prepared.revealId);
            setModal(null); return true;
          }} />
        </Modal>}
        {modal?.kind === 'recovery-center' && <Modal title={tr('备份与恢复中心')} closeDisabled={busy} onClose={() => { if (!busy) setModal(null); }} wide>
          <RecoveryCenter onBusyChange={setBusy} onRestored={(next) => {
            if (next.revision >= preferenceState.current.revision) preferenceState.current = next;
            setState((current) => current.revision > next.revision ? current : next); setFolder(null); setUndo(null);
          }} />
        </Modal>}
        {modal?.kind === "settings" && (
          <Settings
            state={state}
            busy={busy} iconProgress={iconProgress}
            onClose={() => setModal(null)}
            readPreferences={() => demo ? Promise.resolve(preferenceState.current) : loadState()}
            writePreferences={async (next, revision) => {
              const saved = demo ? { ...migrateNavigationState(next), revision: revision + 1 } : await saveState(next, revision);
              preferenceState.current = saved;
              setState(saved);
              return saved;
            }}
            onExport={download}
            onImport={() => setModal({ kind: 'recovery-center' })}
            onBookmarks={() => { setImportPlan(null); setModal({ kind: 'bookmarks', revision: preferenceState.current.revision }); }}
            onContentPreferences={() => setModal({ kind: 'content-preferences' })}
            onCloudSync={() => setModal({ kind: 'sync-settings' })}
            onDesktopTemplates={() => setModal({ kind: 'desktop-templates' })}
            onToolsTrash={() => setModal({ kind: 'tools-trash' })}
            onSnapshot={async (latest) => {
              if (busy) return;
              setBusy(true);
              try {
                const result = await restoreSnapshot(latest.revision, { onIconProgress: setIconProgress });
                setState(result);
                setModal(null);
                notify(tr("已恢复上一份本地快照"));
              } catch (e) {
                notify(e.message, "error");
              } finally { setBusy(false); }
            }}
            wallpaper={wallpaper}
            providerIconEpoch={providerIconEpoch}
            onProviderIconReady={() => setProviderIconEpoch((value) => value + 1)}
          />
        )}
        {modal?.kind === 'bookmarks' && <Modal title={tr('导入网址与书签')} closeDisabled={busy} onClose={() => { if (!busy) setModal(null); }} wide>
          <BookmarkImport state={state} initialPlan={importPlan} initialPage={desktopScreen.current.page} columns={desktopScreen.current.columns} iconProgress={iconProgress}
            onBusyChange={setBusy} onClose={() => setModal(null)} onApply={async (prepared) => {
              const before = state;
              const added = new Set(prepared.rows.filter((row) => row.willAdd).map((row) => row.entryId));
              const saved = await commitImportedNavigation(prepared.state, added, prepared.sourceRevision, tr('已导入 {0} 个网址。', [formatNumber(prepared.addedSites)]));
              if (!saved) return false;
              setUndo({ before, revision: saved.revision });
              if (prepared.revealId) revealDesktopEntry(saved, prepared.revealId);
              setModal(null); return true;
            }} />
        </Modal>}
        {modal?.kind === "restore" && backupPlan && (
          <Modal title={tr("恢复完整备份")} closeDisabled={busy} onClose={() => { if (!busy) setModal(null); }}>
            <div className="form-stack">
              <p>{tr("备份包含 {0} 个网站和 {1} 个自定义图片。", [formatNumber(backupPlan.summary.sites), formatNumber(backupPlan.summary.assets)])}</p>
              <p>{tr("恢复会替换当前网址、搜索选项、外观和布局，并保留上一份本地快照。")}</p>
              <NavigationIconStatus report={iconProgress} busy={busy} />
              {backupPlan.state.settings.background.kind === "image" && (
                <p className="hint">{tr('此备份的壁纸无法恢复，将使用 Bing 每日壁纸。')}</p>
              )}
              <div className="modal-footer">
                <Button variant="secondary" className="button" disabled={busy} onClick={() => setModal(null)}>{tr("取消")}</Button>
                <Button variant="default"
                  className="button primary" disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const result = await restoreBackup(
                        backupPlan,
                        modal.revision,
                        { onIconProgress: setIconProgress },
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
                >{tr("替换并恢复")}</Button>
              </div>
            </div>
          </Modal>
        )}
        {privacyDialog && <PrivacyPasswordDialog purpose={privacyDialog} onClose={() => setPrivacyDialog(null)} />}
        {settings.background.kind === "bing" && wallpaper?.source === "bing" && wallpaper.copyright && (
          <a className="wallpaper-credit" href={wallpaper.copyrightUrl} target="_blank" rel="noopener noreferrer" title={wallpaper.title}>
            {wallpaper.copyright}{wallpaper.stale ? tr(" · 缓存壁纸") : ""}
          </a>
        )}
      </main>
      </AdaptIcons.Provider>
      </PresentationContext.Provider>
    </DialogError.Provider>
  );
}

function Settings({
  state,
  busy = false, iconProgress,
  onClose,
  readPreferences,
  writePreferences,
  onExport,
  onImport,
  onBookmarks,
  onContentPreferences,
  onCloudSync,
  onDesktopTemplates,
  onToolsTrash,
  onSnapshot,
  wallpaper,
  providerIconEpoch,
  onProviderIconReady,
}) {
  const [tab, setTab] = useState("appearance"),
    [draft, setDraft] = useState(structuredClone(state.settings)),
    [providers, setProviderDraft] = useState(structuredClone(state.providers)),
    [newName, setNewName] = useState(""),
    [editingProvider, setEditingProvider] = useState(null),
    [newTemplate, setNewTemplate] = useState(""),
    [error, setError] = useState("");
  const [saving, setSaving] = useState({ phase: "idle" });
  const panelRef = useRef(null);
  useLayoutEffect(() => { if (panelRef.current) panelRef.current.scrollTop = 0; }, [tab]);
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
    if (busy) return;
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
  const patch = (value) => { setDraft((d) => ({ ...d, ...value })); saver.queue({ settings: value }); };
  const tabs = [["appearance", tr("外观")], ["layout", tr("布局")], ["search", tr("搜索")], ["enhancements", tr("增强")], ["data", tr("数据")], ["privacy", tr('隐私自查')]];
  return (
    <Modal title={tr("设置")} closeDisabled={busy} onClose={closeSettings} className="settings-modal preferences-modal" wide>
      <Tabs className="settings-layout" value={tab} orientation="vertical" onValueChange={(value) => { setTab(value); setError(''); }}>
      <TabsList className="settings-tabs" aria-label={tr("设置分类")}>
        {tabs.map(([id, name]) => (
          <TabsTrigger
            value={id}
            id={`settings-tab-${id}`}
            aria-controls="settings-panel"
            key={id}
          >
            {name}
          </TabsTrigger>
        ))}
      </TabsList>
      <div className="settings-content">
      <TabsContent value={tab} ref={panelRef} className="form-stack settings-scroll" id="settings-panel" aria-labelledby={`settings-tab-${tab}`} tabIndex={0}>
        {tab === "appearance" && (
          <>
            <Button variant="secondary" type="button" className="button" onClick={() => afterSave(onDesktopTemplates)}><SquaresFour size={18} />{tr('桌面方案与分享')}</Button>
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
                <Switch aria-label={tr("视觉增强")} checked={draft.visualEnhancement} onCheckedChange={(nextChecked) => patch({ visualEnhancement: nextChecked })} />
              </label>
            </section>
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
              <Switch

                checked={draft.showLabels}
                onCheckedChange={(nextChecked) => patch({ showLabels: nextChecked })}
              />{tr("显示网站名称")}</label>
            <label className="check-label">
              <Switch

                checked={draft.openNewTab}
                onCheckedChange={(nextChecked) => patch({ openNewTab: nextChecked })}
              />{tr("在新标签页打开网站和搜索结果")}</label>
          </>
        )}
        {tab === "search" && (
          <>
            <p className="hint">{tr('支持搜索导航、便笺和稍后读，也可输入拼音首字母。')}</p>
            <Button variant="secondary" type="button" className="button" onClick={() => afterSave(onContentPreferences)}>{tr('内容别名与隐私标记')}</Button>
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
                  <Button variant="unstyled" size="unstyled"
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
                  </Button>
                  <Button variant="unstyled" size="unstyled"
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
                  </Button>
                  <Button variant="unstyled" size="unstyled"
                    className="icon-button danger"
                    type="button"
                    aria-label={tr("删除{0}", [providerName(p)])}
                    onClick={() => {
                      setProviders(providers.filter((v) => v.id !== p.id));
                      if (editingProvider === p.id) { setEditingProvider(null); setNewName(""); setNewTemplate(""); }
                    }}
                  >
                    <Trash size={18} />
                  </Button>
                </div>
              ))}
            </div>
            <label>{tr("引擎名称")}<Input
                value={newName}
                maxLength={80}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={providerInputKeyDown}
                placeholder={tr("例如：站点搜索")}
              />
            </label>
            <label>{tr("搜索地址模板")}<Input
                value={newTemplate}
                onChange={(e) => setNewTemplate(e.target.value)}
                onKeyDown={providerInputKeyDown}
                placeholder={tr("搜索地址，使用 {query} 表示关键词")}
              />
            </label>
            <Button variant="secondary"
              type="button"
              className="button"
              onClick={addProvider}
            >
              {editingProvider ? tr("保存引擎") : tr("添加引擎")}
            </Button>
            {editingProvider && <Button variant="ghost" type="button" className="button quiet" onClick={() => { setEditingProvider(null); setNewName(""); setNewTemplate(""); setError(""); }}>{tr("取消修改")}</Button>}
          </>
        )}
        {tab === "data" && (
          <>
            <div className="data-actions">
              <Button variant="secondary" type="button" className="button" disabled={busy} onClick={() => afterSave(onCloudSync)}>
                {tr('自定义存储同步')}</Button>
              <Button variant="secondary" type="button" className="button" onClick={() => afterSave(onBookmarks)}>
                <UploadSimple size={19} />{tr('导入网址与书签')}</Button>
              <Button variant="secondary" type="button" className="button" disabled={demo} onClick={() => afterSave(onExport)}>
                <DownloadSimple size={19} />{tr("导出完整备份")}</Button>
              <Button variant="secondary" type="button" className="button" disabled={demo} onClick={() => afterSave(onImport)}>
                <UploadSimple size={19} />{tr('备份与恢复中心')}</Button>
              <Button variant="secondary" type="button" className="button" disabled={demo} onClick={() => afterSave(onToolsTrash)}>
                <Trash size={19} />{tr('工具回收站')}</Button>
              <Button variant="secondary" type="button" className="button" disabled={busy} onClick={() => afterSave(onSnapshot)}>
                <ArrowUUpLeft size={19} />{tr("恢复上一份本地快照")}</Button>
            </div>
            <NavigationIconStatus report={iconProgress} busy={busy} />
            <a className="settings-privacy-link" href="https://sites.google.com/view/covelet-privacy" target="_blank" rel="noopener noreferrer">{tr("隐私政策")}</a>
          </>
        )}
        {tab === 'privacy' && <PrivacyCheckup demo={demo} />}
        {error && (
          <p className="form-error" role="alert">
            {tr(error)}
          </p>
        )}
      </TabsContent>
      {saving.phase === "error" && <div className="settings-save-status">
          <p className="form-error" role="alert">{tr(saving.error?.message) || tr("设置未保存，请重试。")}</p>
          <div className="settings-retry-actions">
            {saving.error?.code !== "PREFERENCE_CONFLICT" && <Button variant="secondary" type="button" className="button" onClick={() => saver.retry().catch(() => {})}>{tr("重试")}</Button>}
            <Button variant="ghost" type="button" className="button quiet" onClick={async () => {
              try {
                const latest = await saver.reload();
                setDraft(structuredClone(latest.settings)); setProviderDraft(structuredClone(latest.providers));
              } catch (reason) { setError(reason.message); }
            }}>{tr("放弃修改并重新载入")}</Button>
          </div>
      </div>}
      </div>
      </Tabs>
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
      <Slider

        aria-label={label}
        value={[Number(value)]}
        onValueChange={([nextValue]) => onChange(Number(nextValue))}
        {...props}
      />
    </label>
  );
}

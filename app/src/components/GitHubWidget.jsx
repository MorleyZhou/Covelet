import { tr, getLocale, formatNumber } from '../i18n/index.js';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowsClockwise, GithubLogo, GearSix, ArrowLeft } from '@phosphor-icons/react';
import { createPortal } from 'react-dom';
import { githubContributions, requestGitHubAccess } from '../lib/github-contributions.js';
import { useSyncedDataRevision } from '../lib/use-synced-data.js';
import { analyzeGitHubCalendar } from '../lib/github-wasm.js';
import { validateWidgetConfig, normalizeGitHubUsername, GITHUB_WIDGET_ID, WIDGET_SIZE_OPTIONS } from '../lib/widget-model.js';
import { githubWidgetCalendar } from '../lib/github-layout.js';
import previewCalendar from '../assets/github-preview.json';
import Select from './Select.jsx';
import Confirm, { MessageDialog } from './PromptDialog.jsx';
import './github-widget.css';
import { Input } from './ui/input.jsx';
import { Button } from './ui/button.jsx';

// Calendar dates are date-only values; formatting in UTC preserves the day.
const contributionDate = (date) => new Date(`${date}T00:00:00Z`).toLocaleDateString(getLocale(), { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });

export function GitHubWidgetSettings({ entry, onUse, onBusyChange, onDirtyChange, introduction, internal = false }) {
  const [username, setUsername] = useState(entry?.config.username || '');
  const [size, setSize] = useState(entry?.config.size || 'medium');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const initial = useRef(username);
  useEffect(() => { onDirtyChange?.(username !== initial.current); return () => onDirtyChange?.(false); }, [username, onDirtyChange]);
  function save(event) {
    event.preventDefault();
    if (busy || event.nativeEvent?.isComposing) return;
    let config;
    try { config = validateWidgetConfig(GITHUB_WIDGET_ID, { username: normalizeGitHubUsername(username), size }); }
    catch (reason) { setError(reason.message); return; }
    const permission = requestGitHubAccess();
    setBusy(true); onBusyChange(true); setError('');
    (async () => {
      try {
        if (!await permission) throw new Error(tr('未获得 GitHub 访问权限，组件尚未保存。'));
        await onUse(config, entry);
      } catch (reason) { setError(reason.message || tr('组件未保存，请重试。')); }
      finally { setBusy(false); onBusyChange(false); }
    })();
  }
  return <form className="form-stack widget-config-form" onSubmit={save}>
    <div className="settings-scroll form-stack">
      {introduction}
      <label>{tr('GitHub 用户名')}<Input value={username} onChange={(event) => setUsername(event.target.value)}
        autoComplete="off" spellCheck={false} maxLength={40} placeholder="username" disabled={busy}
        aria-describedby="github-widget-access" /></label>
      {!internal && <Select label={tr('尺寸')} value={size} onChange={setSize} disabled={busy} options={WIDGET_SIZE_OPTIONS} />}
      <p className="hint" id="github-widget-access">{tr('使用时需要访问 github.com，读取该用户公开展示的贡献日历。')}</p>
      <MessageDialog message={error} onClose={() => setError('')} />
    </div>
    <div className="settings-footer"><Button variant="default" type="submit" className="button primary" disabled={busy}>
      {entry && !entry.detached ? tr('保存') : tr('使用')}
    </Button></div>
  </form>;
}

function ContributionCalendar({ calendar, size = 'medium', readOnly = false }) {
  const frame = useRef(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = frame.current;
    const measure = () => {
      const width = element.clientWidth, height = element.clientHeight;
      if (width > 0 && height > 0) setBounds((before) => before.width === width && before.height === height ? before : { width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const view = useMemo(() => githubWidgetCalendar(calendar, size, bounds), [calendar, size, bounds]);
  return <div className="github-calendar-panels" ref={frame}>
    <div className="github-calendar-stack" role={readOnly ? undefined : 'group'} aria-label={readOnly ? undefined : tr('贡献日历')}
      style={{ '--calendar-weeks': view.columns, '--calendar-cell': `${view.cell}px`, '--calendar-gap': `${view.gap}px` }}>
      {view.sections.map((section) => <div className="github-calendar" key={section.start}>
        {section.cells.map((day, offset) => {
          const index = section.start + offset;
          if (!day) return <span key={`padding-${index}`} className="github-day is-padding" aria-hidden="true" />;
          const className = `github-day github-level-${day.level}`;
          if (readOnly) return <span key={day.date} className={className} />;
          // Noninteractive cells let pointer events reach the widget's drag
          // handler. A button here is intentionally excluded by useIconDrag.
          return <span key={day.date} className={className} role="img"
            aria-label={tr('{0}，{1} 次贡献', [contributionDate(day.date), formatNumber(day.count)])}
            title={tr('{0} · {1} 次贡献', [contributionDate(day.date), formatNumber(day.count)])} />;
        })}
      </div>)}
    </div>
  </div>;
}

export function GitHubWidgetPreview() {
  const [calendar, setCalendar] = useState(null);
  useEffect(() => {
    let active = true;
    analyzeGitHubCalendar(previewCalendar.days).then((value) => { if (active) setCalendar(value); }).catch(() => {});
    return () => { active = false; };
  }, []);
  return <figure className="github-widget-preview">
    <div className="github-widget github-widget-medium" aria-hidden="true">
      {calendar ? <ContributionCalendar calendar={calendar} readOnly />
        : <div className="github-widget-placeholder"><GithubLogo size={26} weight="fill" /></div>}
    </div>
    <figcaption>{tr('公开日历预览 · @')}{previewCalendar.username}</figcaption>
  </figure>;
}

export default function GitHubWidget({ entry, open = false, onOpen, onClose, onSaveConfig, Dialog, portalTarget }) {
  const syncRevision = useSyncedDataRevision();
  const { username, size } = entry.config;
  const sequence = useRef(0);
  const [source, setSource] = useState(null), [computed, setCalendar] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [configuring, setConfiguring] = useState(false), [configBusy, setConfigBusy] = useState(false), [configDirty, setConfigDirty] = useState(false), [discarding, setDiscarding] = useState(null);
  const close = () => { if (configBusy) return; if (configDirty) setDiscarding('window'); else { setConfiguring(false); onClose(); } };
  const calendar = computed?.username === username ? computed : null;
  useEffect(() => {
    if (!username) { setSource(null); setCalendar(null); setError(''); return; }
    let active = true;
    const refresh = async () => {
      if (document.visibilityState === 'hidden') return;
      const current = ++sequence.current;
      setBusy(true);
      try {
        const value = await githubContributions.load(username);
        if (active && sequence.current === current) { setSource({ ...value, username }); setError(value.error || ''); }
      } catch (reason) { if (active && sequence.current === current) setError(reason.message); }
      finally { if (active && sequence.current === current) setBusy(false); }
    };
    setSource(null); setCalendar(null); setError('');
    refresh();
    const timer = setInterval(refresh, 60 * 60 * 1000);
    document.addEventListener('visibilitychange', refresh);
    return () => { active = false; ++sequence.current; clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [username, syncRevision]);
  useEffect(() => {
    if (source?.username !== username) return;
    let active = true;
    // Always analyze the same complete source calendar. Size changes only crop
    // its display; they never change storage, request data or invoke the WASM again.
    analyzeGitHubCalendar(source.days).then((value) => {
      if (active) setCalendar({ ...value, username });
    }).catch((reason) => { if (active) { setCalendar(null); setError(reason.message); } });
    return () => { active = false; };
  }, [source, username]);

  function refresh() {
    if (busy) return;
    const permission = requestGitHubAccess();
    const current = ++sequence.current;
    setBusy(true); setError('');
    (async () => {
      try {
        if (!await permission) throw new Error(tr('请授权访问 GitHub 后重试。'));
        const value = await githubContributions.load(username, { force: true });
        if (sequence.current === current) { setSource({ ...value, username }); setError(value.error || ''); }
      } catch (reason) { if (sequence.current === current) setError(reason.message); }
      finally { if (sequence.current === current) setBusy(false); }
    })();
  }
  return <><article className={`github-widget github-widget-${size}`} id={`widget-title-${entry.id}`} tabIndex={-1}
    data-widget-surface aria-label={tr('GitHub 贡献：{0}', [username])} aria-busy={busy}
    title={error ? `${tr(error)}${calendar ? tr(' 正在显示上次更新的内容。') : ''}` : undefined}>
    {calendar ? <ContributionCalendar calendar={calendar} size={size} />
      : <div className="github-widget-placeholder"><GithubLogo size={size === 'mini' ? 22 : 28} weight="fill" aria-hidden="true" />
        <span>{tr(error) || (busy ? tr('正在读取…') : tr('暂无贡献数据'))}</span></div>}
    <Button variant="unstyled" size="unstyled" type="button" className="github-open" aria-label={tr('打开 GitHub 贡献')} aria-haspopup="dialog" aria-expanded={open} onClick={onOpen} />
    {username && <Button variant="unstyled" size="unstyled" type="button" className={`github-refresh ${error ? 'has-error' : ''}`} aria-label={tr('刷新 GitHub 贡献')}
      title={tr('刷新')} disabled={busy} onClick={refresh}><ArrowsClockwise size={15} /></Button>}
    <span className="visually-hidden" role="status">{error ? `${tr(error)}${calendar ? tr(' 正在显示上次更新的内容。') : ''}` : ''}</span>
  </article>{open && Dialog && portalTarget && createPortal(<div onPointerDown={(event) => event.stopPropagation()} onPointerMove={(event) => event.stopPropagation()} onPointerUp={(event) => event.stopPropagation()}><Dialog title={tr('GitHub 贡献')} className="github-tools-modal" wide maximizable privacyKeys={[`widget:${entry.id}`]} closeDisabled={configBusy} onClose={close}>
    <section className="github-tools"><div className="github-tools-toolbar">{configuring && username ? <Button type="button" variant="ghost" disabled={configBusy} onClick={() => { if (configDirty) setDiscarding('settings'); else setConfiguring(false); }}><ArrowLeft size={16} />{tr('返回')}</Button> : <strong>{username ? `@${username}` : ''}</strong>}{username && !configuring && <div><Button type="button" variant="ghost" disabled={busy} onClick={refresh}><ArrowsClockwise size={17} />{busy ? tr('正在读取…') : tr('刷新')}</Button><Button type="button" variant="ghost" size="icon" aria-label={tr('设置')} onClick={() => setConfiguring(true)}><GearSix size={18} /></Button></div>}</div>
      {configuring || !username ? <GitHubWidgetSettings internal entry={entry} onDirtyChange={setConfigDirty} onBusyChange={setConfigBusy} onUse={async (config) => { await onSaveConfig(config); setConfiguring(false); }} /> : <><div className="github-full-calendar">{calendar ? <ContributionCalendar calendar={calendar} size="large" /> : <p className="app-empty">{busy ? tr('正在读取…') : tr('暂无贡献数据')}</p>}</div>{calendar && <div className="github-calendar-stats"><strong>{formatNumber(source.days.reduce((sum, day) => sum + day.count, 0))}</strong><span>{tr('次贡献')}</span></div>}</>}
      <MessageDialog message={error} onClose={() => setError('')} />
      {discarding && <Confirm action={tr('放弃修改')} onCancel={() => setDiscarding(null)} onConfirm={() => { const target = discarding; setDiscarding(null); setConfigDirty(false); setConfiguring(false); if (target === 'window') onClose(); }}>{tr('当前内容尚未保存，放弃修改？')}</Confirm>}
    </section>
  </Dialog></div>, portalTarget)}</>;
}

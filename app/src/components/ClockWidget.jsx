import { tr, getLocale, builtinName, formatNumber } from "../i18n/index.js";
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Clock, Globe, ArrowsLeftRight, Hourglass, Timer, Bell, Play, Pause, ArrowCounterClockwise, X, GearSix, ArrowLeft } from '@phosphor-icons/react';
import Select from './Select.jsx';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs.jsx';
import { CLOCK_WIDGET_ID, WIDGET_SIZE_OPTIONS, validateWidgetConfig } from '../lib/widget-model.js';
import { loadClockCore } from '../lib/clock-core.js';
import { emptyClockState, prepareClockState, subscribeClockState, updateClockState, finishClockTimer, requestClockNotifications, supportsClockBackground } from '../lib/clock-runtime.js';
import { WORLD_ZONES, DEFAULT_WORLD_ZONES, normalizeTimeZone, zoneLabel, zoneParts, wallInput, instantsForWall, utcOffset } from '../lib/time-zones.js';
import './clock-widget.css';
import { Button } from './ui/button.jsx';
import { Input } from './ui/input.jsx';
import { Switch } from './ui/switch.jsx';
import Confirm from './PromptDialog.jsx';

const MODES = [{ id: 'clock', get label() { return tr("时钟"); }, Icon: Clock }, { id: 'world', get label() { return tr("世界时钟"); }, Icon: Globe }, { id: 'compare', get label() { return tr("时区对照"); }, Icon: ArrowsLeftRight }, { id: 'countdown', get label() { return tr("倒计时"); }, Icon: Hourglass }, { id: 'stopwatch', get label() { return tr("计时"); }, Icon: Timer }];
const pad = (number) => String(number).padStart(2, '0');
const partsFor = (duration) => [Math.floor(duration / 3600000), Math.floor(duration / 60000) % 60, Math.floor(duration / 1000) % 60];
const durationText = (value, fraction = false) => {
  const [hours, minutes, seconds] = partsFor(Math.max(0, fraction ? Math.floor(value) : Math.ceil(value / 1000) * 1000));
  return `${hours ? `${pad(hours)}:` : ''}${pad(minutes)}:${pad(seconds)}${fraction ? `.${Math.floor(value / 100) % 10}` : ''}`;
};

export function ClockWidgetSettings({ entry, onUse, onBusyChange, onDirtyChange, introduction, internal = false }) {
  const [size, setSize] = useState(entry?.config.size || 'small'), [style, setStyle] = useState(entry?.config.style || 'analog');
  const [zones, setZones] = useState(entry?.config.zones || [...DEFAULT_WORLD_ZONES]);
  const [timeZone, setTimeZone] = useState(entry?.config.timeZone || 'local'), [newZone, setNewZone] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const initial = useRef(JSON.stringify({ size, style, zones, timeZone }));
  useEffect(() => { onDirtyChange?.(initial.current !== JSON.stringify({ size, style, zones, timeZone })); return () => onDirtyChange?.(false); }, [size, style, zones, timeZone, onDirtyChange]);
  return <form className="form-stack widget-config-form" onSubmit={async (event) => {
    event.preventDefault(); if (busy) return;
    setBusy(true); onBusyChange(true); setError('');
    try { await onUse(validateWidgetConfig(CLOCK_WIDGET_ID, { size, style, zones, timeZone }), entry, CLOCK_WIDGET_ID); }
    catch (reason) { setError(reason.message); }
    finally { setBusy(false); onBusyChange(false); }
  }}>
    <div className="settings-scroll form-stack">{introduction}
      {!internal && <Select label={tr("尺寸")} value={size} onChange={setSize} disabled={busy} options={WIDGET_SIZE_OPTIONS} />}
      <Select label={tr("样式")} value={style} onChange={setStyle} disabled={busy} options={[{ value: 'analog', label: tr("指针") }, { value: 'digital', label: tr("数字") }]} />
      <Select label={tr("桌面时区")} value={timeZone} onChange={setTimeZone} disabled={busy} options={[{ value: 'local', label: tr("跟随系统") }, ...[...new Set([...WORLD_ZONES.map((item) => item.value), ...zones, ...(timeZone === 'local' ? [] : [timeZone])])].map((value) => ({ value, label: zoneLabel(value) }))]} />
      <fieldset className="world-zone-settings" disabled={busy}><legend>{tr("世界时钟")}</legend>
        <div className="world-zone-chips">{zones.map((zone) => <Button variant="unstyled" size="unstyled" type="button" key={zone} disabled={zones.length === 1} aria-label={tr("移除{0}", [zoneLabel(zone)])} onClick={() => setZones(zones.filter((item) => item !== zone))}>{zoneLabel(zone)}<X size={12} /></Button>)}</div>
        <Select label={tr("添加城市")} value="" onChange={(value) => { setError(''); setZones((items) => [...items, value]); }} disabled={zones.length >= 8} options={WORLD_ZONES.filter((item) => !zones.includes(item.value))} placeholder={tr("选择城市")} />
        <div className="world-zone-custom"><label>{tr("其他时区")}<Input value={newZone} maxLength={100} placeholder={tr("例如 America/Vancouver")} onChange={(event) => setNewZone(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }} /></label>
          <Button variant="secondary" className="button" type="button" disabled={!newZone.trim() || zones.length >= 8} onClick={() => { try { const value = normalizeTimeZone(newZone.trim()); setZones((items) => items.includes(value) ? items : [...items, value]); setNewZone(''); setError(''); } catch (reason) { setError(reason.message); } }}>{tr("添加")}</Button></div>
      </fieldset>
      {error && <p className="form-error" role="alert">{tr(error)}</p>}
    </div>
    <div className="settings-footer"><Button variant="default" type="submit" className="button primary" disabled={busy}>{entry && !entry.detached ? tr("保存") : tr("使用")}</Button></div>
  </form>;
}

function AnalogClock({ now, core, timeZone }) {
  const { second: seconds, minute: minutes, hour } = zoneParts(now, timeZone), hours = hour % 12;
  return <svg className="analog-clock" viewBox="0 0 100 100" role="img" aria-label={new Date(now).toLocaleTimeString(getLocale(), { timeZone })}>
    <circle className="clock-face" cx="50" cy="50" r="49" />
    {Array.from({ length: 60 }, (_, index) => <line key={index} className={`clock-tick ${index % 5 ? 'clock-tick-minor' : ''}`} x1="50" y1="6" x2="50" y2={index % 5 ? '8' : '12'} transform={`rotate(${index * 6} 50 50)`} />)}
    <g className="clock-numerals" textAnchor="middle"><text x="50" y="23">12</text><text x="79" y="53">3</text><text x="50" y="84">6</text><text x="21" y="53">9</text></g>
    <line className="clock-hand clock-hour" x1="50" y1="53" x2="50" y2="27" transform={`rotate(${core.hour_angle(hours, minutes, seconds)} 50 50)`} />
    <line className="clock-hand clock-minute" x1="50" y1="54" x2="50" y2="15" transform={`rotate(${core.minute_angle(minutes, seconds)} 50 50)`} />
    <line className="clock-hand clock-second" x1="50" y1="58" x2="50" y2="9" transform={`rotate(${core.second_angle(seconds)} 50 50)`} />
    <circle cx="50" cy="50" r="2.5" className="clock-pin" />
  </svg>;
}

export function ClockWidgetPreview() {
  return <figure className="clock-widget-preview" aria-label={tr("数字时钟预览")}><time className="clock-preview-digits">10:09</time></figure>;
}

function ClockDisplay({ now, core, appearance, timeZone, mini = false, decorative = false }) {
  const date = new Date(now);
  return <div className="clock-home" aria-hidden={decorative || undefined}>
    {core && appearance === 'analog' ? <AnalogClock now={now} core={core} timeZone={timeZone} />
      : <time className="clock-digital" dateTime={date.toISOString()}>{date.toLocaleTimeString(getLocale(), { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</time>}
    {!mini && <span className="clock-local-date">{timeZone ? `${zoneLabel(timeZone)} · ` : ''}{date.toLocaleDateString(getLocale(), { timeZone, month: 'short', day: 'numeric', weekday: 'short' })}</span>}
  </div>;
}

function WorldClocks({ zones, now, compare = false }) {
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const options = [...new Set([localZone, 'UTC', ...zones])].map((value) => ({ value, label: zoneLabel(value) }));
  const [reference, setReference] = useState(localZone), [input, setInput] = useState(() => wallInput(now, localZone)), [occurrence, setOccurrence] = useState(0);
  const candidates = compare ? instantsForWall(input, reference) : [now];
  const instant = candidates[Math.min(occurrence, candidates.length - 1)];
  const anchor = instant === undefined ? null : zoneParts(instant, reference);
  return <div className="world-clocks">
    {compare && <div className="time-comparison-fields"><Select label={tr("参考时区")} value={reference} onChange={(value) => { setReference(value); setOccurrence(0); }} options={options} />
      <label>{tr("日期与时间")}<Input type="datetime-local" min="1970-01-01T00:00" max="2100-12-31T23:59" value={input} onChange={(event) => { setInput(event.target.value); setOccurrence(0); }} /></label>
      {candidates.length > 1 && <Select label={tr("重复时间")} value={occurrence} onChange={setOccurrence} options={candidates.map((value, index) => ({ value: index, label: `${index ? tr("第二次") : tr("第一次")} · ${utcOffset(zoneParts(value, reference).offset)}` }))} />}
      {!candidates.length && <p className="form-error" role="alert">{tr("这个时间不存在或日期无效，请调整时间。")}</p>}
      <Button variant="ghost" className="button quiet" type="button" onClick={() => { setInput(wallInput(Date.now(), reference)); setOccurrence(0); }}>{tr("现在")}</Button>
    </div>}
    {anchor && <div className="world-clock-list">{zones.map((zone) => {
      const p = zoneParts(instant, zone), difference = p.offset - anchor.offset;
      const days = Math.round((Date.UTC(p.year, p.month - 1, p.day) - Date.UTC(anchor.year, anchor.month - 1, anchor.day)) / 86400000);
      return <div className="world-clock-row" key={zone}><span><strong>{zoneLabel(zone)}</strong><small>{utcOffset(p.offset)}{difference ? tr(" · {0}{1} 小时", [difference > 0 ? '+' : '−', formatNumber(Math.abs(difference) / 60, { maximumFractionDigits: 3 })]) : tr(" · 无时差")}{days ? tr(" · {0}{1}天", [days > 0 ? '+' : '−', formatNumber(Math.abs(days))]) : ''}</small></span>
        <span className="world-clock-time"><time dateTime={new Date(instant).toISOString()}>{new Date(instant).toLocaleTimeString(getLocale(), { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</time><small>{new Date(instant).toLocaleDateString(getLocale(), { timeZone: zone, month: 'short', day: 'numeric' })}</small></span></div>;
    })}</div>}
  </div>;
}

export default function ClockWidget({ entry, open = false, onOpen, onClose, onSaveConfig, Dialog, portalTarget }) {
  const [state, setState] = useState(emptyClockState), [core, setCore] = useState(null), [now, setNow] = useState(Date.now);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [duration, setDuration] = useState([0, 25, 0]);
  const [configuring, setConfiguring] = useState(false), [configBusy, setConfigBusy] = useState(false), [configDirty, setConfigDirty] = useState(false), [discarding, setDiscarding] = useState(null);
  const close = () => { if (busy || configBusy) return; if (configDirty) setDiscarding('window'); else { setConfiguring(false); onClose(); } };
  const backToClock = () => { if (configBusy) return; if (configDirty) setDiscarding('settings'); else setConfiguring(false); };
  const finishing = useRef(false), mounted = useRef(true);
  const background = supportsClockBackground();
  const timeZone = entry.config.timeZone && entry.config.timeZone !== 'local' ? entry.config.timeZone : undefined;
  const zones = entry.config.zones || DEFAULT_WORLD_ZONES;
  useEffect(() => {
    mounted.current = true;
    const receive = (value) => { if (mounted.current) setState((current) => current.revision > value.revision ? current : value); };
    const off = subscribeClockState(entry.id, receive);
    Promise.all([loadClockCore(), prepareClockState(entry.id)]).then(([kernel, value]) => {
      if (!mounted.current) return; setCore(kernel); receive(value); setReady(true);
    }).catch((reason) => { if (mounted.current) setError(reason.message); });
    return () => { mounted.current = false; off(); };
  }, [entry.id]);
  useEffect(() => setDuration(partsFor(state.duration)), [state.duration]);
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') setNow(Date.now()); };
    const interval = setInterval(tick, open && state.mode === 'stopwatch' && state.stopwatch.running ? 100 : 1000);
    document.addEventListener('visibilitychange', tick); window.addEventListener('focus', tick);
    return () => { clearInterval(interval); document.removeEventListener('visibilitychange', tick); window.removeEventListener('focus', tick); };
  }, [open, state.mode, state.stopwatch.running]);
  useEffect(() => {
    if (!ready || !state.timer.running || finishing.current || now < state.timer.startedAt + state.duration - state.timer.elapsed) return;
    finishing.current = true;
    finishClockTimer(entry.id).then((value) => { if (mounted.current) setState(value); }).catch((reason) => { if (mounted.current) setError(reason.message); })
      .finally(() => { finishing.current = false; });
  }, [now, ready, state.timer.running, state.timer.startedAt, state.timer.elapsed, state.duration, entry.id]);
  async function change(update, permission) {
    if (busy || !ready) return;
    setBusy(true); setError('');
    try {
      if (permission && !await permission) throw Error(tr("请允许通知后再开启提醒。"));
      const value = await updateClockState(entry.id, update);
      if (mounted.current) { setState(value); setNow(Date.now()); }
      return value;
    } catch (reason) { if (mounted.current) setError(reason.message); }
    finally { if (mounted.current) setBusy(false); }
  }
  const elapsed = (timer) => core ? core.elapsed(now, timer.startedAt, timer.elapsed, Number(timer.running)) : 0;
  const remaining = core ? core.remaining(state.duration, elapsed(state.timer)) : state.duration;
  const date = new Date(now), mode = MODES.find((item) => item.id === state.mode);
  function toggleTimer() {
    const milliseconds = duration.reduce((sum, value, index) => sum + Number(value) * [3600000, 60000, 1000][index], 0);
    if (!state.timer.running && (!Number.isFinite(milliseconds) || milliseconds < 1000 || milliseconds > 86400000)) { setError(tr("请选择 1 秒至 24 小时。")); return; }
    change((value) => {
      if (value.timer.running) value.timer = { ...value.timer, elapsed: core.elapsed(Date.now(), value.timer.startedAt, value.timer.elapsed, 1), running: false, startedAt: 0 };
      else {
        if (value.duration !== milliseconds || value.timer.completed) { value.duration = milliseconds; value.timer.elapsed = 0; }
        value.timer = { ...value.timer, startedAt: Date.now(), running: true, completed: false };
      }
      return value;
    });
  }
  const stop = (event) => event.stopPropagation();
  return <>
    <Button variant="unstyled" size="unstyled" type="button" data-widget-launcher data-widget-surface id={`widget-title-${entry.id}`}
      className={`clock-widget clock-widget-${entry.config.size} clock-style-${entry.config.style}`}
      aria-label={tr("{0}，{1}，打开时钟", [builtinName(entry.extensionId, entry.name), date.toLocaleTimeString(getLocale(), { timeZone, hour: '2-digit', minute: '2-digit' })])}
      aria-haspopup="dialog" aria-expanded={open} onClick={onOpen}>
      <ClockDisplay now={now} core={core} appearance={entry.config.style} timeZone={timeZone} mini={entry.config.size === 'mini'} decorative />
    </Button>
    {open && Dialog && portalTarget && createPortal(<div className="clock-dialog-layer" onContextMenu={stop} onKeyDown={stop} onPointerDown={stop} onPointerMove={stop} onPointerUp={stop}>
    <Dialog title={tr("时钟")} className="clock-tools-modal" onClose={close} closeDisabled={busy || configBusy} privacyKeys={[`widget:${entry.id}`]} maximizable>
    <section className={`clock-tools clock-mode-${state.mode}`}>
    <div className="clock-window-settings">{configuring ? <Button type="button" variant="ghost" disabled={configBusy} onClick={backToClock}><ArrowLeft size={16} />{tr('返回')}</Button> : <Button type="button" variant="ghost" size="icon" aria-label={tr('设置')} disabled={busy} onClick={() => setConfiguring(true)}><GearSix size={18} /></Button>}</div>
    {configuring ? <ClockWidgetSettings internal entry={entry} onBusyChange={setConfigBusy} onDirtyChange={setConfigDirty} onUse={async (config) => { await onSaveConfig(config); setConfiguring(false); }} /> : <Tabs value={state.mode} activationMode="manual" onValueChange={(id) => change((value) => ({ ...value, mode: id }))}>
    <TabsList className="clock-modes" aria-label={tr("时钟功能")}>
      {MODES.map(({ id, label, Icon }) => <TabsTrigger value={id} key={id} aria-label={label} title={label}
        id={`clock-mode-${entry.id}-${id}`} aria-controls={`clock-panel-${entry.id}`} disabled={!ready || busy}><Icon size={18} /><span>{label}</span></TabsTrigger>)}
    </TabsList>
    <TabsContent value={state.mode} className="clock-widget-content" id={`clock-panel-${entry.id}`} aria-labelledby={`clock-mode-${entry.id}-${mode.id}`}>
      {state.mode === 'clock' && <ClockDisplay now={now} core={core} appearance={entry.config.style} timeZone={timeZone} />}
      {['world', 'compare'].includes(state.mode) && <WorldClocks key={state.mode} zones={zones} now={now} compare={state.mode === 'compare'} />}
      {state.mode === 'stopwatch' && <div className="clock-measure">
        <output className="clock-digits" aria-label={tr("已计时")}>{durationText(elapsed(state.stopwatch), true)}</output>
        <div className="clock-actions"><Button variant="unstyled" size="unstyled" type="button" aria-label={tr("重置计时")} disabled={!ready || busy} onClick={() => change((value) => ({ ...value, stopwatch: { elapsed: 0, startedAt: 0, running: false } }))}><ArrowCounterClockwise size={19} /></Button>
          <Button variant="unstyled" size="unstyled" type="button" className="clock-primary" aria-label={state.stopwatch.running ? tr("暂停计时") : tr("开始计时")} disabled={!ready || busy} onClick={() => change((value) => {
            value.stopwatch = value.stopwatch.running ? { elapsed: core.elapsed(Date.now(), value.stopwatch.startedAt, value.stopwatch.elapsed, 1), startedAt: 0, running: false }
              : { ...value.stopwatch, startedAt: Date.now(), running: true }; return value;
          })}>{state.stopwatch.running ? <Pause size={20} weight="fill" /> : <Play size={20} weight="fill" />}</Button></div>
      </div>}
      {state.mode === 'countdown' && <div className="clock-measure">
        {state.timer.running || state.timer.elapsed > 0 ? <div className="countdown-display">
          <svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="46" /><circle className="countdown-progress" cx="50" cy="50" r="46" transform="rotate(-90 50 50)" strokeDasharray={`${remaining / state.duration * 289} 289`} /></svg>
          <output className="clock-digits" aria-label={tr("剩余时间")}>{durationText(remaining)}</output>
        </div> : <div className="clock-duration">{[tr("时"), tr("分"), tr("秒")].map((label, index) => <label key={label}><Input type="number" inputMode="numeric" min="0" max={index ? 59 : 24} value={duration[index]} aria-label={tr("倒计时{0}", [label])} disabled={busy || !ready}
          onChange={(event) => setDuration((current) => current.map((value, at) => at === index ? event.target.value === '' ? '' : Math.max(0, Math.min(index ? 59 : 24, Number(event.target.value))) : value))} /><span>{label}</span></label>)}</div>}
        <div className="clock-actions"><Button variant="unstyled" size="unstyled" type="button" aria-label={tr("取消倒计时")} disabled={!ready || busy} onClick={() => change((value) => ({ ...value, timer: { elapsed: 0, startedAt: 0, running: false, completed: false } }))}><ArrowCounterClockwise size={18} /></Button>
          <Button variant="unstyled" size="unstyled" type="button" className="clock-primary" aria-label={state.timer.running ? tr("暂停倒计时") : tr("开始倒计时")} disabled={!ready || busy} onClick={toggleTimer}>{state.timer.running ? <Pause size={20} weight="fill" /> : <Play size={20} weight="fill" />}</Button>
          <label className="clock-notify" title={background ? tr("浏览器运行时通知") : tr("页面打开时提醒")}><Switch aria-label={background ? tr("倒计时通知") : tr("倒计时页面提醒")} checked={state.notify} disabled={!ready || busy} onCheckedChange={(nextChecked) => {
            const checked = nextChecked, permission = checked ? requestClockNotifications() : null;
            change((value) => ({ ...value, notify: checked }), permission);
          }} /><Bell size={16} /></label>
        </div>
        {state.timer.completed && <span className="clock-finished" role="status">{tr("时间到")}</span>}
      </div>}
    </TabsContent>
    </Tabs>}
    {discarding && <Confirm action={tr('放弃修改')} onCancel={() => setDiscarding(null)} onConfirm={() => { const target = discarding; setDiscarding(null); setConfigDirty(false); setConfiguring(false); if (target === 'window') onClose(); }}>{tr('当前内容尚未保存，放弃修改？')}</Confirm>}
    {error && <p className="clock-error" role="alert">{tr(error)}</p>}
    </section>
    </Dialog>
    </div>, portalTarget)}
  </>;
}

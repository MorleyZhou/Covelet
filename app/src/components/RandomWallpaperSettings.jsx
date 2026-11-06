import { useState } from 'react';
import { formatNumber, tr } from '../i18n/index.js';
import { requestSiteAccess } from '../lib/site-info.js';
import { userErrorMessage } from '../lib/user-error.js';
import { WALLPAPER_INTERVALS, WALLPAPER_SOURCES } from '../lib/wallpaper.js';
import Select from './Select.jsx';
import { Button } from './ui/button.jsx';

export default function RandomWallpaperSettings({ source, interval, active, wallpaper, disabled, onApply, onDisable, onIntervalChange }) {
  const [selected, setSelected] = useState(source || 'bing');
  const [busy, setBusy] = useState(false), [feedback, setFeedback] = useState(null);
  const current = active && selected === source;

  async function run(action, message, fallback = tr('暂时无法更新壁纸，请重试。')) {
    setBusy(true); setFeedback(null);
    try { await action(); if (message) setFeedback({ message }); }
    catch (reason) { setFeedback({ error: true, message: userErrorMessage(reason, fallback) }); }
    finally { setBusy(false); }
  }

  function apply() {
    const provider = WALLPAPER_SOURCES.find(item => item.id === selected);
    const permission = provider.id === 'bing' ? Promise.resolve(true) : requestSiteAccess(provider.origin);
    run(async () => {
      if (!await permission) throw Error(tr('未获得壁纸源的访问权限。'));
      await onApply(provider.id);
    }, tr('已更换壁纸。'));
  }

  return <div className="random-wallpaper-settings form-stack">
    <Select label={tr('壁纸源')} value={selected} disabled={busy || disabled} onChange={value => { setSelected(value); setFeedback(null); }}
      options={WALLPAPER_SOURCES.map(provider => ({ value: provider.id, label: provider.label }))} />
    <Select label={tr('自动更换间隔')} value={interval} disabled={busy || disabled}
      onChange={value => run(() => onIntervalChange(value), '', tr('设置未保存，请重试。'))}
      options={WALLPAPER_INTERVALS.map(({ id, amount, unit }) => ({ value: id, label: formatNumber(amount, { style: 'unit', unit, unitDisplay: 'long' }) }))} />
    {current && wallpaper?.source === source && wallpaper.url?.startsWith('blob:') && <figure className="random-wallpaper-preview">
      <img src={wallpaper.url} alt="" referrerPolicy="no-referrer" />
      {wallpaper.copyright && wallpaper.copyrightUrl && <figcaption><a href={wallpaper.copyrightUrl} target="_blank" rel="noopener noreferrer">{wallpaper.copyright}</a></figcaption>}
    </figure>}
    <div className="random-wallpaper-actions">
      {active && <Button type="button" variant="ghost" disabled={busy || disabled} onClick={() => run(onDisable, tr('已关闭随机壁纸。'))}>{tr('关闭随机壁纸')}</Button>}
      <Button type="button" disabled={busy || disabled} onClick={apply}>{busy ? tr('正在更新壁纸…') : current ? tr('换一张') : tr('设为背景')}</Button>
    </div>
    <p className={feedback?.error ? 'form-error' : 'hint'} role="status">{feedback?.message || ''}</p>
  </div>;
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { tr } from '../i18n/index.js';
import * as firefoxConsent from '../lib/firefox-data-consent.js';
import { Button } from './ui/button.jsx';
import './firefox-data-consent.css';

export function useFirefoxDataConsentState(api = firefoxConsent) {
  const firefox = api.isFirefoxDataConsentRuntime(), [state, setState] = useState(null);
  const active = useRef(true), generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!firefox) return;
    const request = ++generation.current;
    setState(null);
    let value;
    try { value = await api.getFirefoxDataConsent(); }
    catch { value = { firefox: true, supported: false, granted: [], missing: [...api.FIREFOX_DATA_COLLECTION_TYPES] }; }
    if (active.current && request === generation.current) setState(value);
  }, [api, firefox]);
  useEffect(() => {
    active.current = true;
    if (!firefox) return () => { active.current = false; generation.current++; };
    refresh();
    const unsubscribe = api.subscribeFirefoxDataConsent(refresh);
    globalThis.addEventListener?.('focus', refresh);
    return () => { active.current = false; generation.current++; unsubscribe(); globalThis.removeEventListener?.('focus', refresh); };
  }, [api, firefox, refresh]);
  return { firefox, state, refresh, allows: purpose => !firefox || Boolean(state?.supported && api.FIREFOX_DATA_PURPOSES[purpose].every(type => state.granted.includes(type))) };
}
const purposes = () => [
  { id: 'search', keys: ['search'], title: tr('网页搜索'), detail: tr('向你选择的搜索引擎发送搜索词。') },
  { id: 'reading', keys: ['site', 'reading', 'rss'], title: tr('网站、阅读与 RSS'), detail: tr('向你选择的网站、图片或订阅来源发送请求，读取网页、图片和订阅内容。') },
  { id: 'cloud', keys: ['cloud'], title: tr('自备存储同步'), detail: tr('向你配置的存储发送加密内容、认证信息及所需连接信息。') },
  { id: 'github', keys: ['github'], title: tr('GitHub 贡献日历'), detail: tr('向 GitHub 发送所选用户名，读取公开贡献日历。') },
  { id: 'wallpaper', keys: ['wallpaper'], title: tr('随机壁纸'), detail: tr('向所选壁纸来源请求图片及授权信息。') },
];
const dataLabels = () => ({ searchTerms: tr('搜索词'), browsingActivity: tr('网站地址'), websiteContent: tr('网页与图片内容'),
  authenticationInfo: tr('认证信息'), personallyIdentifyingInfo: tr('用户名等身份信息'), technicalAndInteraction: tr('连接与技术信息') });

export function FirefoxDataConsentNotice({ onOpen, disabled = false, api = firefoxConsent }) {
  const { firefox, state } = useFirefoxDataConsentState(api);
  if (!firefox || !state || state.granted.length) return null;
  return <aside className="firefox-data-notice" aria-label={tr('Firefox 联网授权')}>
    <span>{tr('联网功能需要你选择授权，本机功能可直接使用。')}</span>
    <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onOpen}>{tr('管理 Firefox 联网授权')}</Button>
  </aside>;
}

export default function FirefoxDataConsent({ disabled = false, api = firefoxConsent }) {
  const { firefox, state, refresh } = useFirefoxDataConsentState(api), [busy, setBusy] = useState(null), [message, setMessage] = useState('');
  const active = useRef(true), working = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  if (!firefox) return null;
  const labels = dataLabels();
  function request(group, types) {
    if (disabled || working.current || !state?.supported) return;
    let result;
    // Firefox's native request must run in this direct button gesture.
    try { result = api.requestFirefoxDataConsent(types); }
    catch { setMessage(tr('未授予此项授权；本机内容、便笺和手动备份仍可使用。')); return; }
    working.current = true; setBusy(group.id); setMessage('');
    Promise.resolve(result).then(async granted => {
      if (!active.current) return;
      if (!granted) setMessage(tr('未授予此项授权；本机内容、便笺和手动备份仍可使用。'));
      await refresh();
    }).catch(() => { if (active.current) setMessage(tr('未授予此项授权；本机内容、便笺和手动备份仍可使用。')); })
      .finally(() => { working.current = false; if (active.current) setBusy(null); });
  }
  return <section className="firefox-data-consent" aria-labelledby="firefox-data-consent-title" aria-busy={Boolean(busy)}>
    <h3 id="firefox-data-consent-title">{tr('Firefox 联网授权')}</h3>
    <p>{tr('按需要选择联网功能。拒绝授权不会影响本机内容、便笺和手动备份。')}</p>
    <p className="hint">{tr('这些数据用于你选择的功能，不用于广告或使用统计。Firefox 按数据类型授权，不同功能可能共用授权；网站访问权限仍需另外授予。')}</p>
    {!state ? <p role="status">{tr('正在读取 Firefox 数据授权…')}</p> : !state.supported ? <p className="form-error" role="alert">{tr('当前 Firefox 无法管理数据授权，请更新浏览器。本机功能仍可使用。')}</p> : <div className="firefox-data-groups">
      {purposes().map(group => {
        const types = [...new Set(group.keys.flatMap(key => api.FIREFOX_DATA_PURPOSES[key]))], granted = types.every(type => state.granted.includes(type));
        return <div className="firefox-data-group" key={group.id} data-purpose={group.id}>
          <div><h4>{group.title}</h4><p>{group.detail}</p><p className="hint">{tr('涉及：{0}', [types.map(type => labels[type]).join(' / ')])}</p></div>
          <Button type="button" variant="secondary" disabled={disabled || Boolean(busy) || granted} aria-label={tr('允许 {0} 联网', [group.title])}
            onClick={() => request(group, types)}>{busy === group.id ? tr('正在请求授权…') : granted ? tr('已允许') : tr('允许此功能联网')}</Button>
        </div>;
      })}
    </div>}
    {message && <p className="hint" role="status">{message}</p>}
    <p className="hint">{tr('可在 Firefox 的 about:addons → Covelet → 权限中撤销数据授权。')}</p>
  </section>;
}

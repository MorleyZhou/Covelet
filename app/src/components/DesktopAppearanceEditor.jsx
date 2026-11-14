import { useEffect, useRef, useState } from 'react';
import { tr } from '../i18n/index.js';
import { prepareDesktopAppearance, effectiveDesktopAppearance } from '../lib/desktop-appearance.js';
import { userErrorMessage } from '../lib/user-error.js';
import { sameJson } from '../lib/json-equal.js';
import { logicalDesktopPages } from '../lib/desktop-pages.js';
import BackgroundPicker from './BackgroundPicker.jsx';
import Select from './Select.jsx';
import { Checkbox } from './ui/checkbox.jsx';
import { Button } from './ui/button.jsx';

export default function DesktopAppearanceEditor({ state, target, readPreferences, writePreferences, beforeOperation, onSaved, onBusyChange, onDirtyChange, Range }) {
  const [baseline, setBaseline] = useState(target.state);
  const [draft, setDraft] = useState(() => structuredClone(target.state.settings.desktopPages?.[target.page]?.appearance || {}));
  const [identity, setIdentity] = useState({ id: target.id, page: target.page });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const working = useRef(false);
  const original = baseline.settings.desktopPages?.[identity.page]?.appearance || {};
  const stale = state.revision !== baseline.revision;
  const dirty = !sameJson(draft, original);
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  const effective = effectiveDesktopAppearance({ ...baseline.settings, desktopPages: {
    ...baseline.settings.desktopPages, [identity.page]: { ...(baseline.settings.desktopPages?.[identity.page] || {}), appearance: draft },
  } }, identity.page);
  function patch(key, value) { setDraft((current) => { const next = { ...current }; if (value === null) delete next[key]; else next[key] = value; return next; }); setError(''); }
  async function run(action) {
    if (working.current) return;
    working.current = true; setBusy(true); onBusyChange?.(true); setError('');
    try { await beforeOperation(); await action(); }
    catch (reason) { setError(userErrorMessage(reason)); }
    finally { working.current = false; setBusy(false); onBusyChange?.(false); }
  }
  async function save() {
    if (stale || !dirty) return;
    await run(async () => {
      const latest = await readPreferences();
      const changes = Object.fromEntries(['background', 'shade', 'blur'].map((key) => [key, draft[key] ?? null]));
      const prepared = prepareDesktopAppearance(latest, identity.id, changes, { expectedNavigationRevision: baseline.revision, page: identity.page });
      const saved = prepared.changed ? await writePreferences(prepared.state, prepared.sourceRevision) : prepared.state;
      setBaseline(saved); setIdentity({ id: prepared.desktopId, page: prepared.page });
      setDraft(structuredClone(saved.settings.desktopPages?.[prepared.page]?.appearance || {}));
      await onSaved(saved, { id: prepared.desktopId, page: prepared.page });
    });
  }
  return <div className="desktop-appearance-editor form-stack" aria-busy={busy || undefined}>
    <fieldset className="form-stack desktop-appearance-fields" disabled={busy || stale}>
      <Select label={tr('桌面背景')} disabled={busy || stale} value={!draft.background ? 'inherit' : ['color', 'gradient'].includes(draft.background.kind) ? 'color' : draft.background.kind}
        options={[{ value: 'inherit', label: tr('继承全局背景') }, { value: 'builtin', label: tr('内置背景') }, { value: 'color', label: tr('颜色') }, { value: 'bing', label: tr('随机壁纸') }]}
        onChange={(kind) => patch('background', kind === 'inherit' ? null : kind === 'builtin' ? { kind, value: 'alpine' }
          : kind === 'bing' ? { kind, value: 'daily' } : ['color', 'gradient'].includes(effective.background.kind) ? effective.background : { kind: 'color', value: '#20252b' })} />
      {draft.background && ['color', 'gradient'].includes(draft.background.kind) && <BackgroundPicker value={draft.background} onChange={(background) => patch('background', background)} />}
      {effective.background.kind === 'bing' && <p className="hint">{tr('随机背景共享本机的照片、来源和轮换周期。')}</p>}
      <label className="check-label"><Checkbox checked={!Object.hasOwn(draft, 'shade')} onCheckedChange={(checked) => patch('shade', checked === true ? null : effective.shade)} />{tr('继承全局遮罩')}</label>
      <Range label={tr('背景变暗')} value={effective.shade} min={0} max={90} suffix="%" disabled={busy || stale || !Object.hasOwn(draft, 'shade')} onChange={(shade) => patch('shade', shade)} />
      <label className="check-label"><Checkbox checked={!Object.hasOwn(draft, 'blur')} onCheckedChange={(checked) => patch('blur', checked === true ? null : effective.blur)} />{tr('继承全局模糊')}</label>
      <Range label={tr('背景模糊')} value={effective.blur} min={0} max={40} suffix="px" disabled={busy || stale || !Object.hasOwn(draft, 'blur')} onChange={(blur) => patch('blur', blur)} />
    </fieldset>
    {(stale || error) && <p className="form-error" role="alert">{stale ? tr('桌面已变化，请重新载入外观后再保存。') : error}</p>}
    <div className="desktop-appearance-actions">
      <Button type="button" variant="secondary" disabled={busy || stale || !Object.keys(draft).length} onClick={() => { setDraft({}); setError(''); }}>{tr('全部继承全局')}</Button>
      <Button type="button" disabled={busy || stale || !dirty} onClick={save}>{tr('保存桌面外观')}</Button>
      {(stale || dirty) && <Button type="button" variant="ghost" disabled={busy} onClick={() => run(async () => {
        const latest = await readPreferences();
        const found = identity.id ? Object.entries(latest.settings.desktopPages || {}).find(([, value]) => value.id === identity.id) : [identity.page];
        if (!found || !logicalDesktopPages(latest).includes(Number(found[0]))) throw Error(tr('这一屏已发生变化，请重新打开屏幕管理。'));
        const page = Number(found[0]); setBaseline(latest); setIdentity({ page, id: latest.settings.desktopPages?.[page]?.id || null });
        setDraft(structuredClone(latest.settings.desktopPages?.[page]?.appearance || {}));
        await onSaved(latest, { page, id: latest.settings.desktopPages?.[page]?.id || null });
      })}>{tr('放弃修改并重新载入')}</Button>}
    </div>
  </div>;
}

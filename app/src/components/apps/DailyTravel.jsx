import { useEffect, useMemo, useRef, useState } from 'react';
import { DownloadSimple, Plus, Trash, X, PencilSimple, MapPin, Airplane, Bed, Ticket } from '@phosphor-icons/react';
import { TRAVEL_DEFAULTS, normalizeTrip, normalizeTripItem, upsertRecord, removeRecord, appId, dateKey } from '../../lib/daily-apps.js';
import { useDailyData, useDirty, DailyError, DeletePrompt, DiscardPrompt, TextArea, Loading, tr, Button, Input, Select, Field, downloadBlob } from './DailyShared.jsx';

const tripBlank = () => ({ title: '', startDate: '', endDate: '', notes: '', items: [] });
const itemBlank = (trip, date) => ({ type: 'place', title: '', date: date || trip?.startDate || dateKey(), time: '', address: '', reference: '', url: '', notes: '', attachments: [] });
const types = () => [{ value: 'place', label: tr('地点') }, { value: 'transport', label: tr('交通') }, { value: 'stay', label: tr('住宿') }, { value: 'booking', label: tr('预订') }];
const typeIcon = { place: MapPin, transport: Airplane, stay: Bed, booking: Ticket };
function shiftDate(input, count) { const [y, m, d] = input.split('-').map(Number); return dateKey(new Date(y, m - 1, d + count, 12)); }
function withinTrip(trip, date) { return trip.startDate && date < trip.startDate ? trip.startDate : trip.endDate && date > trip.endDate ? trip.endDate : date; }

export default function TravelApp(props) {
  const { data, update, loading, error, action, unavailable } = useDailyData('travel', TRAVEL_DEFAULTS, props);
  const [selectedId, setSelectedId] = useState(null), [date, setDate] = useState(dateKey), [query, setQuery] = useState('');
  const [draft, setDraft] = useState(null), [dirty, setDirty] = useState(false), [item, setItem] = useState(null), [itemDirty, setItemDirty] = useState(false);
  const [deleting, setDeleting] = useState(null), [pending, setPending] = useState(null);
  useDirty(dirty || itemDirty, props.onDirtyChange);
  const trips = data?.trips || [], currentTrip = trips.find((trip) => trip.id === selectedId);
  useEffect(() => { if (!unavailable && !currentTrip && !draft && !itemDirty && trips.length) { const today = dateKey(), next = trips.find((trip) => (!trip.startDate || trip.startDate <= today) && (!trip.endDate || trip.endDate >= today)) || [...trips].filter((trip) => trip.startDate >= today).sort((a, b) => a.startDate.localeCompare(b.startDate))[0] || trips[0]; setSelectedId(next.id); setDate(withinTrip(next, today)); } }, [trips, currentTrip, draft, itemDirty, unavailable]);
  const records = useMemo(() => [...(currentTrip?.items || [])].filter((entry) => entry.date === date).sort((a, b) => a.time.localeCompare(b.time)), [currentTrip, date]);
  const firstDay = currentTrip ? withinTrip(currentTrip, shiftDate(date, -3)) : date;
  const days = Array.from({ length: 7 }, (_, index) => shiftDate(firstDay, index)).filter((day) => !currentTrip?.endDate || day <= currentTrip.endDate);
  const selectTrip = (trip) => { setSelectedId(trip?.id || null); if (trip) setDate(withinTrip(trip, dateKey())); setDraft(null); setDirty(false); setItem(null); setItemDirty(false); };
  const initialTargetApplied = useRef(false);
  useEffect(() => {
    if (unavailable || loading || initialTargetApplied.current) return;
    initialTargetApplied.current = true;
    const trip = trips.find((entry) => entry.id === props.initialContext?.tripId);
    if (trip) {
      selectTrip(trip);
      const entry = trip.items.find((record) => record.id === props.initialContext?.itemId);
      if (entry) setDate(withinTrip(trip, entry.date));
    }
  }, [unavailable, loading, trips, props.initialContext]);
  const perform = (target) => {
    setDraft(null); setDirty(false); setItem(null); setItemDirty(false);
    if (target.kind === 'trip') selectTrip(target.trip);
    else if (target.kind === 'date') setDate(target.date);
    else if (target.kind === 'trip-edit') setDraft(target.trip ? structuredClone(target.trip) : tripBlank());
    else if (target.kind === 'item-edit') setItem(target.item ? structuredClone(target.item) : itemBlank(currentTrip, date));
  };
  const request = (target) => dirty || itemDirty ? setPending(target) : perform(target);
  const patchTrip = (value) => { setDraft((previous) => ({ ...previous, ...value })); setDirty(true); };
  const patchItem = (value) => { setItem((previous) => ({ ...previous, ...value })); setItemDirty(true); };
  async function saveItem() {
    if (!currentTrip || !item) return;
    const value = normalizeTripItem(item, currentTrip), expected = item.id ? item.revision : null;
    await update((latest) => {
      const trip = latest.trips.find((entry) => entry.id === currentTrip.id); if (!trip) throw Error(tr('行程已被移除。'));
      const checked = normalizeTripItem(value, trip), result = upsertRecord(trip.items, checked, expected, 500);
      return { ...latest, trips: latest.trips.map((entry) => entry.id === trip.id ? { ...entry, items: result.records, revision: entry.revision + 1, updatedAt: Date.now() } : entry) };
    }); setDate(value.date); setItem(null); setItemDirty(false);
  }
  return <div className="app-workspace daily-travel" aria-busy={loading || action.busy}>
    <DailyError error={error} action={action} /><Loading loading={loading} />
    <fieldset className="daily-content" disabled={unavailable || action.busy}>
      <div className={`travel-workspace ${draft || item ? 'has-editor' : ''}`}>
        <aside className="travel-navigation"><div className="app-toolbar"><h3>{tr('行程列表')}</h3><Button type="button" variant="ghost" size="icon" aria-label={tr('新行程')} onClick={() => request({ kind: 'trip-edit' })}><Plus size={19} /></Button></div><Input type="search" aria-label={tr('搜索行程')} placeholder={tr('搜索行程')} value={query} onChange={(event) => setQuery(event.target.value)} />
          <section className="travel-trip-list" aria-label={tr('行程列表')}>{trips.filter((trip) => !query || `${trip.title}\n${trip.notes}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map((trip) => <Button key={trip.id} type="button" className="daily-record-title" variant={selectedId === trip.id ? 'secondary' : 'ghost'} onClick={() => request({ kind: 'trip', trip })}><strong>{trip.title}</strong><small>{[trip.startDate, trip.endDate].filter(Boolean).join(' — ')}</small><small>{tr('{0} 项安排', [trip.items.length])}</small></Button>)}</section>
        </aside>
        {currentTrip ? <section className="travel-itinerary"><header className="travel-heading"><div><h2>{currentTrip.title}</h2><p>{[currentTrip.startDate, currentTrip.endDate].filter(Boolean).join(' — ')}</p></div><div className="app-toolbar"><Button type="button" variant="ghost" size="icon" aria-label={tr('行程设置')} onClick={() => request({ kind: 'trip-edit', trip: currentTrip })}><PencilSimple size={18} /></Button><Button type="button" onClick={() => request({ kind: 'item-edit' })}><Plus size={17} />{tr('添加安排')}</Button></div></header>
          <div className="travel-date-navigation"><div className="travel-date-strip" role="group" aria-label={tr('选择日期')}>{days.map((day) => <Button type="button" key={day} aria-pressed={date === day} variant={date === day ? 'secondary' : 'ghost'} onClick={() => request({ kind: 'date', date: day })}><small>{new Intl.DateTimeFormat(document.documentElement.lang || undefined, { weekday: 'short' }).format(new Date(`${day}T12:00:00`))}</small><strong>{Number(day.slice(-2))}</strong></Button>)}</div><Input type="date" aria-label={tr('选择日期')} value={date} min={currentTrip.startDate || undefined} max={currentTrip.endDate || undefined} onChange={(event) => { if (event.target.value) request({ kind: 'date', date: withinTrip(currentTrip, event.target.value) }); }} /></div>
          <div className="travel-day-heading"><h3>{date}</h3><span>{tr('{0} 项安排', [records.length])}</span></div>
          <div className="travel-timeline">{records.map((entry) => { const Icon = typeIcon[entry.type] || MapPin; return <article className="travel-timeline-entry" key={entry.id}><div className="travel-time"><time>{entry.time || '—'}</time><Icon size={18} /></div><div className="travel-stop"><header><Button type="button" variant="ghost" className="travel-stop-title" onClick={() => request({ kind: 'item-edit', item: entry })}><small>{types().find((type) => type.value === entry.type)?.label}</small><h4>{entry.title}</h4></Button><div className="app-toolbar"><Button type="button" variant="ghost" size="icon" aria-label={tr('编辑')} onClick={() => request({ kind: 'item-edit', item: entry })}><PencilSimple size={16} /></Button><Button type="button" variant="ghost" size="icon" aria-label={tr('删除')} onClick={() => setDeleting({ ...entry, kind: 'item' })}><Trash size={15} /></Button></div></header>{entry.address && <p>{entry.address}</p>}{entry.reference && <p className="app-muted">{tr('预订编号：{0}', [entry.reference])}</p>}{entry.notes && <p className="daily-preserve-lines">{entry.notes}</p>}<div className="travel-attachments">{entry.url && <a href={entry.url} target="_blank" rel="noopener noreferrer">{tr('打开网址')}</a>}{entry.attachments.map((attachment) => <Button key={attachment.id} type="button" variant="secondary" onClick={() => action.run(() => downloadBlob(attachment.blob, attachment.name))}><DownloadSimple size={16} /><span>{attachment.name}</span></Button>)}</div></div></article>; })}{!records.length && <div className="travel-empty-day"><MapPin size={34} /><h3>{tr('当天没有安排')}</h3><Button type="button" variant="secondary" onClick={() => request({ kind: 'item-edit' })}>{tr('添加安排')}</Button></div>}</div>
          {currentTrip.notes && <div className="travel-trip-notes"><h3>{tr('行程备注')}</h3><p className="daily-preserve-lines">{currentTrip.notes}</p></div>}
        </section> : <section className="travel-empty"><Airplane size={42} /><h2>{tr('整理下一次旅行的安排')}</h2><Button type="button" onClick={() => request({ kind: 'trip-edit' })}>{tr('新行程')}</Button></section>}
        {draft && <aside className="travel-editor" aria-label={tr('行程设置')}><form className="app-form" onSubmit={(event) => { event.preventDefault(); action.run(async () => {
          const value = normalizeTrip(draft); let saved;
          await update((latest) => { const old = latest.trips.find((entry) => entry.id === draft.id), changed = { ...value, items: old?.items || [] }; for (const entry of changed.items) normalizeTripItem(entry, changed); const result = upsertRecord(latest.trips, changed, draft.id ? draft.revision : null, 100); saved = result.saved; return { ...latest, trips: result.records }; }); selectTrip(saved);
        }); }}><header className="daily-pane-heading"><h3>{draft.id ? tr('行程设置') : tr('新行程')}</h3><Button type="button" variant="ghost" size="icon" aria-label={tr('关闭编辑')} onClick={() => request({ kind: 'close' })}><X size={18} /></Button></header>
          <div className="daily-editor-scroll"><Field label={tr('行程名称')}><Input autoFocus required maxLength={200} value={draft.title} onChange={(event) => patchTrip({ title: event.target.value })} /></Field><div className="app-grid"><Field label={tr('开始日期')}><Input type="date" value={draft.startDate} onChange={(event) => patchTrip({ startDate: event.target.value })} /></Field><Field label={tr('结束日期')}><Input type="date" value={draft.endDate} onChange={(event) => patchTrip({ endDate: event.target.value })} /></Field></div><TextArea label={tr('行程备注')} rows={5} value={draft.notes} maxLength={20000} onChange={(event) => patchTrip({ notes: event.target.value })} /></div><div className="app-toolbar travel-editor-actions">{draft.id && <Button type="button" variant="ghost" onClick={() => setDeleting({ ...currentTrip, kind: 'trip' })}><Trash size={16} />{tr('删除行程')}</Button>}<Button type="submit" disabled={!dirty || !draft.title.trim()}>{tr('保存行程')}</Button></div>
        </form></aside>}
        {item && currentTrip && <aside className="travel-editor" aria-label={tr('每日安排')}><form className="app-form" onSubmit={(event) => { event.preventDefault(); action.run(saveItem); }}><header className="daily-pane-heading"><h3>{item.id ? tr('编辑') : tr('添加安排')}</h3><Button type="button" variant="ghost" size="icon" aria-label={tr('关闭编辑')} onClick={() => request({ kind: 'close' })}><X size={18} /></Button></header>
          <div className="daily-editor-scroll"><Select label={tr('类型')} value={item.type} onChange={(type) => patchItem({ type })} options={types()} /><Field label={tr('名称')}><Input autoFocus required value={item.title} maxLength={300} onChange={(event) => patchItem({ title: event.target.value })} /></Field><div className="app-grid"><Field label={tr('日期')}><Input required type="date" min={currentTrip.startDate || undefined} max={currentTrip.endDate || undefined} value={item.date} onChange={(event) => patchItem({ date: event.target.value })} /></Field><Field label={tr('时间')}><Input type="time" value={item.time} onChange={(event) => patchItem({ time: event.target.value })} /></Field></div><Field label={tr('地点或地址')}><Input value={item.address} maxLength={1000} onChange={(event) => patchItem({ address: event.target.value })} /></Field>
          {item.type !== 'place' && <Field label={tr('预订编号')}><Input value={item.reference} maxLength={500} onChange={(event) => patchItem({ reference: event.target.value })} /></Field>}<Field label={tr('相关网址')}><Input type="url" value={item.url} maxLength={4096} onChange={(event) => patchItem({ url: event.target.value })} /></Field><TextArea label={tr('安排备注')} rows={3} value={item.notes} maxLength={10000} onChange={(event) => patchItem({ notes: event.target.value })} />
          <Field label={tr('预订凭证')}><Input type="file" accept="image/png,image/jpeg,image/webp,application/pdf,text/plain" multiple disabled={item.attachments.length >= 8} onChange={(event) => { const files = [...(event.target.files || [])]; event.target.value = ''; action.run(() => { if (files.some((file) => file.size > 5 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain'].includes(file.type)) || item.attachments.length + files.length > 8) throw Error(tr('附件仅支持图片、PDF 或文本，每个不超过 5 MB。')); const attachments = [...item.attachments, ...files.map((file) => ({ id: appId(), name: file.name.slice(0, 200), blob: file.slice(0, file.size, file.type) }))]; if (attachments.reduce((total, entry) => total + entry.blob.size, 0) > 20 * 1024 * 1024) throw Error(tr('附件总大小不能超过 20 MB。')); patchItem({ attachments }); }); }} /></Field>
          {item.attachments.map((entry) => <div className="app-toolbar travel-attachment-row" key={entry.id}><span>{entry.name}</span><Button type="button" variant="ghost" size="icon" aria-label={tr('移除附件')} onClick={() => patchItem({ attachments: item.attachments.filter((file) => file.id !== entry.id) })}><Trash size={15} /></Button></div>)}</div><div className="app-toolbar travel-editor-actions"><Button type="button" variant="ghost" onClick={() => request({ kind: 'close' })}>{tr('取消')}</Button><Button type="submit" disabled={!itemDirty || !item.title.trim()}>{tr('保存安排')}</Button></div>
        </form></aside>}
      </div>
    </fieldset>
    <DiscardPrompt pending={pending} onCancel={() => setPending(null)} onConfirm={() => { const target = pending; setPending(null); perform(target); }} />
    <DeletePrompt target={deleting} action={action} title={deleting?.kind === 'trip' ? tr('删除“{0}”及其中的全部安排和凭证？', [deleting.title]) : undefined} onCancel={() => setDeleting(null)} onConfirm={() => action.run(async () => {
      await update((latest) => { if (deleting.kind === 'trip') return { ...latest, trips: removeRecord(latest.trips, deleting.id, deleting.revision) }; const trip = latest.trips.find((entry) => entry.id === currentTrip?.id); if (!trip) throw Error(tr('行程已被移除。')); return { ...latest, trips: latest.trips.map((entry) => entry.id === trip.id ? { ...entry, items: removeRecord(entry.items, deleting.id, deleting.revision), revision: entry.revision + 1, updatedAt: Date.now() } : entry) }; });
      if (deleting.kind === 'trip') selectTrip(null); else if (item?.id === deleting.id) { setItem(null); setItemDirty(false); } setDeleting(null);
    })} />
  </div>;
}

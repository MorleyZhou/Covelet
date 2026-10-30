import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Plus, Star, Sun, Trash, X, DotsThree } from '@phosphor-icons/react';
import { Checkbox } from '../ui/checkbox.jsx';
import { TASK_DEFAULTS, TASK_REPEATS, appId, dateKey, normalizeTask, upsertRecord, removeRecord, toggleTask, boundedText } from '../../lib/daily-apps.js';
import { useDailyData, useDirty, DailyError, DeletePrompt, DiscardPrompt, TextArea, Loading, tr, Button, Input, Select, Field, shortDate } from './DailyShared.jsx';

const emptyTask = (listId = 'inbox') => ({ title: '', listId, important: false, myDay: '', dueDate: '', remindAt: '', repeat: 'none', notes: '', steps: [] });
const repeatLabels = () => [tr('不重复'), tr('每天'), tr('工作日'), tr('每周'), tr('每月')];
function localDateTime(iso) {
  if (!iso) return '';
  const date = new Date(iso); return `${dateKey(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
export default function TasksApp(props) {
  const { data, update, loading, error, action, unavailable } = useDailyData('tasks', TASK_DEFAULTS, props);
  const [view, setView] = useState('my-day'), [query, setQuery] = useState(''), [draft, setDraft] = useState(null), [dirty, setDirty] = useState(false);
  const [quickTitle, setQuickTitle] = useState(''), quickInput = useRef(null);
  const [deleting, setDeleting] = useState(null), [pending, setPending] = useState(null), [listName, setListName] = useState(''), [listManager, setListManager] = useState(false);
  const [newStep, setNewStep] = useState(''), [incoming, setIncoming] = useState([]), [incomingApplied, setIncomingApplied] = useState(false);
  const today = dateKey(), tasks = data?.tasks || [], lists = data?.lists || [], history = data?.history || [];
  useDirty(dirty || Boolean(listName.trim()) || Boolean(newStep.trim()) || Boolean(quickTitle.trim()), props.onDirtyChange);
  useEffect(() => { setIncoming((props.initialContext?.tasks || []).slice(0, 100).map((item) => ({ title: String(item.title || '').slice(0, 300) })).filter((item) => item.title.trim())); setIncomingApplied(false); }, [props.initialContext]);
  const select = (item) => { setDraft(item ? structuredClone(item) : null); setNewStep(''); setDirty(false); };
  const choose = (item) => dirty || newStep.trim() ? setPending({ item }) : select(item);
  const initialTargetApplied = useRef(false);
  useEffect(() => {
    if (unavailable || loading || initialTargetApplied.current) return;
    initialTargetApplied.current = true;
    const task = tasks.find((item) => item.id === props.initialContext?.taskId);
    if (task) { setView(task.completed ? 'completed' : 'all'); setQuery(''); select(task); }
  }, [unavailable, loading, tasks, props.initialContext]);
  const patch = (value) => { setDraft((current) => ({ ...current, ...value })); setDirty(true); };
  const matches = useMemo(() => tasks.filter((item) => {
    if (query && !`${item.title}\n${item.notes}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) return false;
    if (view === 'completed') return item.completed;
    if (item.completed) return false;
    if (view === 'my-day' && item.myDay !== today) return false;
    if (view === 'important' && !item.important) return false;
    if (view === 'planned' && !item.dueDate) return false;
    if (view.startsWith('list:') && item.listId !== view.slice(5)) return false;
    return true;
  }).sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || Number(b.important) - Number(a.important)), [tasks, view, query, today]);
  async function quickPatch(id, value) {
    await update((current) => ({ ...current, tasks: current.tasks.map((item) => item.id === id ? { ...item, ...value, revision: item.revision + 1, updatedAt: Date.now() } : item) }));
    if (draft?.id === id && !dirty) setDraft((current) => ({ ...current, ...value, revision: current.revision + 1 }));
  }
  async function enableNotifications() {
    const permission = globalThis.chrome?.permissions;
    if (!permission || !await permission.request({ permissions: ['notifications'] })) throw Error(tr('需要允许通知，才能接收任务提醒。'));
    await update((current) => ({ ...current, notifications: true }));
  }
  const views = [
    ['my-day', tr('我的一天')], ['important', tr('重要')], ['planned', tr('计划内')], ['all', tr('全部任务')], ['completed', tr('已完成')], ['history', tr('完成记录')],
    ...lists.map((item) => [`list:${item.id}`, item.name || tr('任务清单')]),
  ];
  const currentTitle = views.find(([id]) => id === view)?.[1] || tr('任务清单');
  const focusQuick = () => { if (['completed', 'history'].includes(view)) setView('all'); setTimeout(() => quickInput.current?.focus(), 0); };
  const openAdvanced = () => {
    const item = { ...emptyTask(view.startsWith('list:') ? view.slice(5) : 'inbox'), title: quickTitle, myDay: view === 'my-day' ? today : '', important: view === 'important', dueDate: view === 'planned' ? today : '' };
    if (dirty || newStep.trim()) setPending({ item, advanced: true });
    else { setDraft(item); setDirty(Boolean(quickTitle.trim())); setQuickTitle(''); }
  };
  return <div className="app-workspace daily-tasks" aria-busy={action.busy || loading}>
    <DailyError error={error} action={action} /><Loading loading={loading} />
    <fieldset className="daily-content" disabled={unavailable || action.busy}>
    {incoming.length > 0 && !incomingApplied && <section className="app-card"><h3>{tr('添加到待办')}</h3><ul>{incoming.map((item, index) => <li key={index}>{item.title}</li>)}</ul><div className="app-toolbar"><Button type="button" disabled={action.busy || !data} onClick={() => action.run(async () => {
      await update((current) => { if (current.tasks.length + incoming.length > 2000) throw Error(tr('记录数量已达上限，请先整理已有内容。')); return { ...current, tasks: [...current.tasks, ...incoming.map((item) => ({ ...normalizeTask({ ...emptyTask(), title: item.title }), revision: 1, updatedAt: Date.now() }))] }; }); setIncomingApplied(true);
    })}>{tr('确认添加')}</Button><Button type="button" variant="ghost" onClick={() => setIncomingApplied(true)}>{tr('取消')}</Button></div></section>}
    {listManager && <section className="app-card"><form className="app-toolbar" onSubmit={(event) => { event.preventDefault(); action.run(async () => {
      const name = boundedText(listName, 100, true); await update((current) => { if (current.lists.length >= 40) throw Error(tr('清单数量已达上限。')); return { ...current, lists: [...current.lists, { id: appId(), name }] }; }); setListName('');
    }); }}><Input aria-label={tr('清单名称')} placeholder={tr('清单名称')} value={listName} maxLength={100} onChange={(event) => setListName(event.target.value)} /><Button type="submit" disabled={!data || action.busy || !listName.trim()}>{tr('添加清单')}</Button></form>
      <div className="app-toolbar">{lists.filter((item) => item.id !== 'inbox').map((item) => <Button key={item.id} type="button" variant="ghost" disabled={action.busy} onClick={() => setDeleting({ ...item, kind: 'list' })}><Trash size={14} />{item.name}</Button>)}</div></section>}
    <div className={`task-workspace ${draft ? 'has-detail' : ''}`}>
      <aside className="task-navigation"><nav className="daily-sidebar" aria-label={tr('任务视图')}>{views.map(([id, name]) => <Button key={id} type="button" variant={view === id ? 'secondary' : 'ghost'} aria-pressed={view === id} onClick={() => setView(id)}><span>{name}</span>{!['history', 'completed'].includes(id) && <small>{tasks.filter((task) => !task.completed && (id === 'all' || id === 'my-day' && task.myDay === today || id === 'important' && task.important || id === 'planned' && task.dueDate || id === `list:${task.listId}`)).length || ''}</small>}</Button>)}</nav>
        <div className="task-navigation-actions"><Button type="button" variant="ghost" onClick={() => setListManager(!listManager)}><Plus size={16} />{tr('管理清单')}</Button><Button type="button" variant="ghost" disabled={action.busy || !data} onClick={() => action.run(() => data.notifications ? update((current) => ({ ...current, notifications: false })) : enableNotifications())}>{data?.notifications ? tr('关闭提醒') : tr('开启提醒')}</Button></div>
      </aside>
      <section className="task-main"><header className="task-main-heading"><div><h2>{currentTitle}</h2><p>{new Intl.DateTimeFormat(document.documentElement.lang || undefined, { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())}</p></div><Button type="button" variant="ghost" onClick={focusQuick}><Plus size={17} />{tr('新任务')}</Button></header>
      <Input type="search" className="task-search" aria-label={tr('搜索任务')} placeholder={tr('搜索任务')} value={query} onChange={(event) => setQuery(event.target.value)} />
      <section className="task-records" aria-label={tr('任务列表')}>
        {view === 'history' ? [...history].reverse().filter((item) => !query || item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map((item) => <article className="task-history-row" key={item.id}><Check size={16} /><strong>{item.title}</strong><small>{shortDate(item.completedAt)}</small></article>) : matches.map((item) => <article key={item.id} className={`daily-task-row ${draft?.id === item.id ? 'is-selected' : ''}`}>
          <Checkbox checked={item.completed} disabled={action.busy || dirty && draft?.id === item.id} aria-label={item.completed ? tr('标为未完成') : tr('完成任务')} onCheckedChange={() => action.run(async () => { await update((current) => toggleTask(current, item.id)); if (draft?.id === item.id && !dirty) select(null); })} />
          <Button type="button" variant="ghost" className="daily-record-title" onClick={() => choose(item)}><strong>{item.title}</strong><small>{item.dueDate && <span className={item.dueDate < today && !item.completed ? 'daily-overdue' : ''}>{item.dueDate}</span>}{item.steps.length > 0 && ` · ${item.steps.filter((step) => step.done).length}/${item.steps.length}`}</small></Button>
          <Button type="button" variant="ghost" size="icon" aria-label={item.important ? tr('取消重要') : tr('标为重要')} aria-pressed={item.important} disabled={action.busy || dirty && draft?.id === item.id} onClick={() => action.run(() => quickPatch(item.id, { important: !item.important }))}><Star size={17} weight={item.important ? 'fill' : 'regular'} /></Button>
        </article>)}
        {!(view === 'history' ? history.length : matches.length) && <p className="app-empty">{view === 'my-day' ? tr('挑选今天想完成的任务') : tr('暂无任务')}</p>}
      </section>
      {!['history', 'completed'].includes(view) && <form className="task-quick-add" onSubmit={(event) => { event.preventDefault(); if (event.nativeEvent.isComposing || !quickTitle.trim()) return; action.run(async () => {
        const value = normalizeTask({ ...emptyTask(view.startsWith('list:') ? view.slice(5) : 'inbox'), title: quickTitle, myDay: view === 'my-day' ? today : '', important: view === 'important', dueDate: view === 'planned' ? today : '' });
        await update((current) => { if (!current.lists.some((list) => list.id === value.listId)) throw Error(tr('清单已被移除，请重新选择。')); return { ...current, tasks: upsertRecord(current.tasks, value).records }; }); setQuickTitle(''); setQuery('');
      }); }}><Plus size={19} /><Input ref={quickInput} aria-label={tr('快速添加任务')} placeholder={tr('添加任务，按 Enter 保存')} value={quickTitle} maxLength={300} onKeyDown={(event) => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault(); }} onChange={(event) => setQuickTitle(event.target.value)} /><Button type="button" variant="ghost" size="icon" aria-label={tr('更多选项')} onClick={openAdvanced}><DotsThree size={21} /></Button><Button type="submit" disabled={!quickTitle.trim() || unavailable || action.busy}>{tr('添加')}</Button></form>}
      </section>
      {draft && <form className="app-form task-detail" onSubmit={(event) => { event.preventDefault(); action.run(async () => {
        const value = normalizeTask({ ...draft, steps: newStep.trim() ? [...draft.steps, { id: appId(), title: newStep, done: false }] : draft.steps }); let saved;
        await update((current) => { if (!current.lists.some((list) => list.id === value.listId)) throw Error(tr('清单已被移除，请重新选择。')); const result = upsertRecord(current.tasks, value, draft.id ? draft.revision : null); saved = result.saved; return { ...current, tasks: result.records }; }); select(saved);
      }); }}>
        <header className="daily-pane-heading"><h3>{tr('任务详情')}</h3><Button type="button" variant="ghost" size="icon" aria-label={tr('关闭详情')} onClick={() => choose(null)}><X size={18} /></Button></header>
        <div className="task-detail-scroll"><Field label={tr('任务')}><Input required maxLength={300} value={draft.title} onChange={(event) => patch({ title: event.target.value })} /></Field>
        <Select label={tr('清单')} value={draft.listId} onChange={(listId) => patch({ listId })} options={lists.map((item) => ({ value: item.id, label: item.name || tr('任务清单') }))} />
        <div className="app-toolbar"><Button type="button" variant="secondary" aria-pressed={draft.myDay === today} onClick={() => patch({ myDay: draft.myDay === today ? '' : today })}><Sun size={16} />{draft.myDay === today ? tr('移出我的一天') : tr('加入我的一天')}</Button>
          <Button type="button" variant="secondary" aria-pressed={draft.important} onClick={() => patch({ important: !draft.important })}><Star size={16} weight={draft.important ? 'fill' : 'regular'} />{tr('重要')}</Button></div>
        <Field label={tr('截止日期')}><Input type="date" value={draft.dueDate} onChange={(event) => patch({ dueDate: event.target.value })} /></Field>
        <Field label={tr('提醒时间')}><Input type="datetime-local" value={localDateTime(draft.remindAt)} onChange={(event) => patch({ remindAt: event.target.value ? new Date(event.target.value).toISOString() : '' })} /></Field>
        <Select label={tr('重复')} value={draft.repeat} onChange={(repeat) => patch({ repeat })} options={TASK_REPEATS.map((value, index) => ({ value, label: repeatLabels()[index] }))} />
        <fieldset className="daily-steps"><legend>{tr('子步骤')}</legend>{draft.steps.map((step) => <div className="app-toolbar" key={step.id}><Checkbox checked={step.done} aria-label={tr('完成步骤')} onCheckedChange={(done) => patch({ steps: draft.steps.map((item) => item.id === step.id ? { ...item, done: Boolean(done) } : item) })} /><Input aria-label={tr('步骤名称')} maxLength={300} value={step.title} onChange={(event) => patch({ steps: draft.steps.map((item) => item.id === step.id ? { ...item, title: event.target.value } : item) })} /><Button type="button" variant="ghost" size="icon" aria-label={tr('移除步骤')} onClick={() => patch({ steps: draft.steps.filter((item) => item.id !== step.id) })}><Trash size={15} /></Button></div>)}
          <div className="app-toolbar"><Input aria-label={tr('新步骤')} placeholder={tr('添加步骤')} value={newStep} maxLength={300} onChange={(event) => setNewStep(event.target.value)} /><Button type="button" variant="secondary" size="icon" aria-label={tr('添加步骤')} disabled={!newStep.trim() || draft.steps.length >= 50} onClick={() => { patch({ steps: [...draft.steps, { id: appId(), title: newStep.trim(), done: false }] }); setNewStep(''); }}><Plus size={16} /></Button></div>
        </fieldset>
        <TextArea label={tr('备注')} maxLength={20000} value={draft.notes} onChange={(event) => patch({ notes: event.target.value })} />
        </div><div className="app-toolbar task-detail-actions">{draft.id && <Button type="button" variant="ghost" disabled={action.busy} onClick={() => setDeleting({ ...draft, kind: 'task' })}><Trash size={16} />{tr('删除')}</Button>}<Button type="submit" disabled={!data || action.busy || !draft.title.trim() || !dirty && !newStep.trim()}><Check size={17} />{tr('保存')}</Button></div>
      </form>}
    </div>
    </fieldset>
    <DiscardPrompt pending={pending} onCancel={() => setPending(null)} onConfirm={() => { const next = pending; select(next.item); if (next.advanced) { setDirty(Boolean(next.item.title)); setQuickTitle(''); } setPending(null); }} />
    <DeletePrompt target={deleting} action={action} title={deleting?.kind === 'list' ? tr('删除清单后，其中的任务会移至默认清单。') : undefined} onCancel={() => setDeleting(null)} onConfirm={() => action.run(async () => {
      await update((current) => deleting.kind === 'list' ? { ...current, lists: current.lists.filter((item) => item.id !== deleting.id), tasks: current.tasks.map((item) => item.listId === deleting.id ? { ...item, listId: 'inbox', revision: item.revision + 1 } : item) } : { ...current, tasks: removeRecord(current.tasks, deleting.id, deleting.revision) });
      if (draft?.id === deleting.id) select(null); if (view === `list:${deleting.id}`) setView('all'); setDeleting(null);
    })} />
  </div>;
}

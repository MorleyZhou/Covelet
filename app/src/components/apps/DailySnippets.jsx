import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, DownloadSimple, Plus, Star, Trash, UploadSimple, PencilSimple, X, FolderSimple } from '@phosphor-icons/react';
import PromptDialog from '../PromptDialog.jsx';
import { Disclosure } from '../ui/disclosure.jsx';
import { SNIPPET_DEFAULTS, normalizeSnippet, templateVariables, fillTemplate, upsertRecord, removeRecord, importSnippetBundle } from '../../lib/daily-apps.js';
import { useDailyData, useDirty, DailyError, DeletePrompt, DiscardPrompt, TextArea, Loading, tr, Button, Input, Select, Field, downloadBlob, readTextFile } from './DailyShared.jsx';

const blank = () => ({ title: '', body: '', description: '', kind: 'text', language: '', folder: '', tags: '', favorite: false });
const kinds = () => [{ value: 'text', label: tr('常用语') }, { value: 'code', label: tr('代码片段') }, { value: 'command', label: tr('命令') }, { value: 'prompt', label: tr('提示词') }];
function HighlightedCode({ value }) {
  const tokens = value.split(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:true|false|null|undefined|return|const|let|var|function|class|if|else|import|export|from|async|await|def|for|while|public|private|static|new)\b|\b\d+(?:\.\d+)?\b|\/\/[^\n]*)/g);
  return <pre className="daily-code"><code>{tokens.map((token, index) => <span key={index} className={/^["']/.test(token) ? 'daily-token-string' : /^\d/.test(token) ? 'daily-token-number' : /^\/\//.test(token) ? 'daily-token-comment' : index % 2 ? 'daily-token-keyword' : undefined}>{token}</span>)}</code></pre>;
}
export default function SnippetsApp(props) {
  const { data, update, loading, error, action, unavailable } = useDailyData('snippets', SNIPPET_DEFAULTS, props);
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all'), [folder, setFolder] = useState('all'), [kind, setKind] = useState('all');
  const [selectedId, setSelectedId] = useState(null), [editing, setEditing] = useState(false), [draft, setDraft] = useState(blank), [dirty, setDirty] = useState(false);
  const [variables, setVariables] = useState({}), [pending, setPending] = useState(null), [deleting, setDeleting] = useState(null), [importing, setImporting] = useState(null);
  const fileInput = useRef(null), items = data?.items || [], current = items.find((item) => item.id === selectedId);
  useDirty(dirty, props.onDirtyChange);
  const folders = [...new Set(items.map((item) => item.folder).filter(Boolean))].sort();
  const visible = useMemo(() => items.filter((item) => (filter !== 'favorite' || item.favorite) && (kind === 'all' || item.kind === kind)
    && (folder === 'all' || item.folder === folder) && (!query || `${item.title}\n${item.description}\n${item.body}\n${item.tags}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())))
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || (b.updatedAt || 0) - (a.updatedAt || 0)), [items, filter, folder, query, kind]);
  useEffect(() => { if (!editing && !visible.some((item) => item.id === selectedId)) { setSelectedId(visible[0]?.id || null); setVariables({}); } }, [visible, selectedId, editing]);
  const select = (item) => { setSelectedId(item?.id || null); setEditing(false); setDirty(false); setVariables({}); };
  const initialTargetApplied = useRef(false);
  useEffect(() => {
    if (unavailable || loading || initialTargetApplied.current) return;
    initialTargetApplied.current = true;
    const record = items.find((item) => item.id === props.initialContext?.recordId);
    if (record) { setQuery(''); setFilter('all'); setFolder('all'); setKind('all'); select(record); }
  }, [unavailable, loading, items, props.initialContext]);
  const beginNew = () => { setDraft(blank()); setEditing(true); setDirty(false); };
  const choose = (item) => dirty ? setPending({ kind: 'select', item }) : select(item);
  const startNew = () => dirty ? setPending({ kind: 'new' }) : beginNew();
  const cancelEdit = () => dirty ? setPending({ kind: 'cancel' }) : setEditing(false);
  const patch = (value) => { setDraft((previous) => ({ ...previous, ...value })); setDirty(true); };
  const names = templateVariables(current?.body || ''), rendered = fillTemplate(current?.body || '', variables);
  async function copy() { try { await navigator.clipboard.writeText(rendered); } catch { throw Error(tr('无法复制，请手动选择文字。')); } }
  async function favorite() {
    await update((latest) => { const saved = latest.items.find((item) => item.id === current.id); if (!saved) throw Error(tr('这条记录已在其他页面更新，请重新打开。')); return { ...latest, items: upsertRecord(latest.items, { ...saved, favorite: !saved.favorite }, saved.revision).records }; });
  }
  return <div className="app-workspace daily-snippets" aria-busy={action.busy || loading}>
    <DailyError error={error} action={action} /><Loading loading={loading} />
    <fieldset className="daily-content" disabled={unavailable || action.busy}>
      <div className="snippet-workspace">
        <aside className="snippet-navigation"><Button type="button" onClick={startNew}><Plus size={17} />{tr('新小抄')}</Button>
          <nav className="daily-sidebar" aria-label={tr('分类')}><Button type="button" variant={filter === 'all' && folder === 'all' ? 'secondary' : 'ghost'} onClick={() => { setFilter('all'); setFolder('all'); }}>{tr('全部')}<small>{items.length}</small></Button><Button type="button" variant={filter === 'favorite' ? 'secondary' : 'ghost'} onClick={() => { setFilter('favorite'); setFolder('all'); }}><Star size={15} />{tr('收藏')}</Button>{folders.map((name) => <Button key={name} type="button" variant={folder === name ? 'secondary' : 'ghost'} onClick={() => { setFilter('all'); setFolder(name); }}><FolderSimple size={15} /><span>{name}</span></Button>)}</nav>
          <div className="snippet-library-actions"><Button type="button" variant="ghost" disabled={!data || dirty} onClick={() => fileInput.current?.click()}><UploadSimple size={16} />{tr('导入')}</Button><Button type="button" variant="ghost" onClick={() => action.run(() => downloadBlob(new Blob([JSON.stringify({ format: 'covelet-snippets', version: 1, items }, null, 2)], { type: 'application/json' }), 'covelet-snippets.json'))}><DownloadSimple size={16} />{tr('导出')}</Button></div>
          <Input ref={fileInput} className="daily-file-input" type="file" accept=".json,application/json" aria-label={tr('导入小抄')} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) action.run(async () => { const text = await readTextFile(file, 4 * 1024 * 1024), result = importSnippetBundle(text, items); setImporting({ text, count: result.length - items.length }); }); }} />
        </aside>
        <section className="snippet-browser"><Input type="search" aria-label={tr('搜索小抄')} placeholder={tr('搜索小抄')} value={query} onChange={(event) => setQuery(event.target.value)} />
          <Select label={tr('内容类型')} value={kind} onChange={setKind} options={[{ value: 'all', label: tr('全部') }, ...kinds()]} />
          <section className="snippet-records" aria-label={tr('小抄列表')}>{visible.map((item) => <Button key={item.id} type="button" variant={selectedId === item.id ? 'secondary' : 'ghost'} className="daily-record-title" onClick={() => choose(item)}><strong>{item.favorite && <Star size={13} weight="fill" />}{item.title}</strong><small>{item.description || item.body.slice(0, 90)}</small><small>{[item.language, item.tags].filter(Boolean).join(' · ')}</small></Button>)}{!visible.length && <p className="app-empty">{query ? tr('没有找到小抄') : tr('暂无小抄')}</p>}</section>
        </section>
        {editing ? <form className="app-form snippet-editor" onSubmit={(event) => { event.preventDefault(); action.run(async () => { const value = normalizeSnippet(draft); let saved; await update((latest) => { const result = upsertRecord(latest.items, value, draft.id ? draft.revision : null); saved = result.saved; return { ...latest, items: result.records }; }); setQuery(''); setFilter('all'); setFolder('all'); setKind('all'); select(saved); }); }}>
          <header className="daily-pane-heading"><h3>{draft.id ? tr('编辑小抄') : tr('新小抄')}</h3><Button type="button" variant="ghost" size="icon" aria-label={tr('关闭编辑')} onClick={cancelEdit}><X size={18} /></Button></header>
          <div className="daily-editor-scroll"><Field label={tr('名称')}><Input autoFocus required maxLength={200} value={draft.title} onChange={(event) => patch({ title: event.target.value })} /></Field>
          <Select label={tr('内容类型')} value={draft.kind} onChange={(value) => patch({ kind: value })} options={kinds()} />
          <TextArea label={tr('内容')} required rows={14} spellCheck={draft.kind === 'text'} maxLength={100000} value={draft.body} onChange={(event) => patch({ body: event.target.value })} />
          <Disclosure title={tr('分类与说明')}><div className="app-form"><div className="app-grid"><Field label={tr('语言')}><Input placeholder="JavaScript / Python / SQL" maxLength={40} value={draft.language} onChange={(event) => patch({ language: event.target.value })} /></Field><Field label={tr('分类')}><Input maxLength={80} value={draft.folder} onChange={(event) => patch({ folder: event.target.value })} /></Field><Field label={tr('标签')}><Input maxLength={500} placeholder={tr('用逗号分隔')} value={draft.tags} onChange={(event) => patch({ tags: event.target.value })} /></Field></div><TextArea label={tr('说明')} rows={2} maxLength={2000} value={draft.description} onChange={(event) => patch({ description: event.target.value })} /></div></Disclosure>
          <p className="app-muted">{tr('用 {{名称}} 插入填写项，{{date}} 和 {{time}} 可填入当前日期与时间。')}</p></div>
          <div className="app-toolbar snippet-editor-actions"><Button type="button" variant="ghost" onClick={cancelEdit}>{tr('取消')}</Button><Button type="submit" disabled={!dirty || !draft.title.trim() || !draft.body.trim()}>{tr('保存')}</Button></div>
        </form> : current ? <section className="snippet-reader" aria-label={tr('小抄正文')}><header className="snippet-reader-heading"><div><p className="app-muted">{[kinds().find((item) => item.value === current.kind)?.label, current.language, current.folder].filter(Boolean).join(' · ')}</p><h2>{current.title}</h2></div><div className="app-toolbar"><Button type="button" variant="ghost" size="icon" aria-label={tr('收藏')} aria-pressed={current.favorite} onClick={() => action.run(favorite)}><Star size={17} weight={current.favorite ? 'fill' : 'regular'} /></Button><Button type="button" variant="secondary" onClick={() => { setDraft(structuredClone(current)); setEditing(true); setDirty(false); }}><PencilSimple size={16} />{tr('编辑')}</Button><Button type="button" onClick={() => action.run(copy)}><Copy size={16} />{tr('复制')}</Button></div></header>
          {current.description && <p className="snippet-description">{current.description}</p>}
          <div className={`snippet-reading-body ${names.length ? 'has-variables' : ''}`}><div className="snippet-document">{current.kind === 'code' || current.kind === 'command' ? <HighlightedCode value={rendered} /> : <pre className="daily-plain-preview">{rendered}</pre>}</div>
            {!!names.length && <aside className="snippet-variables"><h3>{tr('填写变量')}</h3>{names.map((name) => <Field key={name} label={name}><Input maxLength={10000} placeholder={['date', 'time'].includes(name) ? tr('当前日期或时间') : ''} value={variables[name] || ''} onChange={(event) => setVariables((previous) => ({ ...previous, [name]: event.target.value }))} /></Field>)}<Button type="button" onClick={() => action.run(copy)}>{tr('复制结果')}</Button></aside>}
          </div>
          <footer className="snippet-reader-footer"><span className="app-muted">{current.tags}</span><div className="app-toolbar">{props.onOpenApp && current.kind === 'prompt' && <Button type="button" variant="secondary" onClick={() => props.onOpenApp('ai-chat', { prompt: rendered })}>{tr('用于 AI 聊天')}</Button>}<Button type="button" variant="ghost" size="icon" aria-label={tr('删除')} onClick={() => setDeleting(current)}><Trash size={16} /></Button></div></footer>
        </section> : <section className="snippet-reader snippet-empty"><Copy size={38} /><h2>{tr('暂无小抄')}</h2><Button type="button" onClick={startNew}><Plus size={17} />{tr('新小抄')}</Button></section>}
      </div>
    </fieldset>
    <DiscardPrompt pending={pending} onCancel={() => setPending(null)} onConfirm={() => { const next = pending; setPending(null); if (next.kind === 'new') beginNew(); else if (next.kind === 'cancel') { setEditing(false); setDirty(false); } else select(next.item); }} />
    <DeletePrompt target={deleting} action={action} onCancel={() => setDeleting(null)} onConfirm={() => action.run(async () => { await update((latest) => ({ ...latest, items: removeRecord(latest.items, deleting.id, deleting.revision) })); select(null); setDeleting(null); })} />
    {importing && <PromptDialog action={tr('导入')} busy={action.busy} onCancel={() => setImporting(null)} onConfirm={() => action.run(async () => { await update((latest) => ({ ...latest, items: importSnippetBundle(importing.text, latest.items) })); setImporting(null); })}>{tr('导入 {0} 条小抄？相同内容会自动跳过。', [importing.count])}</PromptDialog>}
  </div>;
}

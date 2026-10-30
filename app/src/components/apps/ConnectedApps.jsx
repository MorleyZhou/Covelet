import { useContext, useEffect, useRef, useState } from 'react';
import { tr } from '../../i18n/index.js';
import { useAppData, useAppAction, Field, AppError, Button, Input, Textarea, Select, downloadBlob } from './shared.jsx';
import Confirm from '../PromptDialog.jsx';
import { fetchAppJSON, fetchAppResponse, readAppResponse, requestAppAccess } from '../../lib/app-network.js';
import { parseFeed, releaseItems, mergeFeedItems, feedText, safeContentURL, aiEndpoint, parseModelList, readChatStream } from '../../lib/connected-apps.js';
import { saveNote, saveReadingItem, loadPersonalTools } from '../../lib/personal-tools.js';
import { PresentationContext } from '../../lib/presentation.js';
import { loadContentPreferences } from '../../lib/content-preferences.js';
import { loadAppData } from '../../lib/app-data.js';
import { localData } from '../../lib/local-data.js';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Plus, X, GearSix, Star, Trash, PaperPlaneRight, DownloadSimple, Copy, PencilSimple, NotePencil, Paperclip } from '@phosphor-icons/react';
import Subscriptions from './SubscriptionReader.jsx';
import './connected-apps.css';

const id = () => crypto.randomUUID();
const SUB_DEFAULT = { sources: [], items: [], baselines: {} };
const AI_DEFAULT = { sessions: [], config: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: '', models: [], systemPrompt: '', temperature: 0.7, key: '' } };
const markdownComponents = { img: ({ alt }) => <span>{alt}</span>, a: ({ href, children }) => safeContentURL(href) ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span> };

export default function ConnectedApps(props) { return props.appId === 'subscriptions' ? <Subscriptions {...props} /> : <AIChat {...props} />; }

function AIChat({ onDirtyChange, onBusyChange, initialContext }) {
  const { data, update, loading, error } = useAppData('ai-chat', AI_DEFAULT), action = useAppAction(), presentation = useContext(PresentationContext);
  const [selected, setSelected] = useState(initialContext?.sessionId || ''), [draft, setDraft] = useState(initialContext?.prompt || ''), [settings, setSettings] = useState(false), [config, setConfig] = useState(null), [query, setQuery] = useState(''), [streaming, setStreaming] = useState(''), [generating, setGenerating] = useState(false), [deleting, setDeleting] = useState(null), [editing, setEditing] = useState(null);
  const [showContext, setShowContext] = useState(false), [pendingView, setPendingView] = useState(null);
  const restoredSession = useRef(Boolean(initialContext?.prompt || initialContext?.sessionId || initialContext?.newSession));
  const [notes, setNotes] = useState([]), [noteIds, setNoteIds] = useState([]), [templates, setTemplates] = useState([]), [templateId, setTemplateId] = useState('');
  const [connection, setConnection] = useState(null), [connectionReady, setConnectionReady] = useState(false);
  const chatScroll = useRef(null), followReply = useRef(true);
  const abort = useRef(null), conversation = data.sessions.find((item) => item.id === selected), savedConfig = { ...data.config, ...(connection || {}) }, currentConfig = config || savedConfig;
  useEffect(() => { if (!loading && !restoredSession.current) { restoredSession.current = true; if (data.sessions[0]) setSelected(data.sessions[0].id); } }, [loading, data.sessions]);
  useEffect(() => { onDirtyChange?.(Boolean(draft || config)); }, [draft, config, onDirtyChange]);
  useEffect(() => { onBusyChange?.(action.busy || generating); }, [action.busy, generating, onBusyChange]);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => { followReply.current = true; }, [selected]);
  useEffect(() => { if (followReply.current && chatScroll.current) chatScroll.current.scrollTop = chatScroll.current.scrollHeight; }, [selected, conversation?.messages.length, streaming]);
  useEffect(() => {
    let live = true;
    const receive = (value) => { if (live) { setConnection(value || null); setConnectionReady(true); } };
    const off = localData.subscribe((changes) => { if (changes['covelet.ai.connection.v1']) receive(changes['covelet.ai.connection.v1'].newValue); });
    localData.get('covelet.ai.connection.v1').then((values) => receive(values['covelet.ai.connection.v1'])).catch((reason) => action.setError(reason.message));
    return () => { live = false; off(); };
  }, []);
  useEffect(() => {
    let live = true;
    const read = () => Promise.all([loadPersonalTools(), loadAppData('snippets', { items: [] })]).then(([tools, snippets]) => { if (live) { setNotes(tools.notes); setTemplates((snippets.data.items || []).filter((item) => ['prompt', 'template'].includes(item.type || item.kind))); } }).catch(() => {});
    const off = localData.subscribe((changes) => { if (changes['covelet.tools.v1'] || changes['covelet.app.v1.snippets']) read(); });
    read(); return () => { live = false; off(); };
  }, []);
  const saveConfiguration = async (next) => {
    aiEndpoint(next);
    if (!Number.isFinite(Number(next.temperature)) || Number(next.temperature) < 0 || Number(next.temperature) > 2) throw Error(tr('温度范围为 0 至 2。'));
    // A localhost endpoint and installed model belong to this device. Chat
    // content and reusable instructions remain in the portable app document.
    await localData.set({ 'covelet.ai.connection.v1': { provider: next.provider, baseUrl: next.baseUrl, model: next.model, models: next.models, key: next.key } });
    await update((latest) => ({ ...latest, config: { ...latest.config, systemPrompt: next.systemPrompt, temperature: Number(next.temperature), key: '' } }));
  };
  const visibleNotes = notes.filter((note) => !presentation.active || !presentation.hiddenKeys.has(`note:${note.id}`));
  const headers = (configuration) => ({ 'Content-Type': 'application/json', ...(configuration.key ? { Authorization: `Bearer ${configuration.key}` } : {}) });
  const check = () => {
    let url; try { url = aiEndpoint(currentConfig, 'models'); } catch (reason) { action.setError(reason.message); return; }
    const permission = requestAppAccess(url);
    action.run(async () => { await permission; const models = parseModelList(await fetchAppJSON(url, { headers: headers(currentConfig) }), currentConfig.provider);
      const next = { ...currentConfig, models, model: models.includes(currentConfig.model) ? currentConfig.model : models[0] || '' }; await saveConfiguration(next); setConfig(null); });
  };
  const send = () => {
    if (!draft.trim() || generating || !connectionReady) return;
    const configuration = savedConfig;
    if (!configuration.model) { action.setError(tr('请先连接模型并选择一个模型。')); setSettings(true); return; }
    let url; try { url = aiEndpoint(configuration); } catch (reason) { action.setError(reason.message); return; }
    const permission = requestAppAccess(url), text = draft.trim(), sessionId = conversation?.id || id(), messageId = id();
    action.run(async () => {
      await permission; setGenerating(true); abort.current = new AbortController(); let output = '';
      const existing = editing === null ? conversation?.messages || [] : (conversation?.messages || []).slice(0, editing);
      const messages = [...existing, { id: messageId, role: 'user', content: text, createdAt: new Date().toISOString() }];
      const tools = noteIds.length ? await loadPersonalTools() : null, preferences = await loadContentPreferences();
      const context = (tools?.notes || []).filter((note) => noteIds.includes(note.id) && !(preferences.presentation && preferences.privateKeys.includes(`note:${note.id}`))).map((note) => `${note.title}\n${note.body}`).join('\n\n').slice(0, 60000);
      await update((latest) => {
        const saved = latest.sessions.find((item) => item.id === sessionId);
        if (saved && JSON.stringify(saved.messages) !== JSON.stringify(conversation.messages)) throw Error(tr('会话已在其他页面更新，请重新打开。'));
        const next = { id: sessionId, title: saved?.title || text.slice(0, 60), pinned: saved?.pinned || false, createdAt: saved?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), messages };
        if (!saved && latest.sessions.length >= 200) throw Error(tr('会话数量已达上限，请先导出并整理。'));
        return { ...latest, sessions: saved ? latest.sessions.map((item) => item.id === sessionId ? next : item) : [next, ...latest.sessions] };
      });
      setSelected(sessionId); setDraft(''); setEditing(null); setStreaming('');
      try {
        const outgoing = messages.map(({ role, content }) => ({ role, content }));
        const system = [configuration.systemPrompt, context ? `${tr('以下是用户选择的参考资料：')}\n${context}` : ''].filter(Boolean).join('\n\n');
        if (system) outgoing.unshift({ role: 'system', content: system });
        const body = { model: configuration.model, messages: outgoing, stream: true, ...(configuration.provider === 'ollama' ? { options: { temperature: Number(configuration.temperature) } } : { temperature: Number(configuration.temperature) }) };
        const response = await fetchAppResponse(url, { method: 'POST', headers: headers(configuration), body: JSON.stringify(body), signal: abort.current.signal, timeout: 180000 });
        output = await readChatStream(response, configuration.provider, (value) => { output = value; setStreaming(value); });
        if (!output) throw Error(tr('模型没有返回文本回复。'));
      } finally {
        if (output) await update((latest) => ({ ...latest, sessions: latest.sessions.map((item) => {
          if (item.id !== sessionId) return item;
          if (item.messages.at(-1)?.id !== messageId) throw Error(tr('会话已在其他页面更新，请重新打开。'));
          return { ...item, updatedAt: new Date().toISOString(), messages: [...item.messages, { id: id(), role: 'assistant', content: output, createdAt: new Date().toISOString(), stopped: abort.current.signal.aborted }] };
        }) }));
        setStreaming('');
      }
    }).finally(() => { setGenerating(false); setStreaming(''); });
  };
  const chooseSession = (next) => {
    if (generating || action.busy) return;
    if (draft || config) { setPendingView({ session: next }); return; }
    setSelected(next); setEditing(null); setSettings(false);
  };
  const closeSettings = () => { if (action.busy) return; if (config) setPendingView({ closeSettings: true }); else setSettings(false); };
  const pinSession = () => action.run(() => update((latest) => ({ ...latest, sessions: latest.sessions.map((session) => session.id === selected ? { ...session, pinned: !session.pinned } : session) })));
  return <div className={`app-workspace ai-app ${settings ? 'ai-settings-open' : ''}`}>
    <AppError message={error || action.error} onClose={() => action.setError('')} />
    <div className="ai-chat-layout" inert={settings ? true : undefined}>
      <aside className="ai-session-sidebar"><Button type="button" disabled={generating || action.busy} onClick={() => chooseSession('')}><Plus size={17} />{tr('新会话')}</Button>
        <Input aria-label={tr('搜索会话')} placeholder={tr('搜索会话')} value={query} onChange={(event) => setQuery(event.target.value)} />
        <div className="ai-session-list">{[...data.sessions].sort((a, b) => Number(b.pinned) - Number(a.pinned) || String(b.updatedAt).localeCompare(String(a.updatedAt))).filter((item) => `${item.title} ${item.messages.map((message) => message.content).join(' ')}`.toLowerCase().includes(query.toLowerCase())).map((item) => <Button type="button" variant="unstyled" size="unstyled" className="ai-session-item" key={item.id} disabled={generating || action.busy} aria-pressed={selected === item.id} onClick={() => chooseSession(item.id)}><strong>{item.pinned && <Star size={13} weight="fill" />}{item.title}</strong><small>{item.messages.at(-1)?.content.slice(0, 64)}</small></Button>)}</div>
      </aside>
      <section className="app-chat-main"><header className="ai-conversation-heading"><strong>{conversation?.title || tr('新会话')}</strong><div className="app-toolbar">{savedConfig.models.length > 0 && <Select label={tr('模型')} value={savedConfig.model} disabled={generating || action.busy} onChange={(model) => action.run(() => saveConfiguration({ ...savedConfig, model }))} options={savedConfig.models.map((model) => ({ value: model, label: model }))} />}
        {conversation && <><Button type="button" variant="ghost" size="icon" aria-label={conversation.pinned ? tr('取消置顶') : tr('置顶')} disabled={action.busy} onClick={pinSession}><Star size={17} weight={conversation.pinned ? 'fill' : 'regular'} /></Button><Button type="button" variant="ghost" size="icon" aria-label={tr('导出')} onClick={() => downloadBlob(new Blob([conversation.messages.map((message) => `## ${message.role}\n\n${message.content}`).join('\n\n')], { type: 'text/markdown' }), `${conversation.title}.md`)}><DownloadSimple size={17} /></Button><Button type="button" variant="ghost" size="icon" aria-label={tr('删除会话')} disabled={generating || action.busy} onClick={() => setDeleting(conversation)}><Trash size={17} /></Button></>}
        <Button type="button" variant="ghost" size="icon" aria-label={tr('模型连接')} disabled={generating || action.busy} onClick={() => setSettings(true)}><GearSix size={18} /></Button></div></header>
        <div className="app-chat-messages" ref={chatScroll} onScroll={() => { const node = chatScroll.current; if (node) followReply.current = node.scrollTop + node.clientHeight >= node.scrollHeight - 80; }} aria-live="polite">{(conversation?.messages || []).map((message, index) => <article className={`ai-message app-message-${message.role}`} key={message.id}><strong className="ai-message-role">{message.role === 'user' ? tr('你') : tr('助手')}</strong><div className="app-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={markdownComponents}>{message.content}</Markdown></div><div className="ai-message-actions"><Button type="button" variant="ghost" size="icon" aria-label={tr('复制')} disabled={action.busy} onClick={() => action.run(() => navigator.clipboard.writeText(message.content))}><Copy size={16} /></Button>{message.role === 'user' ? <Button type="button" variant="ghost" size="icon" aria-label={tr('编辑后重发')} disabled={action.busy || Boolean(draft)} onClick={() => { setDraft(message.content); setEditing(index); }}><PencilSimple size={16} /></Button> : <Button type="button" variant="ghost" size="icon" aria-label={tr('保存为便笺')} disabled={action.busy} onClick={() => action.run(() => saveNote({ title: conversation.title, body: message.content, pinned: false }))}><NotePencil size={16} /></Button>}</div></article>)}
          {generating && <article className="ai-message app-message-assistant"><strong className="ai-message-role">{tr('助手')}</strong><div className="app-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={markdownComponents}>{streaming || tr('正在生成…')}</Markdown></div></article>}
          {!conversation && !generating && <div className="ai-chat-empty"><h3>{tr('新会话')}</h3><p className="app-muted">{savedConfig.model ? savedConfig.model : tr('选择模型，开始一次对话')}</p>{!savedConfig.model && <Button type="button" variant="secondary" onClick={() => setSettings(true)}>{tr('模型连接')}</Button>}</div>}
        </div>
        <form className="ai-composer" onSubmit={(event) => { event.preventDefault(); send(); }}>
          {(noteIds.length > 0 || templateId) && <div className="ai-context-chips">{noteIds.map((noteId) => <span key={noteId}>{visibleNotes.find((note) => note.id === noteId)?.title}<Button type="button" variant="ghost" size="icon" aria-label={tr('移除资料')} disabled={generating} onClick={() => setNoteIds((ids) => ids.filter((value) => value !== noteId))}><X size={13} /></Button></span>)}{templateId && <span>{templates.find((item) => item.id === templateId)?.title}<Button type="button" variant="ghost" size="icon" aria-label={tr('移除模板')} disabled={generating} onClick={() => setTemplateId('')}><X size={13} /></Button></span>}</div>}
          {showContext && <div className="ai-context-picker"><Select label={tr('参考便笺')} value={noteIds[0] || ''} disabled={generating} onChange={(value) => setNoteIds(value ? [value] : [])} options={[{ value: '', label: tr('不添加资料') }, ...visibleNotes.map((note) => ({ value: note.id, label: note.title }))]} /><Select label={tr('提示词模板')} value={templateId} disabled={generating} onChange={(value) => { setTemplateId(value); const item = templates.find((entry) => entry.id === value); if (item) setDraft(item.body || item.content || ''); }} options={[{ value: '', label: tr('不使用模板') }, ...templates.map((item) => ({ value: item.id, label: item.title }))]} /></div>}
          <Textarea aria-label={tr('消息')} placeholder={tr('输入消息…')} value={draft} maxLength={30000} disabled={generating} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} />
          <div className="ai-composer-toolbar"><Button type="button" variant="ghost" aria-pressed={showContext} disabled={generating} onClick={() => setShowContext(!showContext)}><Paperclip size={17} />{tr('添加资料')}</Button><span />{draft && <Button variant="ghost" type="button" disabled={generating} onClick={() => { setDraft(''); setEditing(null); }}>{tr('清空草稿')}</Button>}{generating ? <Button type="button" onClick={() => abort.current?.abort()}>{tr('停止生成')}</Button> : <Button type="submit" disabled={loading || !connectionReady || action.busy || !draft.trim()}><PaperPlaneRight size={17} />{tr('发送')}</Button>}</div>
        </form>
      </section>
    </div>
    {settings && <aside className="connected-sheet ai-connection-sheet" aria-label={tr('模型连接')}><div className="connected-sheet-heading"><h3>{tr('模型连接')}</h3><Button type="button" variant="ghost" size="icon" aria-label={tr('关闭面板')} disabled={action.busy} onClick={closeSettings}><X size={19} /></Button></div><form className="app-form" onSubmit={(event) => { event.preventDefault(); action.run(async () => { await saveConfiguration({ ...currentConfig }); setConfig(null); setSettings(false); }); }}>
      <Select label={tr('服务类型')} value={currentConfig.provider} onChange={(provider) => setConfig({ ...currentConfig, provider, baseUrl: provider === 'ollama' ? 'http://localhost:11434' : 'http://localhost:1234/v1', models: [], model: '' })} options={[{ value: 'ollama', label: 'Ollama' }, { value: 'openai', label: 'LM Studio / OpenAI compatible' }]} />
      <Field label={tr('服务地址')}><Input value={currentConfig.baseUrl} maxLength={4096} onChange={(event) => setConfig({ ...currentConfig, baseUrl: event.target.value })} /></Field>
      <Button type="button" disabled={action.busy} variant="secondary" onClick={check}>{action.busy ? tr('正在连接…') : tr('检查连接并读取模型')}</Button><Select label={tr('模型')} value={currentConfig.model} onChange={(model) => setConfig({ ...currentConfig, model })} options={currentConfig.models.map((model) => ({ value: model, label: model }))} />
      <details className="ai-advanced-settings"><summary>{tr('更多设置')}</summary><div className="app-form"><Field label={tr('API Key（可留空）')}><Input type="password" autoComplete="off" value={currentConfig.key} maxLength={1000} onChange={(event) => setConfig({ ...currentConfig, key: event.target.value })} /></Field><Field label={tr('温度')}><Input type="number" min="0" max="2" step="0.1" value={currentConfig.temperature} onChange={(event) => setConfig({ ...currentConfig, temperature: event.target.value })} /></Field><Field label={tr('系统提示词')}><Textarea value={currentConfig.systemPrompt} maxLength={12000} onChange={(event) => setConfig({ ...currentConfig, systemPrompt: event.target.value })} /></Field></div></details><div className="app-toolbar"><Button type="submit" disabled={action.busy}>{tr('保存')}</Button><Button type="button" variant="ghost" disabled={action.busy} onClick={closeSettings}>{tr('取消')}</Button></div>
    </form></aside>}
    {pendingView && <Confirm action={tr('放弃修改')} onCancel={() => setPendingView(null)} onConfirm={() => { if (pendingView.closeSettings) { setConfig(null); setSettings(false); } else { setDraft(''); setConfig(null); setEditing(null); setSelected(pendingView.session); setSettings(false); } setPendingView(null); }}>{tr('当前内容尚未保存，放弃修改？')}</Confirm>}
    {deleting && <Confirm destructive action={tr('删除')} onCancel={() => setDeleting(null)} onConfirm={() => action.run(async () => { await update((latest) => ({ ...latest, sessions: latest.sessions.filter((item) => item.id !== deleting.id) })); if (selected === deleting.id) setSelected(''); setDeleting(null); })}>{tr('删除此会话及其全部消息？')}</Confirm>}
  </div>;
}

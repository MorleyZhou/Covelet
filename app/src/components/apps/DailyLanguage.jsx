import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, SpeakerHigh, Trash, PencilSimple, X, BookOpen, CheckCircle } from '@phosphor-icons/react';
import { Disclosure } from '../ui/disclosure.jsx';
import { LANGUAGE_DEFAULTS, normalizeWord, upsertRecord, removeRecord, reviewWord, spellingMatches, dateKey } from '../../lib/daily-apps.js';
import { useDailyData, useDirty, DailyError, DeletePrompt, DiscardPrompt, TextArea, Loading, tr, Button, Input, Select, Field } from './DailyShared.jsx';

const empty = (language = 'en') => ({ term: '', meaning: '', language, phonetic: '', example: '', translation: '', source: '', tags: '' });
const languages = () => [{ value: 'en', label: tr('英语') }, { value: 'ja', label: tr('日语') }, { value: 'ko', label: tr('韩语') }, { value: 'fr', label: tr('法语') }, { value: 'de', label: tr('德语') }, { value: 'es', label: tr('西班牙语') }, { value: 'ru', label: tr('俄语') }, { value: 'zh', label: tr('中文') }];
function maskedExample(word) {
  const escaped = word.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return word.example && new RegExp(escaped, 'iu').test(word.example) ? word.example.replace(new RegExp(escaped, 'giu'), '______') : word.meaning;
}
export default function LanguageApp(props) {
  const { data, update, loading, error, action, unavailable } = useDailyData('language', LANGUAGE_DEFAULTS, props);
  const [language, setLanguage] = useState('en'), [query, setQuery] = useState(''), [draft, setDraft] = useState(() => empty());
  const [dirty, setDirty] = useState(false), [pending, setPending] = useState(null), [deleting, setDeleting] = useState(null), [view, setView] = useState('today');
  const [selectedId, setSelectedId] = useState(null), [editing, setEditing] = useState(false), [practiceId, setPracticeId] = useState(null);
  const [mode, setMode] = useState('card'), [revealed, setRevealed] = useState(false), [answer, setAnswer] = useState(''), [checked, setChecked] = useState(null), [all, setAll] = useState(false), [seen, setSeen] = useState([]), [now, setNow] = useState(Date.now());
  useDirty(dirty, props.onDirtyChange);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
  useEffect(() => () => globalThis.speechSynthesis?.cancel(), []);
  const words = data?.words || [], reviews = data?.reviews || [];
  const available = words.filter((word) => word.language === language), due = available.filter((word) => word.dueAt <= now);
  const queue = (all ? available : due).filter((word) => !seen.includes(word.id) && (!practiceId || word.id === practiceId)).sort((a, b) => a.dueAt - b.dueAt), current = queue[0];
  useEffect(() => { setRevealed(false); setAnswer(''); setChecked(null); globalThis.speechSynthesis?.cancel(); }, [current?.id, mode]);
  const matches = useMemo(() => available.filter((word) => !query || `${word.term}\n${word.meaning}\n${word.tags}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [available, query]);
  const selectedWord = matches.find((word) => word.id === selectedId) || matches[0];
  const select = (word) => { setSelectedId(word?.id || null); setDirty(false); setEditing(false); setView('library'); };
  const initialTargetApplied = useRef(false);
  useEffect(() => {
    if (unavailable || loading || initialTargetApplied.current) return;
    initialTargetApplied.current = true;
    const word = words.find((item) => item.id === props.initialContext?.wordId);
    if (word) { setLanguage(word.language); setQuery(''); select(word); }
  }, [unavailable, loading, words, props.initialContext]);
  const choose = (word) => dirty ? setPending({ word }) : select(word);
  const patch = (value) => { setDraft((valueNow) => ({ ...valueNow, ...value })); setDirty(true); };
  const edit = (word) => { setDraft(word ? structuredClone(word) : empty(language)); setDirty(false); setEditing(true); setView('library'); };
  const startNew = () => dirty ? setPending({ edit: true }) : edit(null);
  const navigate = (next) => { if (dirty) setPending({ view: next }); else { setView(next); setEditing(false); globalThis.speechSynthesis?.cancel(); } };
  const begin = () => { setView('today'); setEditing(false); setSeen([]); setAll(false); setPracticeId(null); };
  const cancelEdit = () => dirty ? setPending({ closeEdit: true }) : setEditing(false);
  function speak(word, example = false) {
    if (!globalThis.speechSynthesis || !globalThis.SpeechSynthesisUtterance) throw Error(tr('当前浏览器无法播放发音。'));
    const utterance = new SpeechSynthesisUtterance(example ? word.example || word.term : word.term); utterance.lang = word.language; utterance.rate = 0.85;
    speechSynthesis.cancel(); speechSynthesis.speak(utterance);
  }
  async function rate(rating) {
    if (!current) return;
    const id = current.id, expected = current.revision, stamp = Date.now();
    await update((value) => {
      const latest = value.words.find((word) => word.id === id);
      if (!latest || latest.revision !== expected) throw Error(tr('这条记录已在其他页面更新，请重新打开。'));
      return { ...value, words: value.words.map((word) => word.id === id ? reviewWord(word, rating, stamp) : word),
        reviews: [...value.reviews, { id: crypto.randomUUID(), wordId: id, language: current.language, rating, mode, correct: mode === 'card' ? rating !== 'again' : checked === true, at: stamp }].slice(-10000) };
    }); setSeen((value) => [...value, id]); setNow(stamp);
  }
  const todayReviews = reviews.filter((item) => item.language === language && dateKey(item.at) === dateKey());
  const progressDays = Array.from({ length: 7 }, (_, index) => { const date = new Date(); date.setDate(date.getDate() - 6 + index); const key = dateKey(date); return { key, label: new Intl.DateTimeFormat(document.documentElement.lang || undefined, { weekday: 'short' }).format(date), count: reviews.filter((item) => item.language === language && dateKey(item.at) === key).length }; });
  const maxReviews = Math.max(1, ...progressDays.map((day) => day.count));
  return <div className="app-workspace daily-language" aria-busy={loading || action.busy}>
    <DailyError error={error} action={action} /><Loading loading={loading} />
    <fieldset className="daily-content" disabled={unavailable || action.busy}>
    <header className="language-header"><nav className="language-navigation" aria-label={tr('语言学习视图')}>{[['today', tr('今日学习')], ['library', tr('词库')], ['progress', tr('学习进度')]].map(([id, title]) => <Button key={id} type="button" variant={view === id ? 'secondary' : 'ghost'} aria-pressed={view === id} onClick={() => navigate(id)}>{title}</Button>)}</nav><Select label={tr('学习语种')} value={language} onChange={(value) => { if (dirty) setPending({ language: value }); else { setLanguage(value); setSeen([]); setPracticeId(null); setEditing(false); } }} options={languages()} /></header>
    {view === 'today' && <div className="language-today"><div className="language-session-heading"><div><h2>{tr('今日学习')}</h2><p>{tr('{0} 个单词 · {1} 个待复习 · 今日已练习 {2} 次', [available.length, due.length, todayReviews.length])}</p></div></div><section className="daily-word-study">
      <div className="app-toolbar"><Select label={tr('练习方式')} value={mode} onChange={setMode} options={[{ value: 'card', label: tr('单词卡片') }, { value: 'spelling', label: tr('拼写练习') }, { value: 'listening', label: tr('听写练习') }, { value: 'context', label: tr('语境填空') }]} />
        <Button type="button" variant="ghost" onClick={() => navigate('library')}>{tr('返回词库')}</Button></div>
      {current ? <>
        <p className="app-muted">{tr('剩余 {0} 个', [queue.length])}</p>
        <h2 className="daily-word-term">{mode === 'card' ? current.term : mode === 'listening' ? tr('听发音，写出单词') : mode === 'context' ? maskedExample(current) : current.meaning}</h2>
        {(mode === 'card' || revealed) && <p className="daily-word-phonetic">{current.phonetic}</p>}
        <Button type="button" variant="secondary" onClick={() => action.run(() => speak(current))}><SpeakerHigh size={19} />{tr('播放发音')}</Button>
        {mode !== 'card' && <form className="app-toolbar daily-word-answer" onSubmit={(event) => { event.preventDefault(); setChecked(spellingMatches(answer, current.term)); setRevealed(true); }}><Input aria-label={tr('填写单词')} autoComplete="off" autoCapitalize="none" spellCheck={false} value={answer} maxLength={200} onChange={(event) => { setAnswer(event.target.value); setChecked(null); setRevealed(false); }} /><Button type="submit" disabled={!answer.trim()}>{tr('检查答案')}</Button></form>}
        {mode === 'card' && !revealed && <Button type="button" onClick={() => setRevealed(true)}>{tr('显示释义')}</Button>}
        {revealed && <div className="daily-word-answer-details">
          {mode !== 'card' && <p className={checked ? 'daily-answer-correct' : 'daily-overdue'} role="status">{checked ? tr('回答正确') : tr('正确答案：{0}', [current.term])}</p>}
          <h3>{current.meaning}</h3>{current.example && <blockquote>{current.example}</blockquote>}{current.translation && <p>{current.translation}</p>}{current.source && <p className="app-muted">{tr('来源：{0}', [current.source])}</p>}
          <div className="app-toolbar"><Button type="button" variant="secondary" disabled={action.busy} onClick={() => action.run(() => rate('again'))}>{tr('再练一次')}</Button><Button type="button" disabled={action.busy || mode !== 'card' && !checked} onClick={() => action.run(() => rate('good'))}>{tr('记住了')}</Button><Button type="button" variant="secondary" disabled={action.busy || mode !== 'card' && !checked} onClick={() => action.run(() => rate('easy'))}>{tr('很熟悉')}</Button></div>
          {props.onOpenApp && <Button type="button" variant="ghost" onClick={() => props.onOpenApp('ai-chat', { prompt: tr('请用我能理解的方式解释这个单词或短语，说明常见用法并给出例句。\n语种：{0}\n单词：{1}\n原句：{2}', [current.language, current.term, current.example]) })}>{tr('请 AI 解释')}</Button>}
        </div>}
      </> : available.length ? <div className="language-finished"><CheckCircle size={44} /><h3>{tr('本次练习已完成')}</h3><p className="app-muted">{seen.length ? tr('已练习 {0} 个单词', [seen.length]) : tr('今天没有待复习单词')}</p><Button type="button" variant="secondary" onClick={() => { setAll(true); setSeen([]); setPracticeId(null); }}>{tr('练习全部单词')}</Button><Button type="button" variant="ghost" onClick={() => navigate('library')}>{tr('返回词库')}</Button></div> : <div className="language-finished"><BookOpen size={44} /><h3>{tr('从第一个单词开始')}</h3><Button type="button" onClick={startNew}><Plus size={17} />{tr('添加单词')}</Button></div>}
    </section></div>}
    {view === 'library' && <div className={`language-library ${editing ? 'has-editor' : ''}`}>
      <section className="language-word-browser"><div className="app-toolbar"><Input type="search" aria-label={tr('搜索词库')} placeholder={tr('搜索词库')} value={query} onChange={(event) => setQuery(event.target.value)} /><Button type="button" size="icon" onClick={startNew} aria-label={tr('添加单词')}><Plus size={17} /></Button></div>
        <section className="language-word-list" aria-label={tr('个人词库')}>{matches.map((word) => <Button type="button" key={word.id} className="daily-record-title" variant={word.id === selectedWord?.id ? 'secondary' : 'ghost'} onClick={() => choose(word)}><strong>{word.term}</strong><span>{word.meaning}</span><small>{word.stage > 0 ? tr('已练习 · 熟悉程度 {0}', [word.stage]) : tr('新单词')}</small></Button>)}{!matches.length && <p className="app-empty">{tr('添加想学习的单词或短语')}</p>}</section>
      </section>
      {editing ? <form className="app-form language-editor" onSubmit={(event) => { event.preventDefault(); action.run(async () => {
          const normalized = normalizeWord(draft); let saved;
          await update((currentData) => { if (currentData.words.some((word) => word.id !== normalized.id && word.language === normalized.language && spellingMatches(word.term, normalized.term))) throw Error(tr('词库中已有这个单词。')); const result = upsertRecord(currentData.words, normalized, draft.id ? draft.revision : null, 10000); saved = result.saved; return { ...currentData, words: result.records }; }); select(saved); setLanguage(saved.language);
        }); }}>
          <header className="daily-pane-heading"><h3>{draft.id ? tr('编辑单词') : tr('添加单词')}</h3><Button type="button" variant="ghost" size="icon" aria-label={tr('关闭编辑')} onClick={cancelEdit}><X size={18} /></Button></header>
          <div className="daily-editor-scroll"><Field label={tr('单词或短语')}><Input autoFocus required maxLength={200} value={draft.term} onChange={(event) => patch({ term: event.target.value })} /></Field>
          <Select label={tr('语种')} value={draft.language} onChange={(value) => patch({ language: value })} options={languages()} />
          <Field label={tr('音标')}><Input maxLength={200} value={draft.phonetic} onChange={(event) => patch({ phonetic: event.target.value })} /></Field>
          <TextArea label={tr('释义')} required rows={3} maxLength={2000} value={draft.meaning} onChange={(event) => patch({ meaning: event.target.value })} />
          <TextArea label={tr('例句')} rows={3} maxLength={4000} value={draft.example} onChange={(event) => patch({ example: event.target.value })} />
          <Disclosure title={tr('译文与来源')}><div className="app-form"><TextArea label={tr('例句译文')} rows={2} maxLength={4000} value={draft.translation} onChange={(event) => patch({ translation: event.target.value })} /><Field label={tr('来源')}><Input maxLength={4096} value={draft.source} onChange={(event) => patch({ source: event.target.value })} /></Field><Field label={tr('标签')}><Input maxLength={500} value={draft.tags} onChange={(event) => patch({ tags: event.target.value })} /></Field></div></Disclosure>
          </div><div className="app-toolbar language-editor-actions">{draft.term && <Button type="button" variant="secondary" onClick={() => action.run(() => speak(draft))}><SpeakerHigh size={17} />{tr('发音')}</Button>}{draft.id && <Button type="button" variant="ghost" disabled={action.busy} onClick={() => setDeleting(draft)}><Trash size={16} />{tr('删除')}</Button>}<Button type="submit" disabled={!data || action.busy || !dirty || !draft.term.trim() || !draft.meaning.trim()}>{tr('保存')}</Button></div>
        </form> : selectedWord ? <article className="language-word-reader"><header className="language-word-heading"><div><p className="app-muted">{languages().find((item) => item.value === selectedWord.language)?.label || selectedWord.language}</p><h2>{selectedWord.term}</h2><span>{selectedWord.phonetic}</span></div><Button type="button" variant="ghost" size="icon" aria-label={tr('编辑单词')} onClick={() => edit(selectedWord)}><PencilSimple size={18} /></Button></header><h3>{selectedWord.meaning}</h3><Button type="button" variant="secondary" onClick={() => action.run(() => speak(selectedWord))}><SpeakerHigh size={18} />{tr('播放发音')}</Button>{selectedWord.example && <blockquote>{selectedWord.example}</blockquote>}{selectedWord.translation && <p>{selectedWord.translation}</p>}{selectedWord.source && <p className="app-muted">{tr('来源：{0}', [selectedWord.source])}</p>}{selectedWord.tags && <p className="app-muted">{selectedWord.tags}</p>}<div className="app-toolbar"><Button type="button" onClick={() => { setPracticeId(selectedWord.id); setAll(true); setSeen([]); setView('today'); }}>{tr('练习这个单词')}</Button>{props.onOpenApp && <Button type="button" variant="ghost" onClick={() => props.onOpenApp('ai-chat', { prompt: tr('请用我能理解的方式解释这个单词或短语，说明常见用法并给出例句。\n语种：{0}\n单词：{1}\n原句：{2}', [selectedWord.language, selectedWord.term, selectedWord.example]) })}>{tr('请 AI 解释')}</Button>}<Button type="button" variant="ghost" size="icon" aria-label={tr('删除')} onClick={() => setDeleting(selectedWord)}><Trash size={16} /></Button></div></article> : <div className="language-empty"><BookOpen size={36} /><p>{tr('添加想学习的单词或短语')}</p><Button type="button" onClick={startNew}>{tr('添加单词')}</Button></div>}
    </div>}
    {view === 'progress' && <section className="language-progress"><h2>{tr('学习进度')}</h2><div className="language-metrics">{[[tr('总词数'), available.length], [tr('待复习'), due.length], [tr('已掌握'), available.filter((word) => word.stage >= 5).length], [tr('今日练习'), todayReviews.length]].map(([label, value]) => <div key={label}><strong>{value}</strong><span>{label}</span></div>)}</div><h3>{tr('最近七天')}</h3><div className="language-progress-chart">{progressDays.map((day) => <div key={day.key} title={`${day.key}: ${day.count}`}><strong>{day.count || ''}</strong><span style={{ height: `${Math.max(3, day.count / maxReviews * 120)}px` }} /><small>{day.label}</small></div>)}</div><h3>{tr('最近练习')}</h3><div className="language-review-history">{reviews.filter((item) => item.language === language).slice(-20).reverse().map((review) => <div key={review.id}><strong>{words.find((word) => word.id === review.wordId)?.term || '—'}</strong><span>{review.correct ? tr('记住了') : tr('再练一次')}</span><time>{new Intl.DateTimeFormat(document.documentElement.lang || undefined, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(review.at))}</time></div>)}{!reviews.some((item) => item.language === language) && <p className="app-empty">{tr('暂无学习记录')}</p>}</div><Button type="button" variant="secondary" disabled={!available.length} onClick={begin}>{tr('开始学习')}</Button></section>}
    </fieldset>
    <DiscardPrompt pending={pending} onCancel={() => setPending(null)} onConfirm={() => { const next = pending; setPending(null); setDirty(false); if (next.language) { setLanguage(next.language); setSeen([]); setPracticeId(null); setEditing(false); } else if (next.view) { setView(next.view); setEditing(false); } else if (next.edit) edit(null); else if (next.closeEdit) setEditing(false); else select(next.word); }} />
    <DeletePrompt target={deleting} action={action} onCancel={() => setDeleting(null)} onConfirm={() => action.run(async () => { await update((currentData) => ({ ...currentData, words: removeRecord(currentData.words, deleting.id, deleting.revision), reviews: currentData.reviews.filter((item) => item.wordId !== deleting.id) })); select(null); setDeleting(null); })} />
  </div>;
}

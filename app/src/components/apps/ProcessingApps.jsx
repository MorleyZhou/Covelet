import PdfStudio from './processing-pdf.jsx';
import CanvasStudio from './processing-canvas.jsx';
import { FolderOpen, Copy, DownloadSimple, ArrowLeft, ArrowUp, ArrowDown } from '@phosphor-icons/react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { tr, getLocale } from '../../i18n/index.js';
import { useAppData, useAppAction, Field, AppError, downloadBlob, readTextFile, Button, Input, Textarea, Select } from './shared.jsx';
import { Checkbox } from '../ui/checkbox.jsx';
import Confirm from '../PromptDialog.jsx';
import { TEXT_LIMIT, IMAGE_LIMIT, OUTPUT_LIMIT, boundedText, parseToolJson, queryJson, compareJson, compareLines, encodeUtf8Base64, decodeUtf8Base64,
  fitImage, colorContrast, extractPalette, encodeWav, trimAudioChannels, waveformSamples } from '../../lib/processing-apps.js';
import './processing-apps.css';

const DEFAULT_OUTPUTS = { outputs: [] };
const bytesLabel = (size) => {
  const unit = size < 1024 ? 'B' : size < 1024 * 1024 ? 'KB' : 'MB', divisor = unit === 'B' ? 1 : unit === 'KB' ? 1024 : 1024 * 1024;
  return `${new Intl.NumberFormat(getLocale(), { maximumFractionDigits: unit === 'B' ? 0 : 2 }).format(size / divisor)} ${unit}`;
};
const newId = () => crypto.randomUUID();
const option = (value, label) => ({ value, label: tr(label) });
const guardFiles = (files, { maxCount = 20, maxBytes = OUTPUT_LIMIT, accept = () => true } = {}) => {
  if (!files.length || files.length > maxCount || files.reduce((sum, file) => sum + file.size, 0) > maxBytes || files.some((file) => !file.size || !accept(file))) throw Error(tr('文件为空、格式不支持或超出大小限制。'));
};
const appendOutputs = (data, next) => {
  const outputs = [...next, ...(data.outputs || [])];
  if (outputs.length > 100 || outputs.reduce((sum, item) => sum + item.blob.size, 0) > OUTPUT_LIMIT) throw Error(tr('处理结果过多，请先下载并移除旧文件。'));
  return { ...data, outputs };
};
function useOwnerState({ onDirtyChange, onBusyChange }, dirty, busy) {
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
}
function TextArea({ label, value, onChange, readOnly = false, rows = 12, ...props }) {
  const id = useId();
  return <div className="online-editor-pane"><label className="online-pane-heading" htmlFor={id}>{label}</label><Textarea id={id} className="app-textarea processing-code" aria-label={label} value={value} onChange={(event) => onChange?.(event.target.value)} readOnly={readOnly} rows={rows} maxLength={TEXT_LIMIT} spellCheck={false} {...props} /></div>;
}
function ProcessingSurface({ loaded, loading, error, actionError, onErrorClose, children, className = '' }) {
  return <div className={`processing-workspace ${className}`}><AppError message={error || actionError} onClose={onErrorClose} />{loaded ? children : loading ? <p role="status">{tr('正在载入…')}</p> : <p className="app-muted">{tr('内容未能载入，请重新打开此扩展。')}</p>}</div>;
}
function LocalBlob({ blob, children }) {
  const [url, setUrl] = useState('');
  useEffect(() => { if (!(blob instanceof Blob)) return; const next = URL.createObjectURL(blob); setUrl(next); return () => URL.revokeObjectURL(next); }, [blob]);
  return url ? children(url) : null;
}
function FileResults({ records = [], onDelete, busy, action: providedAction }) {
  const [pending, setPending] = useState(null), localAction = useAppAction(), action = providedAction || localAction;
  return <>{!providedAction && <AppError message={action.error} onClose={() => action.setError('')} />}
    <div className="app-list processing-files">{records.map((record) => <article className="app-card processing-result" key={record.id}>
      {record.blob?.type?.startsWith('image/') && <LocalBlob blob={record.blob}>{(url) => <img src={url} alt={record.name} />}</LocalBlob>}
      {record.blob?.type?.startsWith('audio/') && <LocalBlob blob={record.blob}>{(url) => <audio controls src={url} aria-label={record.name} preload="metadata" />}</LocalBlob>}
      {record.blob?.type?.startsWith('video/') && <LocalBlob blob={record.blob}>{(url) => <video controls src={url} aria-label={record.name} preload="metadata" />}</LocalBlob>}
      <div className="processing-result-name"><strong>{record.name}</strong><small className="app-muted">{record.width && record.height ? `${record.width} × ${record.height} · ` : ''}{bytesLabel(record.blob.size)}</small></div>
      <div className="app-toolbar"><Button variant="secondary" type="button" onClick={() => downloadBlob(record.blob, record.name)}>{tr('下载')}</Button><Button variant="ghost" type="button" disabled={busy || action.busy} onClick={() => setPending(record)}>{tr('移除')}</Button></div>
    </article>)}</div>
    {pending && <Confirm destructive action={tr('移除')} busy={busy || action.busy} onCancel={() => setPending(null)} onConfirm={() => action.run(async () => { await onDelete(pending.id); setPending(null); })}>{tr('移除“{0}”？尚未下载的文件将从此处删除。', [pending.name])}</Confirm>}
  </>;
}
function useRegexWorker() {
  const worker = useRef(null), timeout = useRef(null), rejection = useRef(null);
  const stop = () => { clearTimeout(timeout.current); worker.current?.terminate(); worker.current = null; if (rejection.current) { rejection.current(Error(tr('操作已取消。'))); rejection.current = null; } };
  useEffect(() => stop, []);
  return { stop, run: (payload) => {
    stop();
    return new Promise((resolve, reject) => {
      rejection.current = reject; const instance = new Worker(new URL('../../lib/processing-worker.js', import.meta.url), { type: 'module' }); worker.current = instance;
      const finish = () => { clearTimeout(timeout.current); instance.terminate(); if (worker.current === instance) worker.current = null; rejection.current = null; };
      instance.onmessage = (event) => { finish(); event.data.error ? reject(Error(event.data.error)) : resolve(event.data.result); };
      instance.onerror = () => { finish(); reject(Error(tr('无法运行正则，请重试。'))); };
      timeout.current = setTimeout(() => { finish(); reject(Error(tr('正则运行超时，请简化表达式。'))); }, 1500);
      instance.postMessage(payload);
    });
  } };
}

const ONLINE_DEFAULT = { text: '', right: '', mode: 'json', path: '$', expression: '', flags: 'g', replacement: '', history: [] };
function JsonTree({ value, name = '$', depth = 0 }) {
  const [expanded, setExpanded] = useState(depth === 0), [limit, setLimit] = useState(100);
  const compound = value !== null && typeof value === 'object', entries = compound ? Object.entries(value) : [];
  if (!compound) return <div className="processing-json-leaf"><strong>{name}</strong><code>{JSON.stringify(value)}</code></div>;
  return <div className="processing-json-branch"><Button variant="ghost" type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '▾' : '▸'} {name} <small>{Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}</small></Button>
    {expanded && depth < 40 && <div className="processing-json-children">{entries.slice(0, limit).map(([key, child]) => <JsonTree key={key} name={key} value={child} depth={depth + 1} />)}{entries.length > limit && <Button variant="ghost" type="button" onClick={() => setLimit((previous) => previous + 100)}>{tr('显示更多')}</Button>}</div>}
  </div>;
}
export function OnlineTools(props) {
  const { data, loading, loaded, error, update, revision } = useAppData('online-tools', ONLINE_DEFAULT), action = useAppAction(), regex = useRegexWorker();
  const textFile = useRef(null), initialTool = useRef(props.initialContext?.tool), contextApplied = useRef(false);
  const [draft, setDraft] = useState(ONLINE_DEFAULT), [baseRevision, setBaseRevision] = useState(0), [dirty, setDirty] = useState(false), [result, setResult] = useState(''), [lines, setLines] = useState(null), [tree, setTree] = useState(null), [ignoreWhitespace, setIgnoreWhitespace] = useState(false), [regexMatches, setRegexMatches] = useState(null), [jsonChanges, setJsonChanges] = useState(null), [historyOpen, setHistoryOpen] = useState(false), [resultReady, setResultReady] = useState(false);
  useEffect(() => { if (loaded && !dirty) { const next = { ...ONLINE_DEFAULT, ...data }; if (!contextApplied.current) { contextApplied.current = true; if (['json','diff','regex','encoding','text','time','format'].includes(initialTool.current)) next.mode = initialTool.current; } setDraft(next); setBaseRevision(revision); } }, [loaded, data, dirty, revision]);
  useOwnerState(props, dirty, loading || action.busy);
  const patch = (fields) => { setDraft((previous) => ({ ...previous, ...fields })); setDirty(true); setResult(''); setLines(null); setTree(null); setRegexMatches(null); setJsonChanges(null); setResultReady(false); };
  const show = (value) => { setResult(typeof value === 'string' ? value : JSON.stringify(value, null, 2)); setLines(null); setTree(null); setRegexMatches(null); setJsonChanges(null); setResultReady(true); };
  const execute = (kind) => action.run(async () => {
    boundedText(draft.text); boundedText(draft.right);
    switch (kind) {
      case 'json-format': show(JSON.stringify(parseToolJson(draft.text), null, 2)); break;
      case 'json-minify': show(JSON.stringify(parseToolJson(draft.text))); break;
      case 'json-tree': { const value = parseToolJson(draft.text); show(JSON.stringify(value, null, 2)); setTree({ value }); break; }
      case 'json-query': show(queryJson(parseToolJson(draft.text), draft.path)); break;
      case 'json-diff': { const next = compareJson(parseToolJson(draft.text), parseToolJson(draft.right)); show(next); setJsonChanges(next); break; }
      case 'text-diff': { const next = compareLines(draft.text, draft.right, { ignoreWhitespace }); show(next.map((line) => `${line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '} ${line.text}`).join('\n')); setLines(next); break; }
      case 'regex': { const next = await regex.run({ text: draft.text, expression: draft.expression, flags: draft.flags, replacement: draft.replacement }); show(next.replaced); setRegexMatches(next.matches); break; }
      case 'yaml': { const { stringify } = await import('yaml'); show(stringify(parseToolJson(draft.text), { lineWidth: 100 })); break; }
      case 'from-yaml': { const { parseDocument } = await import('yaml'); const document = parseDocument(draft.text, { uniqueKeys: true, schema: 'core' }); if (document.errors.length) throw document.errors[0]; const json = JSON.stringify(document.toJS({ maxAliasCount: 30 }), (_key, value) => { if (typeof value === 'number' && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) throw Error(tr('数字超出精确范围，请将长编号写为字符串。')); return value; }, 2); show(json); break; }
      case 'xml': { if (/<!DOCTYPE|<!ENTITY/i.test(draft.text)) throw Error(tr('不支持带外部声明的 XML。')); const xml = new DOMParser().parseFromString(draft.text, 'application/xml'); if (xml.querySelector('parsererror')) throw Error(tr('XML 格式无效。')); show(new XMLSerializer().serializeToString(xml)); break; }
      case 'format-js': case 'format-css': case 'format-html': {
        const { format } = await import('prettier/standalone'), language = kind.slice(7), plugins = language === 'js' ? [await import('prettier/plugins/babel'), await import('prettier/plugins/estree')] : language === 'css' ? [await import('prettier/plugins/postcss')] : [await import('prettier/plugins/html')];
        show(await format(draft.text, { parser: language === 'js' ? 'babel' : language, plugins, printWidth: 100 })); break;
      }
      case 'format-sql': { const { format } = await import('sql-formatter'); show(format(draft.text, { language: 'sql' })); break; }
      case 'base64-encode': show(encodeUtf8Base64(draft.text)); break;
      case 'base64-decode': show(decodeUtf8Base64(draft.text)); break;
      case 'url-encode': show(encodeURIComponent(draft.text)); break;
      case 'url-decode': show(decodeURIComponent(draft.text)); break;
      case 'jwt': { const parts = draft.text.trim().split('.'); if (parts.length !== 3) throw Error(tr('JWT 应包含三段内容。')); show({ header: parseToolJson(decodeUtf8Base64(parts[0])), payload: parseToolJson(decodeUtf8Base64(parts[1])) }); break; }
      case 'hash': { const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(draft.text)); show(Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')); break; }
      case 'timestamp': { const raw = draft.text.trim(), date = /^-?\d+(\.\d+)?$/.test(raw) ? new Date(Number(raw) * (Math.abs(Number(raw)) < 100000000000 ? 1000 : 1)) : new Date(raw); if (!Number.isFinite(date.getTime())) throw Error(tr('时间格式无效。')); show({ unix: Math.floor(date.getTime() / 1000), milliseconds: date.getTime(), iso: date.toISOString(), local: date.toLocaleString(getLocale()) }); break; }
      case 'uuid': show(Array.from({ length: 10 }, () => crypto.randomUUID()).join('\n')); break;
      case 'dedupe': show([...new Set(draft.text.split(/\r?\n/))].join('\n')); break;
      case 'sort': show(draft.text.split(/\r?\n/).sort((a, b) => a.localeCompare(b, getLocale())).join('\n')); break;
      case 'trim': show(draft.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join('\n')); break;
      case 'upper': show(draft.text.toLocaleUpperCase(getLocale())); break;
      case 'lower': show(draft.text.toLocaleLowerCase(getLocale())); break;
      default: break;
    }
  });
  const buttons = {
    json: [['json-format', tr('格式化')], ['json-minify', tr('压缩')], ['json-tree', tr('树形查看')], ['json-query', tr('查询')], ['yaml', tr('转为 YAML')], ['from-yaml', tr('YAML 转 JSON')], ['xml', tr('校验 XML')]],
    diff: [['text-diff', tr('文本对比')], ['json-diff', tr('JSON 对比')]], regex: [['regex', tr('匹配与替换')]],
    encoding: [['base64-encode', tr('Base64 编码')], ['base64-decode', tr('Base64 解码')], ['url-encode', tr('URL 编码')], ['url-decode', tr('URL 解码')], ['jwt', tr('JWT 解析')], ['hash', 'SHA-256']],
    text: [['dedupe', tr('按行去重')], ['sort', tr('按行排序')], ['trim', tr('整理空白')], ['upper', tr('转为大写')], ['lower', tr('转为小写')]], time: [['timestamp', tr('时间转换')], ['uuid', tr('生成 UUID')]],
    format: [['format-js', tr('JavaScript 格式化')], ['format-css', tr('CSS 格式化')], ['format-html', tr('HTML 格式化')], ['format-sql', tr('SQL 格式化')]],
  };
  const modes = [option('json', 'JSON 与结构化数据'), option('diff', '内容对比'), option('regex', '正则'), option('encoding', '编码与解析'), option('text', '文本整理'), option('time', '时间与标识'), option('format', '代码格式化')];
  return <ProcessingSurface className="online-studio" loaded={loaded} loading={loading} error={error} actionError={action.error} onErrorClose={() => action.setError('')}>
    <nav className="online-sidebar" aria-label={tr('工具')}>{modes.map((mode) => <Button type="button" variant={draft.mode === mode.value ? 'secondary' : 'ghost'} key={mode.value} title={mode.label} disabled={action.busy} onClick={() => patch({ mode: mode.value })}>{mode.label}</Button>)}<span className="online-sidebar-spacer" /><Button type="button" variant="ghost" onClick={() => setHistoryOpen(!historyOpen)}>{tr('保存的草稿')}</Button></nav>
    <main className="online-main"><header className="online-toolbar"><strong>{modes.find((mode) => mode.value === draft.mode)?.label}</strong><span className="pdf-toolbar-spacer" /><Button type="button" variant="secondary" disabled={action.busy} onClick={() => textFile.current.click()}><FolderOpen size={16} />{tr('打开文本文件')}</Button><Input ref={textFile} hidden type="file" aria-label={tr('打开文本文件')} accept=".txt,.json,.yaml,.yml,.xml,.js,.css,.html,.sql,.log" disabled={action.busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) action.run(async () => patch({ text: await readTextFile(file, TEXT_LIMIT) })); event.target.value = ''; }} /><Button type="button" variant="secondary" disabled={action.busy || !dirty} onClick={() => action.run(async () => { await update((latest) => ({ ...latest, ...draft, history: [{ id: newId(), name: draft.mode, text: draft.text, right: draft.right, at: Date.now() }, ...latest.history].slice(0, 8) }), { expectedRevision: baseRevision }); setDirty(false); })}>{tr('保存草稿')}</Button></header>
      {historyOpen && <div className="online-history">{data.history.length ? data.history.map((item) => <Button key={item.id} type="button" variant="ghost" onClick={() => { patch({ text: item.text, right: item.right || '', mode: item.name }); setHistoryOpen(false); }}>{new Date(item.at).toLocaleString(getLocale())} · {modes.find((mode) => mode.value === item.name)?.label}</Button>) : <p className="app-muted">{tr('暂无保存的草稿')}</p>}</div>}
      <div className={"online-options online-options-" + draft.mode} inert={action.busy}>{draft.mode === 'json' && <Field label={tr('查询路径')}><Input aria-label={tr('查询路径')} value={draft.path} placeholder="$.items[*].name" onChange={(event) => patch({ path: event.target.value })} /></Field>}{draft.mode === 'diff' && <label className="processing-check"><Checkbox checked={ignoreWhitespace} onCheckedChange={(value) => setIgnoreWhitespace(value === true)} />{tr('忽略空白')}</label>}{draft.mode === 'regex' && <><Field label={tr('表达式')}><Input aria-label={tr('表达式')} value={draft.expression} maxLength={600} onChange={(event) => patch({ expression: event.target.value })} /></Field><Field label={tr('标记')}><Input aria-label={tr('标记')} value={draft.flags} maxLength={9} onChange={(event) => patch({ flags: event.target.value })} /></Field><Field label={tr('替换内容')}><Input aria-label={tr('替换内容')} value={draft.replacement} maxLength={10000} onChange={(event) => patch({ replacement: event.target.value })} /></Field></>}{draft.mode === 'encoding' && <span className="app-muted">{tr('JWT 解析仅展示内容，不验证签名。')}</span>}</div>
      <div className="online-actions">{buttons[draft.mode].map(([kind,label]) => <Button type="button" variant="secondary" size="sm" key={kind} disabled={action.busy} onClick={() => execute(kind)}>{label}</Button>)}{action.busy && <span role="status">{tr('正在处理…')}</span>}</div>
      <div className={'online-editors ' + (draft.mode === 'diff' ? 'online-diff-layout' : '')}><div className="online-inputs" inert={action.busy}><TextArea label={draft.mode === 'diff' ? tr('原始内容') : tr('输入内容')} value={draft.text} onChange={(text) => patch({ text })} />{draft.mode === 'diff' && <TextArea label={tr('修改后内容')} value={draft.right} onChange={(right) => patch({ right })} />}</div>
      <section className="online-result" aria-label={tr('结果')}><div className="online-result-header"><strong>{tr('结果')}</strong>{resultReady && <><Button type="button" size="icon" variant="ghost" aria-label={tr('复制结果')} title={tr('复制结果')} onClick={() => action.run(() => navigator.clipboard.writeText(result))}><Copy size={16} /></Button><Button type="button" size="icon" variant="ghost" aria-label={tr('下载')} title={tr('下载')} onClick={() => downloadBlob(new Blob([result], { type: 'text/plain' }), 'result.txt')}><DownloadSimple size={16} /></Button><Button type="button" size="icon" variant="ghost" aria-label={tr('用作输入')} title={tr('用作输入')} onClick={() => patch({ text: result })}><ArrowLeft size={16} /></Button></>}</div><div className="online-result-content">
      {lines ? <div className="processing-diff" role="region" aria-label={tr('对比结果')}>{lines.map((line,i) => <div key={i} className={'processing-diff-' + line.type}><small>{line.left ?? ''}</small><small>{line.right ?? ''}</small><code>{line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '} {line.text || ' '}</code></div>)}</div>
      : jsonChanges ? <div className="online-json-changes">{!jsonChanges.length && <p className="app-muted">{tr('内容相同')}</p>}{jsonChanges.map((change,i) => <article key={i}><code>{change.path}</code>{Object.hasOwn(change,'before') && <pre className="processing-diff-removed">− {JSON.stringify(change.before,null,2)}</pre>}{Object.hasOwn(change,'after') && <pre className="processing-diff-added">+ {JSON.stringify(change.after,null,2)}</pre>}</article>)}</div>
      : tree ? <div className="processing-json-tree"><JsonTree key={result} value={tree.value} /></div>
      : regexMatches ? <div className="online-regex-results"><h4>{tr('{0} 处匹配', [regexMatches.length])}</h4><pre className="online-match-preview">{(() => { let cursor=0; const parts=[]; for (const [i,match] of regexMatches.entries()) { parts.push(draft.text.slice(cursor,match.index)); parts.push(<mark key={i} title={String(match.index)}>{match.text || '∅'}</mark>); cursor=match.index+match.text.length; } parts.push(draft.text.slice(cursor)); return parts; })()}</pre><div className="online-match-list">{regexMatches.slice(0,500).map((match,i) => <div key={i}><span>{i+1} · {match.index}</span><code>{match.text || '∅'}</code>{match.groups.map((group,j) => <small key={j}>${j+1}: {group === null ? '∅' : group}</small>)}{match.named && Object.entries(match.named).map(([key,value]) => <small key={key}>{key}: {value ?? '∅'}</small>)}</div>)}</div><h4>{tr('替换预览')}</h4><pre>{result}</pre></div>
      : resultReady ? <pre className="online-plain-result">{result || '∅'}</pre> : <p className="online-result-empty">{tr('选择操作后在这里查看结果')}</p>}</div></section></div>
    </main>
  </ProcessingSurface>;
}

const IMAGE_SETTINGS = { width: '', height: '', quality: '0.85', format: 'image/webp', crop: false, watermark: '', cropFocusX: .5, cropFocusY: .5, watermarkX: .9, watermarkY: .9 };
function drawRaster(context, image, fit, settings) {
  if (settings.format === 'image/jpeg') { context.fillStyle = '#fff'; context.fillRect(0, 0, fit.width, fit.height); }
  const x = settings.crop ? (image.width - fit.sourceWidth) * (settings.cropFocusX ?? .5) : fit.sourceX, y = settings.crop ? (image.height - fit.sourceHeight) * (settings.cropFocusY ?? .5) : fit.sourceY;
  context.drawImage(image, x, y, fit.sourceWidth, fit.sourceHeight, 0, 0, fit.width, fit.height);
  if (settings.watermark.trim()) { const size = Math.max(12, Math.min(64, fit.width / 24)); context.font = `${size}px system-ui`; context.textAlign = 'center'; context.textBaseline = 'middle'; context.lineWidth = Math.max(2, size / 10); context.strokeStyle = '#00000099'; context.fillStyle = '#ffffffdd'; const margin = Math.min(fit.width / 2, context.measureText(settings.watermark).width / 2 + 4), wx = Math.max(margin, Math.min(fit.width - margin, fit.width * (settings.watermarkX ?? .9))), wy = Math.max(size / 2, Math.min(fit.height - size / 2, fit.height * (settings.watermarkY ?? .9))); context.strokeText(settings.watermark, wx, wy); context.fillText(settings.watermark, wx, wy); }
}
function ImagePreview({ file, settings, onSettings, editMode }) {
  const canvas = useRef(null), gesture = useRef(null), bitmap = useRef(null), [imageVersion, setImageVersion] = useState(0), [failure, setFailure] = useState('');
  const artworkRect = (target) => { const box = target.getBoundingClientRect(), width = Math.min(box.width, box.height * target.width / target.height), height = width * target.height / target.width; return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height }; };
  useEffect(() => { let active = true; setFailure(''); bitmap.current?.close(); bitmap.current = null; createImageBitmap(file).then((image) => { if (!active) return image.close(); if (image.width * image.height > 40000000) { image.close(); setFailure(tr('图片尺寸过大或无效。')); return; } bitmap.current = image; setImageVersion((v) => v + 1); }).catch(() => active && setFailure(tr('图片转换失败。'))); return () => { active = false; bitmap.current?.close(); bitmap.current = null; }; }, [file]);
  useEffect(() => { if (!bitmap.current || !canvas.current) return; try { const image = bitmap.current, fit = fitImage(image.width, image.height, Number(settings.width || 0), Number(settings.height || 0), settings.crop), scale = Math.min(1, 1200 / fit.width, 900 / fit.height), target = canvas.current; target.width = Math.max(1, Math.round(fit.width * scale)); target.height = Math.max(1, Math.round(fit.height * scale)); const context = target.getContext('2d'); context.scale(scale, scale); drawRaster(context, image, fit, settings); setFailure(''); } catch (reason) { setFailure(reason.message); } }, [file, settings, imageVersion]);
  return <div className="image-stage">{failure ? <p role="alert">{failure}</p> : <canvas ref={canvas} aria-label={tr('图片预览')} className={editMode ? 'is-editing' : ''} onPointerDown={(event) => { if (!editMode || !onSettings || event.button !== 0) return; const rect = artworkRect(event.currentTarget); gesture.current = { x: event.clientX, y: event.clientY, settings, rect }; event.currentTarget.setPointerCapture(event.pointerId); if (editMode === 'watermark') onSettings({ watermarkX: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), watermarkY: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }); }} onPointerMove={(event) => { const current = gesture.current; if (!current) return; const unit = (value) => Math.max(0, Math.min(1, value)); onSettings(editMode === 'crop' ? { cropFocusX: unit((current.settings.cropFocusX ?? .5) - (event.clientX - current.x) / current.rect.width), cropFocusY: unit((current.settings.cropFocusY ?? .5) - (event.clientY - current.y) / current.rect.height) } : { watermarkX: unit((event.clientX - current.rect.left) / current.rect.width), watermarkY: unit((event.clientY - current.rect.top) / current.rect.height) }); }} onPointerUp={(event) => { gesture.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { gesture.current = null; }} />}</div>;
}
async function rasterImage(file, settings, signal) {
  if (signal.aborted) throw Error(tr('操作已取消。'));
  if (file.size > IMAGE_LIMIT || !/^image\/(png|jpeg|webp|gif|avif|bmp)$/.test(file.type)) throw Error(tr('图片格式不支持或文件过大。'));
  const image = await createImageBitmap(file);
  try {
    const fit = fitImage(image.width, image.height, Number(settings.width || 0), Number(settings.height || 0), settings.crop), canvas = document.createElement('canvas');
    canvas.width = fit.width; canvas.height = fit.height; const context = canvas.getContext('2d');
    drawRaster(context, image, fit, settings);
    const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(Error(tr('图片转换失败。'))), settings.format, Number(settings.quality)));
    if (signal.aborted) throw Error(tr('操作已取消。'));
    if (blob.type !== settings.format) throw Error(tr('当前浏览器不支持所选输出格式。'));
    const sample = document.createElement('canvas'); sample.width = Math.min(96, canvas.width); sample.height = Math.min(96, canvas.height); const sampleContext = sample.getContext('2d', { willReadFrequently: true }); sampleContext.drawImage(canvas, 0, 0, sample.width, sample.height);
    const palette = extractPalette(sampleContext.getImageData(0, 0, sample.width, sample.height).data);
    return { id: newId(), name: `${file.name.replace(/\.[^.]*$/, '').slice(0, 220)}.${({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' })[blob.type]}`, blob, width: canvas.width, height: canvas.height, palette, createdAt: Date.now() };
  } finally { image.close(); }
}
export function ImageTools(props) {
  const { data, loading, loaded, error, update, revision } = useAppData('images', { ...DEFAULT_OUTPUTS, settings: IMAGE_SETTINGS }), action = useAppAction();
  const [files, setFiles] = useState([]), [settings, setSettings] = useState(IMAGE_SETTINGS), [progress, setProgress] = useState(''), [foreground, setForeground] = useState('#000000'), [background, setBackground] = useState('#ffffff'), [activeIndex, setActiveIndex] = useState(0), [selectedOutput, setSelectedOutput] = useState(null), [editMode, setEditMode] = useState(''), [pendingImage, setPendingImage] = useState(null);
  const fileInput = useRef(null);
  const controller = useRef(null), initialized = useRef(false);
  useEffect(() => { if (loaded && !initialized.current) { initialized.current = true; setSettings({ ...IMAGE_SETTINGS, ...data.settings }); } }, [loaded, data]);
  useEffect(() => () => controller.current?.abort(), []); useOwnerState(props, files.length > 0, action.busy || loading);
  const process = () => action.run(async () => {
    guardFiles(files, { maxBytes: OUTPUT_LIMIT, accept: (file) => file.type.startsWith('image/') });
    if (!Number.isFinite(Number(settings.quality)) || Number(settings.quality) < .1 || Number(settings.quality) > 1) throw Error(tr('质量须在 0.1 至 1 之间。'));
    const currentRevision = revision, control = new AbortController(); controller.current = control; const outputs = [];
    try {
      for (let i = 0; i < files.length; i++) { setProgress(tr('正在处理 {0}/{1}', [i + 1, files.length])); outputs.push(await rasterImage(files[i], settings, control.signal)); if (outputs.reduce((sum, item) => sum + item.blob.size, 0) > OUTPUT_LIMIT) throw Error(tr('输出文件过大，请减少图片或缩小尺寸。')); }
      await update((latest) => ({ ...appendOutputs(latest, outputs), settings }), { expectedRevision: currentRevision }); setFiles([]); setSelectedOutput(outputs[0].id);
    } finally { setProgress(''); controller.current = null; }
  });
  const ratio = useMemo(() => { try { return colorContrast(foreground, background).toFixed(2); } catch { return '—'; } }, [foreground, background]);
  const selectedRecord = data.outputs.find((record) => record.id === selectedOutput) || (!files.length ? data.outputs[0] : null), activeFile = !selectedOutput ? files[activeIndex] || files[0] : null;
  const chooseImages = (incoming) => action.run(async () => { guardFiles(incoming, { maxBytes: OUTPUT_LIMIT, accept: (file) => /^image\/(png|jpeg|webp|gif|avif|bmp)$/.test(file.type) }); setFiles(incoming); setActiveIndex(0); setSelectedOutput(null); });
  const patchSettings = (fields) => setSettings((old) => ({ ...old, ...fields }));
  return <ProcessingSurface className="image-studio" loaded={loaded} loading={loading} error={error} actionError={action.error} onErrorClose={() => action.setError('')}>
    <header className="image-toolbar"><Button type="button" variant="secondary" disabled={action.busy} onClick={() => fileInput.current.click()}>{tr('添加图片')}</Button><Input hidden ref={fileInput} aria-label={tr('选择图片')} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp" multiple disabled={action.busy} onChange={(event) => { if (event.target.files?.length) chooseImages(Array.from(event.target.files)); event.target.value = ''; }} /><span className="pdf-toolbar-spacer" />{!!data.outputs.length && <Button type="button" variant="ghost" disabled={action.busy} onClick={() => action.run(async () => { const { zipSync } = await import('fflate'); const archive = {}; for (const [i,item] of data.outputs.entries()) archive[(i+1) + '-' + item.name] = new Uint8Array(await item.blob.arrayBuffer()); downloadBlob(new Blob([zipSync(archive,{ level:0 })],{ type:'application/zip' }),'images.zip'); })}>{tr('打包下载')}</Button>}{selectedRecord && <Button type="button" variant="secondary" onClick={() => downloadBlob(selectedRecord.blob, selectedRecord.name)}>{tr('下载')}</Button>}</header>
    <div className="image-body"><aside className="image-bin"><h3>{tr('源文件')}</h3>{files.map((file,index) => <Button type="button" variant={!selectedOutput && activeIndex === index ? 'secondary' : 'ghost'} key={index} disabled={action.busy} onClick={() => { setActiveIndex(index); setSelectedOutput(null); }}><LocalBlob blob={file}>{(url) => <img src={url} alt="" />}</LocalBlob><span>{file.name}<small>{bytesLabel(file.size)}</small></span></Button>)}{!!data.outputs.length && <h3>{tr('处理结果')}</h3>}{data.outputs.map((record) => <Button type="button" variant={selectedRecord?.id === record.id && !activeFile ? 'secondary' : 'ghost'} key={record.id} onClick={() => setSelectedOutput(record.id)}><LocalBlob blob={record.blob}>{(url) => <img src={url} alt="" />}</LocalBlob><span>{record.name}<small>{record.width} × {record.height} · {bytesLabel(record.blob.size)}</small></span></Button>)}</aside>
    <main className="image-preview-area" onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={(event) => { if (!event.dataTransfer.files.length || action.busy) return; event.preventDefault(); chooseImages(Array.from(event.dataTransfer.files)); }}>{activeFile ? <><ImagePreview file={activeFile} settings={settings} editMode={!action.busy ? editMode : ''} onSettings={patchSettings} /><div className="image-preview-caption"><strong>{activeFile.name}</strong><span>{editMode === 'crop' ? tr('拖动图片调整裁剪位置') : editMode === 'watermark' ? tr('点击或拖动设置水印位置') : tr('预览')}</span></div></> : selectedRecord ? <><LocalBlob blob={selectedRecord.blob}>{(url) => <div className="image-stage"><img src={url} alt={selectedRecord.name} /></div>}</LocalBlob><div className="image-preview-caption"><strong>{selectedRecord.name}</strong><span>{selectedRecord.width} × {selectedRecord.height} · {bytesLabel(selectedRecord.blob.size)}</span><Button type="button" variant="ghost" disabled={action.busy} onClick={() => setPendingImage(selectedRecord)}>{tr('移除')}</Button></div></> : <div className="studio-drop-zone"><h3>{tr('把图片拖到这里')}</h3><Button type="button" variant="secondary" onClick={() => fileInput.current.click()}>{tr('选择图片')}</Button></div>}</main>
    <aside className="image-inspector"><div className="image-settings" inert={action.busy}><h3>{tr('输出设置')}</h3><section className="processing-parameter-group"><Select label={tr('输出格式')} value={settings.format} onChange={(format) => patchSettings({format})} options={[option('image/webp','WebP'),option('image/jpeg','JPEG'),option('image/png','PNG')]} /><div className="studio-two-fields"><Field label={tr('最大宽度')}><Input type="number" min="1" max="8192" placeholder={tr('保持原尺寸')} value={settings.width} onChange={(event) => patchSettings({ width:event.target.value })} /></Field><Field label={tr('最大高度')}><Input type="number" min="1" max="8192" placeholder={tr('保持比例')} value={settings.height} onChange={(event) => patchSettings({height:event.target.value})} /></Field></div><Field label={<span className="processing-range-label"><span>{tr('质量')}</span><output>{Math.round(Number(settings.quality)*100)}%</output></span>}><Input type="range" min="0.1" max="1" step="0.05" value={settings.quality} aria-label={tr('质量')} onChange={(event) => patchSettings({quality:event.target.value})} /></Field></section><section className="processing-parameter-group"><label className="processing-check"><Checkbox checked={settings.crop} onCheckedChange={(crop) => { patchSettings({crop:crop === true}); setEditMode(crop ? 'crop' : ''); }} />{tr('裁剪至指定尺寸')}</label>{settings.crop && <Button type="button" variant={editMode === 'crop' ? 'secondary' : 'ghost'} disabled={!activeFile} onClick={() => setEditMode(editMode === 'crop' ? '' : 'crop')}>{tr('调整裁剪位置')}</Button>}</section><section className="processing-parameter-group"><Field label={tr('水印文字')}><Input maxLength={100} value={settings.watermark} onChange={(event) => patchSettings({watermark:event.target.value})} /></Field>{!!settings.watermark && <Button type="button" variant={editMode === 'watermark' ? 'secondary' : 'ghost'} disabled={!activeFile} onClick={() => setEditMode(editMode === 'watermark' ? '' : 'watermark')}>{tr('调整水印位置')}</Button>}</section></div>
    {selectedRecord?.palette && !activeFile && <div className="image-colors"><h3>{tr('提取配色')}</h3><div className="processing-palette">{selectedRecord.palette.map((color) => <Button type="button" variant="ghost" key={color} onClick={() => {setForeground(color); action.run(() => navigator.clipboard.writeText(color));}}><i style={{backgroundColor:color}} />{color}</Button>)}</div></div>}<details className="image-contrast"><summary>{tr('对比度检查')}</summary><div className="studio-two-fields"><Field label={tr('文字颜色')}><Input type="color" value={foreground} onChange={(event) => setForeground(event.target.value)} /></Field><Field label={tr('背景颜色')}><Input type="color" value={background} onChange={(event) => setBackground(event.target.value)} /></Field></div><strong style={{color:foreground,backgroundColor:background,padding:12,display:'block'}}>{tr('示例文字')}</strong><output>{ratio}:1</output></details></aside></div>
    <footer className="image-export-bar"><span>{tr('{0} 张图片', [files.length])}</span><span className="pdf-toolbar-spacer" />{action.busy ? <><span role="status">{progress || tr('正在处理…')}</span><Button type="button" variant="ghost" onClick={() => controller.current?.abort()}>{tr('取消')}</Button></> : <Button type="button" disabled={!files.length} onClick={process}>{tr('处理 {0} 张图片', [files.length])}</Button>}</footer>
    {pendingImage && <Confirm destructive action={tr('移除')} busy={action.busy} onCancel={() => setPendingImage(null)} onConfirm={() => action.run(async () => { await update((latest) => ({...latest,outputs:latest.outputs.filter((record) => record.id !== pendingImage.id)})); setPendingImage(null); setSelectedOutput(null); })}>{tr('移除“{0}”？尚未下载的文件将从此处删除。',[pendingImage.name])}</Confirm>}
  </ProcessingSurface>;
}

export function PdfTools(props) { return <PdfStudio {...props} />; }

function MediaTimeline({ duration, start, end, playhead, wave, onStart, onEnd, onSeek, disabled }) {
  const drag = useRef(null), svg = useRef(null), width = 1000, clamp = (value) => Math.max(0, Math.min(duration || 0, Number(value) || 0)), x = (value) => duration ? clamp(value) / duration * width : 0;
  const seek = (event) => { const rect = svg.current.getBoundingClientRect(), value = clamp((event.clientX - rect.left) / rect.width * duration); if (drag.current === 'start') onStart(Math.min(value, Math.max(0, clamp(end) - .01)).toFixed(2)); else if (drag.current === 'end') onEnd(Math.max(value, clamp(start) + .01).toFixed(2)); else onSeek(value); };
  const handleKey = (event, kind) => { if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key) || disabled) return; event.preventDefault(); const old = kind === 'start' ? clamp(start) : kind === 'end' ? clamp(end) : playhead, next = event.key === 'Home' ? 0 : event.key === 'End' ? duration : clamp(old + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1 : .1)); if (kind === 'start') onStart(Math.min(next, Math.max(0, clamp(end)-.01)).toFixed(2)); else if (kind === 'end') onEnd(Math.max(next,clamp(start)+.01).toFixed(2)); else onSeek(next); };
  return <div className="media-timeline"><svg ref={svg} viewBox="0 0 1000 180" preserveAspectRatio="none" aria-label={tr('时间选区')} role="group" onPointerDown={(event) => { if (disabled || !duration || event.button !== 0) return; event.preventDefault(); drag.current = event.target.dataset.handle || 'playhead'; event.currentTarget.setPointerCapture(event.pointerId); seek(event); }} onPointerMove={(event) => { if (drag.current) seek(event); }} onPointerUp={(event) => { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { drag.current = null; }}>
    <rect width="1000" height="180" fill="transparent" /><rect x={x(start)} y="0" width={Math.max(0,x(end)-x(start))} height="180" className="media-selected-region" />{wave.map(([min,max],index) => <line key={index} x1={index / wave.length * width} x2={index / wave.length * width} y1={85-max*60} y2={85-min*60} className="media-wave-line" />)}{!wave.length && Array.from({length:21},(_,index) => <g key={index}><line x1={index*50} x2={index*50} y1="155" y2="162" className="media-tick" /><text x={index*50} y="175" textAnchor={index===0?'start':index===20?'end':'middle'}>{(duration*index/20).toFixed(1)}</text></g>)}
    <g tabIndex={disabled ? -1 : 0} role="slider" aria-label={tr('开始时间（秒）')} aria-valuemin={0} aria-valuemax={duration} aria-valuenow={clamp(start)} onKeyDown={(event) => handleKey(event,'start')}><rect data-handle="start" x={x(start)-6} width="12" height="180" rx="3" className="media-range-handle" /><path d={`M${x(start)-2} 76v20M${x(start)+2} 76v20`} className="media-handle-grip" /></g>
    <g tabIndex={disabled ? -1 : 0} role="slider" aria-label={tr('结束时间（秒）')} aria-valuemin={0} aria-valuemax={duration} aria-valuenow={clamp(end)} onKeyDown={(event) => handleKey(event,'end')}><rect data-handle="end" x={x(end)-6} width="12" height="180" rx="3" className="media-range-handle" /><path d={`M${x(end)-2} 76v20M${x(end)+2} 76v20`} className="media-handle-grip" /></g>
    <g tabIndex={disabled ? -1 : 0} role="slider" aria-label={tr('播放位置')} aria-valuemin={0} aria-valuemax={duration} aria-valuenow={clamp(playhead)} onKeyDown={(event) => handleKey(event,'playhead')}><line x1={x(playhead)} x2={x(playhead)} y1="0" y2="180" className="media-playhead" /><path data-handle="playhead" d={`M${x(playhead)-8} 0h16l-8 12z`} className="media-playhead-tip" /><rect data-handle="playhead" x={x(playhead)-8} width="16" height="20" fill="transparent" /></g>
  </svg><div className="media-timeline-labels"><span>0:00</span><span>{tr('总时长：{0} 秒',[duration.toFixed(2)])}</span></div></div>;
}

async function mediaDuration(file, kind = 'audio') {
  const media = document.createElement(kind), url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(Error(tr('无法读取媒体信息。'))), 12000);
      const done = (reason) => { clearTimeout(timer); media.onloadedmetadata = media.onerror = null; reason ? reject(reason) : Number.isFinite(media.duration) && media.duration > 0 ? resolve(media.duration) : reject(Error(tr('媒体时长无效。'))); };
      media.preload = 'metadata'; media.onloadedmetadata = () => done(); media.onerror = () => done(Error(tr('浏览器无法解码这个文件。'))); media.src = url;
    });
  } finally { media.pause(); media.removeAttribute('src'); media.load(); URL.revokeObjectURL(url); }
}
async function captureVideo(file, start, end, audioOnly, signal, onProgress, preview) {
  if (!globalThis.MediaRecorder || !HTMLMediaElement.prototype.captureStream) throw Error(tr('当前浏览器不支持视频片段导出。'));
  const ownsVideo = !preview, video = preview || document.createElement('video'), url = ownsVideo ? URL.createObjectURL(file) : null, chunks = [], previousMuted = video.muted;
  let stream, recorder, size = 0, timer, deadline, finish;
  const mimeType = (audioOnly ? ['audio/webm;codecs=opus', 'audio/webm'] : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']).find((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) { if (url) URL.revokeObjectURL(url); throw Error(tr('当前浏览器不支持所选输出格式。')); }
  const wait = (event) => new Promise((resolve, reject) => { const timeout = setTimeout(() => done(Error(tr('无法读取媒体信息。'))), 15000); const done = (reason) => { clearTimeout(timeout); video.removeEventListener(event, success); video.removeEventListener('error', failure); signal.removeEventListener('abort', cancelled); reason ? reject(reason) : resolve(); }; const success = () => done(), failure = () => done(Error(tr('浏览器无法解码这个文件。'))), cancelled = () => done(Error(tr('操作已取消。'))); video.addEventListener(event, success, { once: true }); video.addEventListener('error', failure, { once: true }); signal.addEventListener('abort', cancelled, { once: true }); if (signal.aborted) cancelled(); });
  const aborted = () => finish?.(Error(tr('操作已取消。')));
  try {
    video.preload = 'auto'; video.muted = true; video.playsInline = true;
    if (ownsVideo) { video.src = url; await wait('loadedmetadata'); }
    else if (video.readyState < 1) await wait('loadedmetadata');
    if (video.readyState < 2) await wait('loadeddata');
    if (!Number.isFinite(video.duration) || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > video.duration + .1 || end - start > 600) throw Error(tr('视频片段须在文件范围内，且不超过 10 分钟。'));
    if (signal.aborted) throw Error(tr('操作已取消。'));
    if (Math.abs(video.currentTime - start) > .001 || video.seeking) { const seeked = wait('seeked'); video.currentTime = start; await seeked; }
    stream = video.captureStream(); await video.play();
    // Chromium exposes capture tracks after playback begins, not at metadata time.
    if (!stream.getTracks().length) await new Promise((resolve) => setTimeout(resolve, 150));
    const tracks = audioOnly ? stream.getAudioTracks() : stream.getTracks();
    if (!tracks.length || audioOnly && !stream.getAudioTracks().length) throw Error(tr('这个文件没有可导出的音轨。'));
    const output = new MediaStream(tracks); recorder = new MediaRecorder(output, { mimeType });
    return await new Promise((resolve, reject) => {
      let completed = false, failure = null;
      finish = (reason) => { if (completed) return; completed = true; failure = reason || null; clearInterval(timer); clearTimeout(deadline); video.pause(); if (recorder.state !== 'inactive') recorder.stop(); else failure ? reject(failure) : resolve(new Blob(chunks, { type: mimeType })); };
      recorder.ondataavailable = (event) => { if (event.data.size) { size += event.data.size; if (size > OUTPUT_LIMIT) { finish(Error(tr('输出文件过大，请缩短片段。'))); return; } chunks.push(event.data); } };
      recorder.onerror = () => finish(Error(tr('媒体导出失败。')));
      recorder.onstop = () => { failure ? reject(failure) : chunks.length ? resolve(new Blob(chunks, { type: mimeType })) : reject(Error(tr('没有生成媒体内容。'))); };
      video.onended = () => finish(); signal.addEventListener('abort', aborted, { once: true });
      recorder.start(250);
      deadline = setTimeout(() => finish(Error(tr('媒体导出超时，请缩短片段或重试。'))), (end - start) * 1000 + 60000);
      timer = setInterval(() => { onProgress(Math.min(1, (video.currentTime - start) / (end - start))); if (video.currentTime >= end || signal.aborted) finish(signal.aborted ? Error(tr('操作已取消。')) : null); }, 40);
    });
  } finally {
    signal.removeEventListener('abort', aborted); clearInterval(timer); clearTimeout(deadline); video.pause(); video.onended = null; video.muted = previousMuted;
    if (recorder?.state !== 'inactive') recorder?.stop(); stream?.getTracks().forEach((track) => track.stop());
    if (ownsVideo) { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
  }
}
export function MediaTools(props) {
  const { data, loading, loaded, error, update, revision } = useAppData('media', DEFAULT_OUTPUTS), action = useAppAction();
  const [kind, setKind] = useState(() => props.initialContext?.kind === 'video' ? 'video' : 'audio'), [files, setFiles] = useState([]), [decoded, setDecoded] = useState(null), [duration, setDuration] = useState(0), [start, setStart] = useState('0'), [end, setEnd] = useState(''), [gain, setGain] = useState('1'), [fade, setFade] = useState('0'), [audioOnly, setAudioOnly] = useState(false), [progress, setProgress] = useState(null);
  const [recording, setRecording] = useState(false), recordingRef = useRef(null), controller = useRef(null), preview = useRef(null), fileInput = useRef(null), audioPlayback = useRef(null), playbackFrame = useRef(null), playheadRef = useRef(0);
  const [playhead, setPlayhead] = useState(0), [playing, setPlaying] = useState(false), [historyOpen, setHistoryOpen] = useState(false);
  const wave = useMemo(() => waveformSamples(decoded?.channels?.[0] || []), [decoded]);
  useOwnerState(props, files.length > 0, action.busy || loading || recording);
  const position = (value) => { playheadRef.current = value; setPlayhead(value); };
  const pauseAudio = () => { cancelAnimationFrame(playbackFrame.current); preview.current?.pause(); const current = audioPlayback.current; audioPlayback.current = null; if (current) { current.source.onended = null; try { current.source.stop(); } catch {} current.context.close(); } setPlaying(false); };
  useEffect(() => { pauseAudio(); position(0); }, [decoded]);
  useEffect(() => () => { controller.current?.abort(); cancelAnimationFrame(playbackFrame.current); const playback = audioPlayback.current; if (playback) { playback.source.onended = null; try { playback.source.stop(); } catch {} playback.context.close(); } const current = recordingRef.current; if (current) { current.cancelled = true; clearTimeout(current.timer); current.recorder.stop(); current.stream.getTracks().forEach((track) => track.stop()); } }, []);
  const chooseFiles = (selected) => action.run(async () => {
    guardFiles(selected, { maxCount: kind === 'video' ? 1 : 10, maxBytes: OUTPUT_LIMIT, accept: (file) => file.type.startsWith(`${kind}/`) });
    pauseAudio();
    const commitInput = (next, seconds) => { position(0); setHistoryOpen(false); setFiles(selected); setDecoded(next); setDuration(seconds); setEnd(Math.min(seconds,600).toFixed(2)); setStart('0'); };
    if (kind === 'video') { const nextDuration = await mediaDuration(selected[0], 'video'); commitInput(null,nextDuration); return; }
    const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Context) throw Error(tr('当前浏览器不支持音频处理。'));
    const context = new Context({ sampleRate: 44100 });
    try {
      const buffers = []; let frames = 0;
      for (const file of selected) {
        const sourceDuration = await mediaDuration(file); if (sourceDuration > 600 || frames / context.sampleRate + sourceDuration > 600) throw Error(tr('音频总时长不能超过 10 分钟。'));
        const buffer = await context.decodeAudioData(await file.arrayBuffer()); frames += buffer.length; if (frames * 4 * 2 > 220 * 1024 * 1024) throw Error(tr('音频解码后过大，请缩短文件。')); buffers.push(buffer);
      }
      const count = Math.min(2, Math.max(...buffers.map((buffer) => buffer.numberOfChannels))), channels = Array.from({ length: count }, () => new Float32Array(frames)); let offset = 0;
      for (const buffer of buffers) { for (let channel = 0; channel < count; channel++) channels[channel].set(buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1)), offset); offset += buffer.length; }
      const next = { channels, sampleRate: context.sampleRate, length: frames, duration: frames / context.sampleRate, numberOfChannels: count, getChannelData: (channel) => channels[channel] };
      commitInput(next,next.duration);
    } finally { await context.close(); }
  });
  const process = () => action.run(async () => {
    pauseAudio(); const control = new AbortController(); controller.current = control; const capturedRevision = revision;
    try {
      let blob, name;
      if (kind === 'audio') { if (!decoded) throw Error(tr('请先选择可解码的音频文件。')); const channels = trimAudioChannels(decoded, Number(start), Math.min(Number(end), decoded.duration)); blob = encodeWav(channels, decoded.sampleRate, { gain: Number(gain), fade: Number(fade) }); name = 'audio.wav'; }
      else { if (!files[0] || !preview.current) throw Error(tr('请选择视频文件。')); setProgress(0); blob = await captureVideo(files[0], Number(start), Number(end), audioOnly, control.signal, setProgress, preview.current); name = audioOnly ? 'audio.webm' : 'video.webm'; }
      if (control.signal.aborted) throw Error(tr('操作已取消。'));
      await update((latest) => appendOutputs(latest, [{ id: newId(), name, blob, createdAt: Date.now() }]), { expectedRevision: capturedRevision }); setFiles([]); setDecoded(null); setDuration(0); setEnd(''); setHistoryOpen(true);
    } finally { controller.current = null; setProgress(null); }
  });
  const toggleRecording = () => {
    if (recordingRef.current) { clearTimeout(recordingRef.current.timer); recordingRef.current.recorder.stop(); recordingRef.current.stream.getTracks().forEach((track) => track.stop()); return; }
    action.run(async () => {
      if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) throw Error(tr('当前浏览器不支持录音。'));
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true }), recorder = new MediaRecorder(stream), chunks = [];
      const owner = { stream, recorder, timer: null, cancelled: false }; recordingRef.current = owner; let size = 0;
      recorder.ondataavailable = (event) => { if (event.data.size) { chunks.push(event.data); size += event.data.size; if (size > IMAGE_LIMIT && recorder.state === 'recording') recorder.stop(); } };
      recorder.onstop = () => { clearTimeout(owner.timer); stream.getTracks().forEach((track) => track.stop()); recordingRef.current = null; setRecording(false); if (!owner.cancelled && chunks.length) { const blob = new Blob(chunks, { type: recorder.mimeType }); chooseFiles([new File([blob], 'recording.webm', { type: blob.type })]); } };
      recorder.onerror = () => { owner.cancelled = true; if (recorder.state !== 'inactive') recorder.stop(); setRecording(false); action.setError(tr('录音失败，请检查麦克风权限。')); };
      owner.timer = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 300000); recorder.start(250); setRecording(true);
    });
  };
  const seek = (value) => { const next = Math.max(0, Math.min(duration, value)); if (kind === 'audio') pauseAudio(); else if (preview.current && !action.busy) preview.current.currentTime = next; position(next); };
  const togglePlay = () => action.run(async () => {
    if (kind === 'video') { if (!preview.current) return; if (preview.current.paused) { if (preview.current.currentTime < Number(start) || preview.current.currentTime >= Number(end)) preview.current.currentTime = Number(start); await preview.current.play(); } else preview.current.pause(); return; }
    if (playing) { pauseAudio(); return; } if (!decoded) return;
    const from = playheadRef.current < Number(start) || playheadRef.current >= Number(end) ? Number(start) : playheadRef.current, to = Math.min(Number(end),decoded.duration); if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from) throw Error(tr('开始与结束时间无效。'));
    const Context = globalThis.AudioContext || globalThis.webkitAudioContext, context = new Context({ sampleRate:decoded.sampleRate });
    try { const buffer = context.createBuffer(decoded.numberOfChannels,decoded.length,decoded.sampleRate); decoded.channels.forEach((channel,index) => buffer.copyToChannel(channel,index)); const source = context.createBufferSource(), volume = context.createGain(); source.buffer = buffer; source.connect(volume); volume.connect(context.destination); const level = Number(gain), fadeSeconds = Number(fade); if (!Number.isFinite(level) || level < 0 || level > 4 || !Number.isFinite(fadeSeconds) || fadeSeconds < 0 || fadeSeconds > 30) throw Error(tr('音量或淡入淡出参数无效。')); volume.gain.value = level; const fadeDuration = Math.min(fadeSeconds,(to-from)/2); if (fadeDuration > 0) { volume.gain.setValueAtTime(0,context.currentTime); volume.gain.linearRampToValueAtTime(level,context.currentTime+fadeDuration); volume.gain.setValueAtTime(level,context.currentTime+to-from-fadeDuration); volume.gain.linearRampToValueAtTime(0,context.currentTime+to-from); } await context.resume(); const began = context.currentTime; audioPlayback.current={context,source}; source.onended=()=>{ if (audioPlayback.current?.source === source) { position(to); pauseAudio(); } }; source.start(0,from,to-from); position(from); setPlaying(true); const tick=()=>{ if (audioPlayback.current?.source !== source) return; position(Math.min(to,from+context.currentTime-began)); playbackFrame.current=requestAnimationFrame(tick); }; tick(); }
    catch(reason) { await context.close(); throw reason; }
  });
  return <ProcessingSurface className="media-studio" loaded={loaded} loading={loading} error={error} actionError={action.error} onErrorClose={() => action.setError('')}>
    <header className="media-toolbar"><Select label={tr('媒体类型')} value={kind} disabled={action.busy || recording} onChange={(value) => { pauseAudio(); setKind(value); setFiles([]); setDecoded(null); setDuration(0); setHistoryOpen(false); position(0); }} options={[option('audio','音频'),option('video','视频')]} /><Button type="button" variant="secondary" disabled={action.busy || recording} onClick={() => fileInput.current.click()}>{tr('添加文件')}</Button><Input ref={fileInput} hidden aria-label={tr('选择文件')} type="file" accept={kind+'/*'} multiple={kind === 'audio'} disabled={action.busy || recording} onChange={(event) => { const selected=Array.from(event.target.files || []); if(selected.length) chooseFiles(selected); event.target.value=''; }} />{kind === 'audio' && <Button type="button" variant={recording?'destructive':'ghost'} disabled={action.busy} onClick={toggleRecording}>{recording?tr('停止录音'):tr('录音')}</Button>}<span className="pdf-toolbar-spacer" /><Button type="button" variant={historyOpen?'secondary':'ghost'} disabled={action.busy || recording} onClick={() => { pauseAudio(); setHistoryOpen(!historyOpen); }}>{tr('导出记录')}</Button></header>
    <div className="media-body"><aside className="media-bin"><h3>{tr('源文件')}</h3>{files.map((file,index) => <article key={index}><span>{index+1}</span><div><strong>{file.name}</strong><small>{bytesLabel(file.size)}</small></div>{kind === 'audio' && files.length>1 && <div><Button type="button" size="icon" variant="ghost" aria-label={tr('上移')} disabled={index===0 || action.busy} onClick={() => { const next=[...files]; [next[index-1],next[index]]=[next[index],next[index-1]]; chooseFiles(next); }}><ArrowUp size={16} /></Button><Button type="button" size="icon" variant="ghost" aria-label={tr('下移')} disabled={index===files.length-1 || action.busy} onClick={() => { const next=[...files]; [next[index+1],next[index]]=[next[index],next[index+1]]; chooseFiles(next); }}><ArrowDown size={16} /></Button></div>}</article>)}</aside>
    <main className="media-editor" onDragOver={(event) => { if(event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={(event) => { if(!event.dataTransfer.files.length || action.busy || recording) return; event.preventDefault(); chooseFiles(Array.from(event.dataTransfer.files)); }}>
    {historyOpen ? <div className="media-history"><FileResults records={data.outputs} busy={action.busy} action={action} onDelete={(id) => update((latest) => ({...latest,outputs:latest.outputs.filter((record) => record.id!==id)}))} />{!data.outputs.length && <p className="app-empty">{tr('暂无导出文件')}</p>}</div> : <><div className={'media-preview ' + (kind==='audio'?'is-audio':'')}>{kind==='video' && files[0] ? <LocalBlob blob={files[0]}>{(url) => <video ref={preview} src={url} controls={false} preload="auto" aria-label={tr('源文件预览')} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onTimeUpdate={(event) => { if(action.busy) return; const video=event.currentTarget; position(video.currentTime); if(video.currentTime >= Number(end) && !video.paused) video.pause(); }} />}</LocalBlob> : recording ? <p role="status">{tr('正在录音…')}</p> : !duration ? <div className="studio-drop-zone"><h3>{kind==='audio'?tr('把音频拖到这里'):tr('把视频拖到这里')}</h3><Button type="button" variant="secondary" disabled={action.busy || recording} onClick={() => fileInput.current.click()}>{tr('选择文件')}</Button></div> : <div className="media-audio-heading"><strong>{files.length===1?files[0]?.name:tr('{0} 个音频片段',[files.length])}</strong><span>{tr('拖动两端选择导出范围')}</span></div>}</div>
    {duration>0 && <><div className="media-transport"><Button type="button" variant="secondary" disabled={action.busy || recording} onClick={togglePlay}>{playing?tr('暂停'):tr('播放')}</Button><output>{playhead.toFixed(2)} / {duration.toFixed(2)} s</output><span className="pdf-toolbar-spacer" /><Button type="button" variant="ghost" disabled={action.busy} onClick={() => seek(Number(start))}>{tr('跳到起点')}</Button><Button type="button" variant="ghost" disabled={action.busy} onClick={() => seek(Number(end))}>{tr('跳到终点')}</Button></div><MediaTimeline duration={duration} start={start} end={end} playhead={playhead} wave={kind==='audio'?wave:[]} onStart={(value) => { pauseAudio(); setStart(value); }} onEnd={(value) => { pauseAudio(); setEnd(value); }} onSeek={seek} disabled={action.busy || recording} /></>}</>}
    </main><aside className="media-inspector" inert={action.busy || recording || historyOpen}><h3>{tr('片段设置')}</h3><Field label={tr('开始时间（秒）')}><Input type="number" min="0" max={duration || undefined} step="0.01" value={start} onChange={(event) => {pauseAudio();setStart(event.target.value);}} /></Field><Field label={tr('结束时间（秒）')}><Input type="number" min="0" max={duration || undefined} step="0.01" value={end} onChange={(event) => {pauseAudio();setEnd(event.target.value);}} /></Field>{kind==='audio' ? <><Field label={tr('音量倍数')}><Input type="number" min="0" max="4" step="0.1" value={gain} onChange={(event) => {pauseAudio();setGain(event.target.value);}} /></Field><Field label={tr('淡入淡出（秒）')}><Input type="number" min="0" max="30" step="0.1" value={fade} onChange={(event) => {pauseAudio();setFade(event.target.value);}} /></Field><p className="app-muted">WAV · 44.1 kHz</p></> : <><label className="processing-check"><Checkbox checked={audioOnly} onCheckedChange={(value) => setAudioOnly(value===true)} />{tr('仅提取音轨')}</label><p className="app-muted">{tr('视频按播放速度导出为 WebM，请保持此页面打开。')}</p></>}</aside></div>
    <footer className="media-export-bar"><span>{!historyOpen && duration>0 && Number(end)>Number(start) ? tr('选区：{0} 秒',[(Number(end)-Number(start)).toFixed(2)]):''}</span><span className="pdf-toolbar-spacer" />{action.busy && <span role="status">{progress===null?tr('正在处理…'):tr('正在导出 {0}%',[Math.round(progress*100)])}</span>}{progress!==null && <Button type="button" variant="ghost" onClick={() => controller.current?.abort()}>{tr('取消')}</Button>}{historyOpen ? files.length > 0 && <Button type="button" variant="secondary" onClick={() => setHistoryOpen(false)}>{tr('返回')}</Button> : <Button type="button" onClick={process} disabled={action.busy || recording || !duration || kind==='audio'&&!decoded}>{tr('导出片段')}</Button>}</footer>
  </ProcessingSurface>;
}

export function CanvasTools(props) { return <CanvasStudio {...props} />; }

export default function ProcessingApps({ appId, ...props }) {
  const Component = { 'online-tools': OnlineTools, images: ImageTools, pdf: PdfTools, media: MediaTools, canvas: CanvasTools }[appId];
  return Component ? <Component {...props} /> : null;
}

import { useEffect, useRef, useState } from 'react';
import { Plus, Trash, ArrowClockwise, ArrowUUpLeft, DownloadSimple, FolderOpen, FilePdf, CheckSquare, SquaresFour, X } from '@phosphor-icons/react';
import { tr } from '../../i18n/index.js';
import { useAppData, useAppAction, AppError, Button, Input, Select, downloadBlob } from './shared.jsx';
import Confirm from '../PromptDialog.jsx';
import { OUTPUT_LIMIT, reorderPdfPages } from '../../lib/processing-apps.js';

let rendererPromise;
const id = () => crypto.randomUUID(), DEFAULTS = { outputs: [] };
async function renderer() {
  if (!rendererPromise) rendererPromise = import('pdfjs-dist/build/pdf.mjs').then((engine) => { engine.GlobalWorkerOptions.workerPort = new Worker(new URL('../../lib/processing-pdf-worker.js', import.meta.url), { type: 'module' }); return engine; });
  return rendererPromise;
}
let thumbnailsActive = 0; const thumbnailQueue = [];
function thumbnailJob(work) {
  return new Promise((resolve, reject) => { thumbnailQueue.push({ work, resolve, reject }); nextThumbnail(); });
}
function nextThumbnail() {
  if (thumbnailsActive >= 3 || !thumbnailQueue.length) return;
  const job = thumbnailQueue.shift(); thumbnailsActive++;
  Promise.resolve().then(job.work).then(job.resolve, job.reject).finally(() => { thumbnailsActive--; nextThumbnail(); });
}
function PageThumbnail({ source, pageIndex, rotation = 0, width = 144, scrollRoot }) {
  const canvas = useRef(null), host = useRef(null), [visible, setVisible] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    setError('');
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { root: scrollRoot?.current || null, rootMargin: '180px' });
    if (host.current) observer.observe(host.current); return () => observer.disconnect();
  }, [source.id]);
  useEffect(() => {
    if (!visible) return; let live = true, renderTask;
    thumbnailJob(async () => {
      if (!live || !canvas.current) return;
      const target = canvas.current, density = Math.min(2, devicePixelRatio || 1), context = target.getContext('2d', { alpha: false });
      if (source.kind === 'image') {
        const bitmap = await createImageBitmap(source.file);
        try { if (!live) return; const sideways = rotation % 180 !== 0, w = sideways ? bitmap.height : bitmap.width, h = sideways ? bitmap.width : bitmap.height, scale = Math.min(width * density / w, width * 1.5 * density / h); target.width = Math.max(1,Math.round(w * scale)); target.height = Math.max(1,Math.round(h * scale)); context.fillStyle = '#fff'; context.fillRect(0, 0, target.width, target.height); context.translate(target.width / 2, target.height / 2); context.rotate(rotation * Math.PI / 180); context.drawImage(bitmap, -bitmap.width * scale / 2, -bitmap.height * scale / 2, bitmap.width * scale, bitmap.height * scale); }
        finally { bitmap.close(); }
      } else {
        const page = await source.document.getPage(pageIndex + 1); if (!live) return;
        const initial = page.getViewport({ scale: 1, rotation: (page.rotate + rotation) % 360 }), viewport = page.getViewport({ scale: Math.min(width * density / initial.width, width * 1.5 * density / initial.height), rotation: (page.rotate + rotation) % 360 });
        target.width = Math.ceil(viewport.width); target.height = Math.ceil(viewport.height); renderTask = page.render({ canvas: target, canvasContext: context, viewport, background: '#ffffff' }); await renderTask.promise;
      }
      if (live) target.dataset.rendered = 'true';
    }).catch((reason) => { if (live && reason.name !== 'RenderingCancelledException') setError(tr('此页无法预览，请检查原文件。')); });
    return () => { live = false; renderTask?.cancel(); };
  }, [visible, source, pageIndex, rotation, width]);
  return <div ref={host} className="pdf-thumbnail" style={{ width, minHeight: width * .75 }}><canvas ref={canvas} aria-label={tr('第 {0} 页预览', [pageIndex + 1])} />{error && <span className="pdf-thumbnail-error">{error}</span>}</div>;
}
function ResultRow({ record, onOpen, onRemove, busy }) {
  return <div className="pdf-history-row"><FilePdf size={23} /><div><strong>{record.name}</strong><small>{tr('{0} 页', [record.pages])}</small></div><Button type="button" variant="ghost" disabled={busy} onClick={onOpen}>{tr('打开')}</Button><Button type="button" variant="ghost" onClick={() => downloadBlob(record.blob, record.name)} aria-label={tr('下载')}><DownloadSimple size={16} /></Button><Button type="button" variant="ghost" disabled={busy} onClick={onRemove} aria-label={tr('移除')}><Trash size={15} /></Button></div>;
}

export default function PdfStudio({ onDirtyChange, onBusyChange }) {
  const { data, loaded, loading, error, update, revision } = useAppData('pdf', DEFAULTS), action = useAppAction();
  const [sources, setSources] = useState([]), [pages, setPages] = useState([]), [past, setPast] = useState([]), [dirty, setDirty] = useState(false), [mode, setMode] = useState('merge');
  const [sidebar, setSidebar] = useState(true), [showHistory, setShowHistory] = useState(false), [previewId, setPreviewId] = useState(null), [progress, setProgress] = useState(''), [pending, setPending] = useState(null);
  const input = useRef(null), grid = useRef(null), controller = useRef(null), activeSources = useRef([]), dragging = useRef([]);
  const selected = pages.filter((page) => page.selected), sourceById = new Map(sources.map((source) => [source.id, source])), preview = pages.find((page) => page.id === previewId);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(loading || action.busy); return () => onBusyChange?.(false); }, [loading, action.busy, onBusyChange]);
  useEffect(() => { activeSources.current = sources; }, [sources]);
  useEffect(() => () => { controller.current?.abort(); activeSources.current.forEach((source) => source.document?.destroy()); }, []);
  const change = (transform) => { if (action.busy) return; setPast((old) => [...old.slice(-19), pages.map((page) => ({ ...page }))]); setPages((old) => transform(old)); setDirty(true); };
  const addFiles = (incoming) => action.run(async () => {
    const files = Array.from(incoming || []), prepared = [];
    if (!files.length || sources.length + files.length > 20 || [...sources.map((source) => source.file), ...files].reduce((sum, file) => sum + file.size, 0) > OUTPUT_LIMIT) throw Error(tr('文件为空、格式不支持或超出大小限制。'));
    try {
      for (const file of files) {
        if (!file.size) throw Error(tr('文件为空、格式不支持或超出大小限制。'));
        if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) { const engine = await renderer(), task = engine.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false, useSystemFonts: true, useWasm: false, useWorkerFetch: false, disableAutoFetch: true, enableXfa: false, stopAtErrors: true }); const document = await task.promise; prepared.push({ id: id(), file, document, count: document.numPages, kind: 'pdf' }); }
        else if (['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { const bitmap = await createImageBitmap(file); try { if (bitmap.width * bitmap.height > 24000000) throw Error(tr('图片尺寸过大或无效。')); } finally { bitmap.close(); } prepared.push({ id: id(), file, count: 1, kind: 'image' }); }
        else throw Error(tr('文件为空、格式不支持或超出大小限制。'));
      }
      if (pages.length + prepared.reduce((sum, source) => sum + source.count, 0) > 2000) throw Error(tr('一次最多处理 2000 页。'));
      setSources((old) => [...old, ...prepared]); setPast((old) => [...old.slice(-19), pages]); setPages((old) => [...old, ...prepared.flatMap((source) => Array.from({ length: source.count }, (_, pageIndex) => ({ id: id(), sourceId: source.id, pageIndex, rotation: 0, selected: true })))]); setDirty(true); setShowHistory(false);
    } catch (reason) { prepared.forEach((source) => source.document?.destroy()); throw reason; }
  });
  const reorder = (targetId) => {
    const ids = dragging.current; if (!ids.length || ids.includes(targetId)) return;
    change((old) => reorderPdfPages(old, ids, targetId)); dragging.current = [];
  };
  const shiftPage = (pageId, direction) => change((old) => { const next = [...old], at = next.findIndex((page) => page.id === pageId), target = at + direction; if (target >= 0 && target < next.length) [next[at], next[target]] = [next[target], next[at]]; return next; });
  const process = () => action.run(async () => {
    if (!selected.length) return;
    const capturedRevision = revision, control = new AbortController(); controller.current = control;
    try {
      const { PDFDocument, degrees } = await import('pdf-lib'), loadedInputs = new Map(), outputs = []; let combined = await PDFDocument.create();
      for (let at = 0; at < selected.length; at++) {
        if (control.signal.aborted) throw Error(tr('操作已取消。')); const item = selected[at], source = sourceById.get(item.sourceId); setProgress(tr('正在处理 {0}/{1}', [at + 1, selected.length]));
        const document = mode === 'split' ? await PDFDocument.create() : combined;
        if (source.kind === 'image') {
          let embedded;
          if (source.file.type === 'image/png') embedded = await document.embedPng(await source.file.arrayBuffer());
          else if (source.file.type === 'image/jpeg') embedded = await document.embedJpg(await source.file.arrayBuffer());
          else { const bitmap = await createImageBitmap(source.file); try { const canvas = window.document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext('2d').drawImage(bitmap, 0, 0); const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png')); if (!png) throw Error(tr('图片转换失败。')); embedded = await document.embedPng(await png.arrayBuffer()); } finally { bitmap.close(); } }
          const page = document.addPage([embedded.width, embedded.height]); page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height }); page.setRotation(degrees(item.rotation));
        } else { if (!loadedInputs.has(source.id)) loadedInputs.set(source.id, await PDFDocument.load(await source.file.arrayBuffer(), { updateMetadata: false })); const [page] = await document.copyPages(loadedInputs.get(source.id), [item.pageIndex]); page.setRotation(degrees((page.getRotation().angle + item.rotation) % 360)); document.addPage(page); }
        if (mode === 'split') { if (outputs.length >= 100) throw Error(tr('拆分结果超过 100 个文件，请缩小页码范围。')); outputs.push({ id: id(), name: `${source.file.name.replace(/\.[^.]*$/, '').slice(0, 210)}-${at + 1}.pdf`, blob: new Blob([await document.save()], { type: 'application/pdf' }), pages: 1, createdAt: Date.now() }); }
      }
      if (mode !== 'split') outputs.push({ id: id(), name: 'document.pdf', blob: new Blob([await combined.save()], { type: 'application/pdf' }), pages: selected.length, createdAt: Date.now() });
      if (control.signal.aborted) throw Error(tr('操作已取消。'));
      await update((latest) => { const all = [...outputs, ...latest.outputs]; if (all.length > 100 || all.reduce((sum, record) => sum + record.blob.size, 0) > OUTPUT_LIMIT) throw Error(tr('处理结果过多，请先下载并移除旧文件。')); return { ...latest, outputs: all }; }, { expectedRevision: capturedRevision }); setDirty(false); setShowHistory(true);
    } finally { setProgress(''); controller.current = null; }
  });
  return <section className="processing-workspace pdf-studio" aria-label={tr('PDF 工具')}><AppError message={error || action.error} onClose={() => action.setError('')} />
    {!loaded ? <p role="status">{loading ? tr('正在载入…') : tr('内容未能载入，请重新打开此扩展。')}</p> : <>
      <header className="pdf-toolbar"><Button type="button" variant="ghost" size="icon" aria-label={tr('文件列表')} onClick={() => setSidebar(!sidebar)}><FolderOpen size={18} /></Button><Button type="button" variant="secondary" disabled={action.busy} onClick={() => input.current.click()}><Plus size={16} />{tr('添加文件')}</Button><Input ref={input} hidden type="file" aria-label={tr('添加文件')} accept="application/pdf,image/png,image/jpeg,image/webp,.pdf" multiple disabled={action.busy} onChange={(event) => { if (event.target.files?.length) addFiles(event.target.files); event.target.value = ''; }} />
        <span className="pdf-toolbar-divider" /><div className="pdf-selection-tools" role="group" aria-label={tr('文档页面')}><Button type="button" variant="ghost" size="icon" aria-label={tr('全选页面')} title={tr('全选页面')} aria-pressed={pages.length > 0 && pages.every((page) => page.selected)} disabled={!pages.length || action.busy} onClick={() => change((old) => old.map((page) => ({ ...page, selected: !pages.every((item) => item.selected) })))}><CheckSquare size={18} /></Button><Button type="button" variant="ghost" size="icon" aria-label={tr('旋转')} title={tr('旋转')} disabled={!selected.length || action.busy} onClick={() => change((old) => old.map((page) => page.selected ? { ...page, rotation: (page.rotation + 90) % 360 } : page))}><ArrowClockwise size={18} /></Button><Button type="button" variant="ghost" size="icon" aria-label={tr('移除')} title={tr('移除')} disabled={!selected.length || action.busy} onClick={() => change((old) => old.filter((page) => !page.selected))}><Trash size={18} /></Button><Button type="button" variant="ghost" size="icon" disabled={!past.length || action.busy} aria-label={tr('撤销')} title={tr('撤销')} onClick={() => { setPages(past.at(-1)); setPast((old) => old.slice(0, -1)); setDirty(true); }}><ArrowUUpLeft size={18} /></Button></div><span className="pdf-toolbar-spacer" /><Button type="button" variant={showHistory ? 'secondary' : 'ghost'} onClick={() => setShowHistory(!showHistory)}>{tr('导出记录')}</Button>
      </header>
      <div className="pdf-main">{sidebar && <aside className="pdf-sources"><h3>{tr('文件')}</h3>{sources.map((source) => <div className="pdf-source-item" key={source.id}><FilePdf size={20} /><div><strong>{source.file.name}</strong><small>{tr('{0} 页', [source.count])}</small></div><Button type="button" variant="ghost" size="icon" aria-label={tr('选择此文件的页面')} disabled={action.busy} onClick={() => change((old) => old.map((page) => ({ ...page, selected: page.sourceId === source.id })))}><SquaresFour size={16} /></Button></div>)}{!sources.length && <p className="app-muted">{tr('添加 PDF 或图片后开始整理。')}</p>}</aside>}
      <div className="pdf-pages-area" onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={(event) => { if (!event.dataTransfer.files.length || action.busy) return; event.preventDefault(); addFiles(event.dataTransfer.files); }}>
        {showHistory ? <div className="pdf-history"><div className="pdf-section-heading"><h3>{tr('导出记录')}</h3><Button type="button" variant="ghost" onClick={() => setShowHistory(false)}>{tr('返回页面')}</Button></div>{data.outputs.map((record) => <ResultRow key={record.id} record={record} busy={action.busy} onOpen={() => addFiles([new File([record.blob], record.name, { type: 'application/pdf' })])} onRemove={() => setPending(record)} />)}{!data.outputs.length && <p className="app-empty">{tr('暂无导出文件')}</p>}</div>
          : pages.length ? <div ref={grid} className="pdf-page-grid" aria-label={tr('文档页面')} onDragOver={(event) => { if (event.dataTransfer.types.includes('application/x-covelet-pdf-page')) event.preventDefault(); }} onDrop={(event) => { if (event.target === event.currentTarget && event.dataTransfer.types.includes('application/x-covelet-pdf-page')) { event.preventDefault(); event.stopPropagation(); reorder(null); } }} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); change((old) => old.map((page) => ({ ...page, selected: true }))); } }}>
            {pages.map((page, index) => <article className={`pdf-page-card ${page.selected ? 'is-selected' : ''}`} key={page.id} data-page-id={page.id} draggable={!action.busy} onDragStart={(event) => { dragging.current = page.selected ? selected.map((item) => item.id) : [page.id]; event.dataTransfer.setData('application/x-covelet-pdf-page', page.id); event.dataTransfer.effectAllowed = 'move'; }} onDragOver={(event) => { if (event.dataTransfer.types.includes('application/x-covelet-pdf-page')) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }} onDrop={(event) => { if (!event.dataTransfer.types.includes('application/x-covelet-pdf-page')) return; event.preventDefault(); event.stopPropagation(); reorder(page.id); }} onDragEnd={() => { dragging.current = []; }}>
              <Button type="button" variant="unstyled" size="unstyled" className="pdf-page-select" aria-label={tr('选择第 {0} 页', [index + 1])} aria-pressed={page.selected} disabled={action.busy} onClick={() => change((old) => old.map((item) => item.id === page.id ? { ...item, selected: !item.selected } : item))} onDoubleClick={() => setPreviewId(page.id)} onKeyDown={(event) => { if (event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); shiftPage(page.id, event.key === 'ArrowLeft' ? -1 : 1); } }}><PageThumbnail source={sourceById.get(page.sourceId)} pageIndex={page.pageIndex} rotation={page.rotation} scrollRoot={grid} /><span className="pdf-page-check">{page.selected ? '✓' : ''}</span></Button>
              <div className="pdf-page-caption"><span>{index + 1}</span><small>{sourceById.get(page.sourceId).file.name}</small><Button type="button" variant="ghost" size="sm" onClick={() => setPreviewId(page.id)}>{tr('预览')}</Button></div>
            </article>)}
          </div> : <div className="pdf-drop-zone"><FilePdf size={46} /><h3>{tr('把 PDF 或图片拖到这里')}</h3><Button type="button" variant="secondary" onClick={() => input.current.click()}>{tr('选择文件')}</Button></div>}
      </div>
      {preview && <aside className="pdf-page-preview"><div><strong>{tr('页面预览')}</strong><Button type="button" variant="ghost" size="icon" aria-label={tr('关闭预览')} onClick={() => setPreviewId(null)}><X size={18} /></Button></div><PageThumbnail key={`${preview.id}-${preview.rotation}`} source={sourceById.get(preview.sourceId)} pageIndex={preview.pageIndex} rotation={preview.rotation} width={310} /></aside>}
      </div>
      <footer className="pdf-export-bar"><span>{tr('已选 {0}/{1} 页', [selected.length, pages.length])}</span><Select label={tr('操作')} value={mode} onChange={setMode} disabled={action.busy} options={[{ value: 'merge', label: tr('合并为一个 PDF') }, { value: 'split', label: tr('拆分为单页') }]} /><span className="pdf-toolbar-spacer" />{action.busy ? <><span role="status">{progress || tr('正在处理…')}</span><Button type="button" variant="ghost" onClick={() => controller.current?.abort()}>{tr('取消')}</Button></> : <Button type="button" disabled={!selected.length} onClick={process}><DownloadSimple size={17} />{tr('导出 {0} 页', [selected.length])}</Button>}</footer>
      {pending && <Confirm destructive action={tr('移除')} busy={action.busy} onCancel={() => setPending(null)} onConfirm={() => action.run(async () => { await update((latest) => ({ ...latest, outputs: latest.outputs.filter((record) => record.id !== pending.id) })); setPending(null); })}>{tr('移除“{0}”？尚未下载的文件将从此处删除。', [pending.name])}</Confirm>}
    </>}
  </section>;
}

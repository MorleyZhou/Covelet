import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Plus, Minus, FolderOpen, FloppyDisk, Trash, DownloadSimple, UploadSimple, ArrowsOutSimple, ArrowUUpLeft, ArrowUUpRight, SlidersHorizontal, LinkSimple } from '@phosphor-icons/react';
import { tr } from '../../i18n/index.js';
import { useAppData, useAppAction, AppError, Button, Input, Textarea, Field, downloadBlob, readTextFile } from './shared.jsx';
import Confirm from '../PromptDialog.jsx';
import { validateBoard, parseToolJson, TEXT_LIMIT, layoutMindMap, mindMapChildren, mindMapDescendants, reparentMindMap, removeMindMapNodes, MAP_NODE_WIDTH, MAP_NODE_HEIGHT } from '../../lib/processing-apps.js';

const DEFAULTS = { boards: [] }, id = () => crypto.randomUUID(), clone = (value) => structuredClone(value);
const newBoard = (mode = 'mindmap') => {
  const root = id();
  return { id: id(), title: mode === 'mindmap' ? tr('未命名导图') : tr('未命名画板'), mode, ...(mode === 'mindmap' ? { rootId: root } : {}),
    nodes: mode === 'mindmap' ? [{ id: root, parentId: null, order: 0, collapsed: false, x: 0, y: 0, text: tr('中心主题'), color: '#e9edf5', group: '' }] : [], edges: [] };
};
const wrapText = (text) => text.split('\n').flatMap((line) => { const letters = Array.from(line); return letters.length ? Array.from({ length: Math.ceil(letters.length / 16) }, (_, at) => letters.slice(at * 16, at * 16 + 16).join('')) : ['']; }).slice(0, 3);
const ignoreKey = (event) => event.target.closest('input,textarea,[contenteditable="true"]') || event.nativeEvent.isComposing || event.keyCode === 229;
function ToolButton({ label, Icon, active, ...props }) { return <Button type="button" variant={active ? 'secondary' : 'ghost'} size="icon" aria-label={label} title={label} {...props}><Icon size={18} /></Button>; }

export default function CanvasStudio({ onDirtyChange, onBusyChange, initialContext }) {
  const { data, loading, loaded, error, update, revision } = useAppData('canvas', DEFAULTS), action = useAppAction();
  const [board, setBoard] = useState(newBoard), [baseRevision, setBaseRevision] = useState(0), [dirty, setDirty] = useState(false), [selected, setSelected] = useState([]);
  const [library, setLibrary] = useState(false), [inspector, setInspector] = useState(false), [connecting, setConnecting] = useState(false), [connectFrom, setConnectFrom] = useState(null);
  const [editing, setEditing] = useState(null), [pending, setPending] = useState(null), [past, setPast] = useState([]), [future, setFuture] = useState([]);
  const [camera, setCamera] = useState({ x: 50, y: 50, scale: 1 }), [bounds, setBounds] = useState({ width: 1, height: 1 }), [space, setSpace] = useState(false), [gestureView, setGestureView] = useState(null);
  const stage = useRef(null), svg = useRef(null), editor = useRef(null), gesture = useRef(null), imported = useRef(null), initialized = useRef(false), fitDocument = useRef(null), marker = useId().replaceAll(':', '');
  const mindmap = board.mode === 'mindmap', layout = useMemo(() => layoutMindMap(board), [board]);
  const nodeById = useMemo(() => new Map(layout.nodes.map((node) => [node.id, node])), [layout]), selectedNode = board.nodes.find((node) => node.id === selected[0]);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(loading || action.busy); return () => onBusyChange?.(false); }, [loading, action.busy, onBusyChange]);
  useEffect(() => {
    if (!loaded || dirty) return;
    const current = data.boards.find((item) => item.id === board.id), requested = !initialized.current && data.boards.find((item) => item.id === initialContext?.boardId);
    if (current || requested || !initialized.current && data.boards[0]) setBoard(clone(current || requested || data.boards[0]));
    initialized.current = true; setBaseRevision(revision);
  }, [loaded, data, revision, dirty]);
  useEffect(() => {
    if (!loaded || !stage.current) return;
    const measure = () => { const rect = stage.current.getBoundingClientRect(); setBounds((old) => old.width === rect.width && old.height === rect.height ? old : { width: rect.width, height: rect.height }); };
    const observer = new ResizeObserver(measure); observer.observe(stage.current); measure(); return () => observer.disconnect();
  }, [loaded]);
  const fit = () => {
    if (!layout.nodes.length) { setCamera({ x: 50, y: 50, scale: 1 }); return; }
    const minX = Math.min(...layout.nodes.map((node) => node.x)), minY = Math.min(...layout.nodes.map((node) => node.y)), maxX = Math.max(...layout.nodes.map((node) => node.x + MAP_NODE_WIDTH)), maxY = Math.max(...layout.nodes.map((node) => node.y + MAP_NODE_HEIGHT));
    const scale = Math.max(.12, Math.min(1.2, (bounds.width - 100) / Math.max(200, maxX - minX), (bounds.height - 100) / Math.max(120, maxY - minY)));
    setCamera({ x: (bounds.width - (maxX - minX) * scale) / 2 - minX * scale, y: (bounds.height - (maxY - minY) * scale) / 2 - minY * scale, scale });
  };
  useEffect(() => { if (bounds.width > 100 && bounds.height > 100 && fitDocument.current !== board.id) { fitDocument.current = board.id; fit(); } }, [board.id, bounds.width, bounds.height]);
  const zoom = (factor, anchor = { x: bounds.width / 2, y: bounds.height / 2 }) => setCamera((previous) => { const scale = Math.max(.12, Math.min(3, previous.scale * factor)); return { scale, x: anchor.x - (anchor.x - previous.x) * scale / previous.scale, y: anchor.y - (anchor.y - previous.y) * scale / previous.scale }; });
  useEffect(() => {
    const element = stage.current; if (!element) return;
    const wheel = (event) => { event.preventDefault(); const rect = element.getBoundingClientRect(); if (event.ctrlKey || event.metaKey) zoom(Math.exp(-event.deltaY * .002), { x: event.clientX - rect.left, y: event.clientY - rect.top }); else setCamera((old) => ({ ...old, x: old.x - (event.shiftKey ? event.deltaY : event.deltaX), y: old.y - (event.shiftKey ? event.deltaX : event.deltaY) })); };
    element.addEventListener('wheel', wheel, { passive: false }); return () => element.removeEventListener('wheel', wheel);
  }, [loaded, bounds.width, bounds.height]);
  useEffect(() => { if (editing && editor.current) { editor.current.focus(); editor.current.select(); } }, [editing?.id]);
  const history = () => { setPast((old) => [...old.slice(-39), clone(board)]); setFuture([]); };
  const change = (transform, checkpoint = true) => { if (action.busy) return; if (checkpoint) history(); setBoard((old) => transform(old)); setDirty(true); };
  const undo = () => { if (!past.length) return; setFuture((old) => [...old, clone(board)]); setBoard(past.at(-1)); setPast((old) => old.slice(0, -1)); setEditing(null); setDirty(true); };
  const redo = () => { if (!future.length) return; setPast((old) => [...old, clone(board)]); setBoard(future.at(-1)); setFuture((old) => old.slice(0, -1)); setEditing(null); setDirty(true); };
  const choose = (next, nextDirty = false) => { setBoard(clone(next || newBoard())); setBaseRevision(revision); setDirty(nextDirty); setSelected([]); setEditing(null); setPast([]); setFuture([]); setPending(null); setConnectFrom(null); setLibrary(false); fitDocument.current = null; };
  const requestChoose = (next, nextDirty = false) => dirty ? setPending({ kind: 'switch', next, dirty: nextDirty }) : choose(next, nextDirty);
  const save = () => action.run(async () => { setEditing(null); const saved = { id: board.id, title: board.title.trim().slice(0, 120) || tr('未命名画板'), ...validateBoard(board), updatedAt: Date.now() }; await update((latest) => { const boards = latest.boards.some((item) => item.id === saved.id) ? latest.boards.map((item) => item.id === saved.id ? saved : item) : [...latest.boards, saved]; if (boards.length > 30) throw Error(tr('最多保存 30 个画板。')); return { ...latest, boards }; }, { expectedRevision: baseRevision }); setBoard(saved); setDirty(false); });
  const world = (event) => { const rect = stage.current.getBoundingClientRect(); return { x: (event.clientX - rect.left - camera.x) / camera.scale, y: (event.clientY - rect.top - camera.y) / camera.scale }; };
  const edit = (node) => { if (!node) return; history(); setSelected([node.id]); setEditing({ id: node.id, original: node.text }); if (camera.scale < .7) { const visible = nodeById.get(node.id); setCamera({ x: bounds.width / 2 - visible.x - MAP_NODE_WIDTH / 2, y: bounds.height / 2 - visible.y - MAP_NODE_HEIGHT / 2, scale: 1 }); } };
  const add = (sibling = false, parent = selectedNode) => {
    if (board.nodes.length >= 300) return action.setError(tr('一个画板最多包含 300 个节点。'));
    const nextId = id(); let next;
    if (mindmap) {
      const anchor = parent || board.nodes.find((node) => node.id === board.rootId), parentId = sibling && anchor.parentId !== null ? anchor.parentId : anchor.id, siblings = mindMapChildren(board, parentId), at = sibling && anchor.parentId !== null ? siblings.findIndex((node) => node.id === anchor.id) + 1 : siblings.length;
      next = { id: nextId, parentId, order: at, collapsed: false, text: tr('新主题'), color: anchor.color, group: '', x: 0, y: 0 };
      change((old) => ({ ...old, nodes: [...old.nodes.map((node) => node.id === parentId ? { ...node, collapsed: false } : node.parentId === parentId && node.order >= at ? { ...node, order: node.order + 1 } : node), next] }));
    } else { next = { id: nextId, x: (bounds.width / 2 - camera.x) / camera.scale - MAP_NODE_WIDTH / 2, y: (bounds.height / 2 - camera.y) / camera.scale - MAP_NODE_HEIGHT / 2, text: tr('新节点'), color: '#e9edf5', group: '' }; change((old) => ({ ...old, nodes: [...old.nodes, next] })); }
    setSelected([nextId]); setEditing({ id: nextId, original: next.text });
  };
  const toggle = (node) => change((old) => ({ ...old, nodes: old.nodes.map((item) => item.id === node.id ? { ...item, collapsed: !item.collapsed } : item) }));
  const remove = () => { if (mindmap && selected.includes(board.rootId)) return action.setError(tr('中心主题需要保留。')); setPending({ kind: 'nodes' }); };
  const removeSelected = () => { change((old) => mindmap ? removeMindMapNodes(old, selected) : { ...old, nodes: old.nodes.filter((node) => !selected.includes(node.id)), edges: old.edges.filter((edge) => !selected.includes(edge.from) && !selected.includes(edge.to)) }); setSelected([]); setPending(null); };
  const navigate = (event, node) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); if (event.shiftKey && mindmap && node.parentId) setSelected([node.parentId]); else add(false, node); }
    else if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); add(true, node); }
    else if (event.key === 'F2') { event.preventDefault(); edit(node); }
    else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); remove(); }
    else if (event.key.startsWith('Arrow')) {
      event.preventDefault(); event.stopPropagation();
      if (mindmap) { const siblings = mindMapChildren(board, node.parentId), at = siblings.findIndex((item) => item.id === node.id); const next = event.key === 'ArrowLeft' ? node.parentId : event.key === 'ArrowRight' ? mindMapChildren(board, node.id)[0]?.id : siblings[at + (event.key === 'ArrowUp' ? -1 : 1)]?.id; if (next) setSelected([next]); }
      else { const dx = event.key === 'ArrowLeft' ? -10 : event.key === 'ArrowRight' ? 10 : 0, dy = event.key === 'ArrowUp' ? -10 : event.key === 'ArrowDown' ? 10 : 0; change((old) => ({ ...old, nodes: old.nodes.map((item) => selected.includes(item.id) ? { ...item, x: item.x + dx, y: item.y + dy } : item) })); }
    }
  };
  useEffect(() => {
    const node = nodeById.get(editing?.id || selected[0]);
    if (node && bounds.width > 100 && bounds.height > 100) setCamera((old) => {
      const left = node.x * old.scale + old.x, top = node.y * old.scale + old.y, right = left + MAP_NODE_WIDTH * old.scale, bottom = top + MAP_NODE_HEIGHT * old.scale;
      const dx = left < 24 ? 24 - left : right > bounds.width - 24 ? bounds.width - 24 - right : 0, dy = top < 24 ? 24 - top : bottom > bounds.height - 88 ? bounds.height - 88 - bottom : 0;
      return dx || dy ? { ...old, x: old.x + dx, y: old.y + dy } : old;
    });
    if (!editing && selected[0]) svg.current?.querySelector(`[data-map-node="${CSS.escape(selected[0])}"]`)?.focus({ preventScroll: true });
  }, [selected[0], editing?.id, bounds.width, bounds.height]);
  const beginNode = (event, node) => {
    if (event.button !== 0 && event.button !== 1 || editing?.id === node.id) return;
    event.preventDefault(); event.stopPropagation();
    if (!mindmap && connecting) { if (!connectFrom) { setConnectFrom(node.id); setSelected([node.id]); } else if (connectFrom !== node.id) { if (board.edges.length >= 600) return action.setError(tr('画板内容无效或过大。')); if (!board.edges.some((edge) => edge.from === connectFrom && edge.to === node.id)) change((old) => ({ ...old, edges: [...old.edges, { from: connectFrom, to: node.id }] })); setConnectFrom(null); } return; }
    const group = !mindmap && node.group ? board.nodes.filter((item) => item.group === node.group).map((item) => item.id) : [node.id];
    const ids = event.shiftKey ? selected.includes(node.id) ? selected.filter((value) => !group.includes(value)) : [...new Set([...selected, ...group])] : selected.includes(node.id) ? selected : group; setSelected(ids);
    const moving = mindmap ? [...mindMapDescendants(board, node.id)] : ids;
    gesture.current = { pointer: event.pointerId, kind: space || event.button === 1 || mindmap && node.id === board.rootId ? 'pan' : 'node', from: world(event), client: { x: event.clientX, y: event.clientY }, camera, ids: moving, nodeId: node.id, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const endGesture = (event, cancelled = false) => {
    const current = gesture.current; if (!current || current.pointer !== event.pointerId) return;
    if (!cancelled && current.moved && current.kind === 'node') {
      if (mindmap && gestureView?.target) {
        const target = board.nodes.find((node) => node.id === gestureView.target.id), type = gestureView.target.kind;
        try { const parent = type === 'child' || target.parentId === null ? target.id : target.parentId, siblings = mindMapChildren(board, parent).filter((node) => node.id !== current.nodeId), position = type === 'child' ? siblings.length : siblings.findIndex((node) => node.id === target.id) + (type === 'after' ? 1 : 0); change((old) => reparentMindMap(old, current.nodeId, parent, position)); } catch (reason) { action.setError(reason.message); }
      } else if (!mindmap) change((old) => ({ ...old, nodes: old.nodes.map((node) => current.ids.includes(node.id) ? { ...node, x: Math.max(-90000, Math.min(90000, node.x + (gestureView?.dx || 0))), y: Math.max(-90000, Math.min(90000, node.y + (gestureView?.dy || 0))) } : node) }));
    } else if (!cancelled && current.kind === 'selection' && gestureView?.box) { const box = gestureView.box; setSelected(layout.nodes.filter((node) => node.x < box.x + box.width && node.x + MAP_NODE_WIDTH > box.x && node.y < box.y + box.height && node.y + MAP_NODE_HEIGHT > box.y).map((node) => node.id)); }
    gesture.current = null; setGestureView(null); if (svg.current.hasPointerCapture(event.pointerId)) svg.current.releasePointerCapture(event.pointerId);
  };
  const svgExport = () => {
    const rendered = svg.current.cloneNode(true), group = rendered.querySelector('.map-world'); group.removeAttribute('transform'); rendered.querySelectorAll('[data-map-overlay]').forEach((element) => element.remove()); rendered.querySelectorAll('[tabindex]').forEach((element) => element.removeAttribute('tabindex'));
    const x = Math.min(0, ...layout.nodes.map((node) => node.x)) - 40, y = Math.min(0, ...layout.nodes.map((node) => node.y)) - 40, width = Math.max(400, ...layout.nodes.map((node) => node.x + MAP_NODE_WIDTH)) - x + 40, height = Math.max(200, ...layout.nodes.map((node) => node.y + MAP_NODE_HEIGHT)) - y + 40;
    rendered.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); rendered.setAttribute('viewBox', `${x} ${y} ${width} ${height}`); rendered.setAttribute('width', width); rendered.setAttribute('height', height); return new Blob([new XMLSerializer().serializeToString(rendered)], { type: 'image/svg+xml' });
  };
  const displayedNodes = layout.nodes.map((node) => gestureView?.ids?.includes(node.id) ? { ...node, x: node.x + gestureView.dx, y: node.y + gestureView.dy } : node), displayedById = new Map(displayedNodes.map((node) => [node.id, node]));
  const editingNode = displayedById.get(editing?.id);
  return <section className="processing-workspace canvas-studio" aria-label={tr('思维画板')}><AppError message={error || action.error} onClose={() => action.setError('')} />
    {!loaded ? <p role="status">{loading ? tr('正在载入…') : tr('内容未能载入，请重新打开此扩展。')}</p> : <>
    <header className="map-toolbar" inert={action.busy}><ToolButton label={tr('画板库')} Icon={FolderOpen} active={library} onClick={() => setLibrary(!library)} /><Input className="map-title" aria-label={tr('画板名称')} maxLength={120} value={board.title} onChange={(event) => change((old) => ({ ...old, title: event.target.value }), false)} />
      <span className="map-mode-label">{mindmap ? tr('思维导图') : tr('自由画板')}</span><span className="map-toolbar-spacer" />
      <ToolButton label={tr('撤销')} Icon={ArrowUUpLeft} disabled={!past.length} onClick={undo} /><ToolButton label={tr('重做')} Icon={ArrowUUpRight} disabled={!future.length} onClick={redo} />
      <ToolButton label={tr('保存')} Icon={FloppyDisk} disabled={!dirty || action.busy} onClick={save} /><ToolButton label={tr('导出 SVG')} Icon={DownloadSimple} onClick={() => downloadBlob(svgExport(), `${board.title}.svg`)} /><ToolButton label={tr('导入画板')} Icon={UploadSimple} onClick={() => imported.current.click()} />
      <ToolButton label={tr('节点属性')} Icon={SlidersHorizontal} active={inspector} onClick={() => setInspector(!inspector)} />
      <Input ref={imported} hidden type="file" accept="application/json,.json" aria-label={tr('导入画板')} onChange={(event) => { const file = event.target.files?.[0]; if (file) action.run(async () => { const value = parseToolJson(await readTextFile(file, TEXT_LIMIT)); requestChoose({ id: id(), title: String(value.title || file.name).slice(0, 120), ...validateBoard(value) }, true); }); event.target.value = ''; }} />
    </header>
    <div className="map-main" inert={action.busy}>{library && <aside className="map-library"><div className="map-library-actions"><Button type="button" variant="secondary" onClick={() => requestChoose(newBoard('mindmap'))}>{tr('新建导图')}</Button><Button type="button" variant="ghost" onClick={() => requestChoose(newBoard('free'))}>{tr('新建自由画板')}</Button></div>{data.boards.map((item) => <Button type="button" variant={item.id === board.id ? 'secondary' : 'ghost'} key={item.id} onClick={() => requestChoose(item)}>{item.title}<small>{item.mode === 'mindmap' ? tr('思维导图') : tr('自由画板')}</small></Button>)}<Button type="button" variant="ghost" onClick={() => downloadBlob(new Blob([JSON.stringify({ title: board.title, ...validateBoard(board) }, null, 2)], { type: 'application/json' }), `${board.title}.json`)}>{tr('导出文件')}</Button><Button type="button" variant="ghost" disabled={!data.boards.some((item) => item.id === board.id)} onClick={() => setPending({ kind: 'board' })}>{tr('删除画板')}</Button></aside>}
    <div ref={stage} className={`map-viewport ${space || gesture.current?.kind === 'pan' ? 'is-panning' : ''}`} tabIndex={0} style={{ backgroundPosition: `${camera.x}px ${camera.y}px`, backgroundSize: `${24 * camera.scale}px ${24 * camera.scale}px` }}
      onKeyDownCapture={(event) => { if (ignoreKey(event)) return; if (event.code === 'Space') { event.preventDefault(); event.stopPropagation(); setSpace(true); } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); } else if (event.key === 'Escape' && (selected.length || connectFrom || editing)) { event.stopPropagation(); setSelected([]); setConnectFrom(null); setEditing(null); stage.current.focus(); } }}
      onKeyUp={(event) => { if (event.code === 'Space' && !ignoreKey(event)) { event.preventDefault(); setSpace(false); } }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setSpace(false); }}>
      <svg ref={svg} className="map-canvas" role="group" aria-label={tr('导图画布')}
        onPointerDown={(event) => { if (event.target !== event.currentTarget && !space && event.button !== 1 || event.button !== 0 && event.button !== 1) return; setEditing(null); if (!event.shiftKey && !space && event.button !== 1) setSelected([]); gesture.current = { pointer: event.pointerId, kind: space || event.button === 1 || event.pointerType === 'touch' ? 'pan' : 'selection', from: world(event), client: { x: event.clientX, y: event.clientY }, camera, moved: false }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={(event) => {
          const current = gesture.current; if (!current || current.pointer !== event.pointerId) return; const point = world(event), dx = point.x - current.from.x, dy = point.y - current.from.y;
          if (!current.moved && Math.abs(event.clientX - current.client.x) + Math.abs(event.clientY - current.client.y) < 4) return; current.moved = true;
          if (current.kind === 'pan') setCamera({ ...current.camera, x: current.camera.x + event.clientX - current.client.x, y: current.camera.y + event.clientY - current.client.y });
          else if (current.kind === 'selection') setGestureView({ box: { x: Math.min(point.x, current.from.x), y: Math.min(point.y, current.from.y), width: Math.abs(dx), height: Math.abs(dy) } });
          else { const hit = mindmap && layout.nodes.find((node) => !current.ids.includes(node.id) && point.x >= node.x - 8 && point.x <= node.x + MAP_NODE_WIDTH + 8 && point.y >= node.y - 10 && point.y <= node.y + MAP_NODE_HEIGHT + 10); setGestureView({ ids: current.ids, dx, dy, target: hit ? { id: hit.id, kind: hit.parentId === null ? 'child' : point.y < hit.y + 18 ? 'before' : point.y > hit.y + MAP_NODE_HEIGHT - 18 ? 'after' : 'child' } : null }); }
        }} onPointerUp={(event) => endGesture(event)} onPointerCancel={(event) => endGesture(event, true)}>
        <defs><marker id={marker} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0L8 4L0 8z" fill="#8590a4" /></marker></defs>
        <g className="map-world" transform={`translate(${camera.x},${camera.y}) scale(${camera.scale})`}>
          {layout.edges.map((edge, index) => { const from = displayedById.get(edge.from), to = displayedById.get(edge.to); if (!from || !to) return null; const x = from.x + MAP_NODE_WIDTH, y = from.y + MAP_NODE_HEIGHT / 2, targetY = to.y + MAP_NODE_HEIGHT / 2; return <path key={`${edge.from}-${edge.to}-${index}`} d={mindmap ? `M${x},${y} C${x + 40},${y} ${to.x - 40},${targetY} ${to.x},${targetY}` : `M${from.x + MAP_NODE_WIDTH / 2},${y} L${to.x + MAP_NODE_WIDTH / 2},${targetY}`} fill="none" stroke="#8c98ae" strokeWidth="2" markerEnd={mindmap ? undefined : `url(#${marker})`} />; })}
          {displayedNodes.map((node) => <g key={node.id} data-map-node={node.id} className={`map-node ${selected.includes(node.id) ? 'is-selected' : ''} ${gestureView?.target?.id === node.id ? `is-drop-${gestureView.target.kind}` : ''}`} transform={`translate(${node.x},${node.y})`} tabIndex={selected[0] === node.id || !selected.length && node.id === (board.rootId || board.nodes[0]?.id) ? 0 : -1} role="button" aria-label={node.text || tr('空白节点')} aria-pressed={selected.includes(node.id)} onPointerDown={(event) => beginNode(event, node)} onDoubleClick={(event) => { event.stopPropagation(); edit(board.nodes.find((item) => item.id === node.id)); }} onKeyDown={(event) => navigate(event, node)}>
            <title>{node.text}</title><rect width={MAP_NODE_WIDTH} height={MAP_NODE_HEIGHT} rx="12" fill={node.color} stroke={selected.includes(node.id) ? '#5b73bb' : '#8491a544'} strokeWidth={selected.includes(node.id) ? 2.5 : 1} />
            {editing?.id !== node.id && <text x="15" y="25" fill="#1e293b" fontFamily="system-ui,sans-serif" fontSize="14">{wrapText(node.text).map((line, at) => <tspan key={at} x="15" dy={at ? 17 : 0}>{line}</tspan>)}</text>}
          </g>)}
          {mindmap && displayedNodes.filter((node) => mindMapChildren(board, node.id).length).map((node) => <g data-map-overlay key={`fold-${node.id}`} className="map-fold" transform={`translate(${node.x + MAP_NODE_WIDTH},${node.y + MAP_NODE_HEIGHT / 2})`} role="button" tabIndex={selected[0] === node.id ? 0 : -1} aria-label={node.collapsed ? tr('展开主题') : tr('折叠主题')} onPointerDown={(event) => { event.stopPropagation(); event.preventDefault(); toggle(node); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); toggle(node); } }}><rect x="-16" y="-16" width="32" height="32" fill="transparent" stroke="none" /><circle r="10" fill="#fff" stroke="#9aa6bb" /><text textAnchor="middle" y="4" fill="#53627c" fontSize="13">{node.collapsed ? '+' : '−'}</text></g>)}
          {gestureView?.box && <rect data-map-overlay x={gestureView.box.x} y={gestureView.box.y} width={gestureView.box.width} height={gestureView.box.height} fill="#6c8fe329" stroke="#6c8fe3" strokeWidth="1" />}
        </g>
      </svg>
      {editing && editingNode && <Textarea ref={editor} className="map-inline-editor" aria-label={tr('主题文字')} style={{ left: editingNode.x * camera.scale + camera.x + 8, top: editingNode.y * camera.scale + camera.y + 7, width: (MAP_NODE_WIDTH - 16) * camera.scale, height: (MAP_NODE_HEIGHT - 14) * camera.scale, fontSize: Math.max(12, 14 * camera.scale) }} value={board.nodes.find((node) => node.id === editing.id)?.text || ''} maxLength={2000} onChange={(event) => change((old) => ({ ...old, nodes: old.nodes.map((node) => node.id === editing.id ? { ...node, text: event.target.value } : node) }), false)} onBlur={() => setEditing(null)} onKeyDown={(event) => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); change((old) => ({ ...old, nodes: old.nodes.map((node) => node.id === editing.id ? { ...node, text: editing.original } : node) }), false); setEditing(null); } else if (event.key === 'Enter' && !event.shiftKey || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); const node = board.nodes.find((item) => item.id === editing.id); setEditing(null); add(event.key === 'Enter', node); } }} />}
      <div className="map-floating-tools"><Button type="button" variant="secondary" onClick={() => add(false)}><Plus size={16} />{mindmap ? tr('子主题') : tr('添加节点')}</Button>{mindmap && selectedNode && <Button type="button" variant="ghost" onClick={() => add(true)}>{tr('同级主题')}</Button>}{!mindmap && <ToolButton label={tr('连接节点')} Icon={LinkSimple} active={connecting} onClick={() => { setConnecting(!connecting); setConnectFrom(null); }} />}{selectedNode && <ToolButton label={tr('删除所选节点')} Icon={Trash} disabled={mindmap && selected.includes(board.rootId)} onClick={remove} />}</div>
      <div className="map-zoom-tools"><ToolButton label={tr('缩小')} Icon={Minus} onClick={() => zoom(1 / 1.2)} /><span>{Math.round(camera.scale * 100)}%</span><ToolButton label={tr('放大')} Icon={Plus} onClick={() => zoom(1.2)} /><ToolButton label={tr('适应画布')} Icon={ArrowsOutSimple} onClick={fit} /></div>
      {inspector && <aside className="map-inspector"><strong>{tr('节点属性')}</strong>{selectedNode ? <><Field label={tr('节点颜色')}><Input type="color" value={selectedNode.color} onChange={(event) => change((old) => ({ ...old, nodes: old.nodes.map((node) => selected.includes(node.id) ? { ...node, color: event.target.value } : node) }))} /></Field><Button type="button" variant="secondary" onClick={() => edit(selectedNode)}>{tr('编辑主题')}</Button>{mindmap && <Button type="button" variant="ghost" onClick={() => toggle(selectedNode)}>{selectedNode.collapsed ? tr('展开主题') : tr('折叠主题')}</Button>}{!mindmap && <><Button type="button" variant="ghost" disabled={selected.length < 2} onClick={() => { const group = id(); change((old) => ({ ...old, nodes: old.nodes.map((node) => selected.includes(node.id) ? { ...node, group } : node) })); }}>{tr('分组')}</Button><Button type="button" variant="ghost" onClick={() => change((old) => ({ ...old, nodes: old.nodes.map((node) => selected.includes(node.id) ? { ...node, group: '' } : node) }))}>{tr('解除分组')}</Button>{board.edges.filter((edge) => selected.includes(edge.from) || selected.includes(edge.to)).map((edge) => <Button key={`${edge.from}-${edge.to}`} type="button" variant="ghost" onClick={() => change((old) => ({ ...old, edges: old.edges.filter((item) => item.from !== edge.from || item.to !== edge.to) }))}>{tr('移除连线')}</Button>)}</>}</> : <p className="app-muted">{tr('选择主题后可调整样式。')}</p>}</aside>}
      {!board.nodes.length && <div className="map-empty"><Button type="button" variant="secondary" onClick={() => add(false)}><Plus size={18} />{tr('添加节点')}</Button></div>}
    </div></div>
    {pending && <Confirm busy={action.busy} destructive={pending.kind !== 'switch'} action={pending.kind === 'switch' ? tr('放弃修改') : tr('删除')} onCancel={() => setPending(null)} onConfirm={() => pending.kind === 'switch' ? choose(pending.next, pending.dirty) : pending.kind === 'nodes' ? removeSelected() : action.run(async () => { await update((latest) => ({ ...latest, boards: latest.boards.filter((item) => item.id !== board.id) }), { expectedRevision: baseRevision }); choose(data.boards.find((item) => item.id !== board.id)); })}>{pending.kind === 'switch' ? tr('当前画板尚未保存，放弃修改？') : pending.kind === 'nodes' ? mindmap ? tr('删除所选主题及其全部子主题？') : tr('删除所选节点和相连的连线？') : tr('删除“{0}”？', [board.title])}</Confirm>}
    </>}
  </section>;
}

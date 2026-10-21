import { tr, builtinName, formatNumber } from "../i18n/index.js";
import { Plus, Trash, Check, SquaresFour } from '@phosphor-icons/react';
import { DESKTOP_ROWS, layoutDesktop } from '../lib/desktop-layout.js';
import './desktop-edit.css';

export function DesktopEditBar({ editor, onManage, drag, onDelete }) {
  return <div className="desktop-edit-bar" data-layout-control>
    {editor.error && <p className="desktop-edit-error" role="alert">{tr(editor.error)}</p>}
    <div className="desktop-edit-actions" role="toolbar" aria-label={tr("编辑布局")}>
      <button type="button" disabled={editor.saving} onClick={onManage}><SquaresFour size={17} />{tr("屏幕管理")}</button>
      <span className="desktop-edit-divider" />
      <button type="button" disabled={editor.saving} onClick={editor.cancel}>{tr("取消")}</button>
      <button type="button" className="desktop-edit-done" disabled={editor.saving || editor.conflict} onClick={editor.save}>{tr("完成")}</button>
      <button type="button" data-layout-trash className={`desktop-edit-trash ${drag?.target?.kind === 'delete' ? 'is-drop-target' : ''}`}
        disabled={editor.saving || editor.conflict || !editor.selectedIds.length} aria-label={tr("删除所选项目")} title={tr("删除所选项目")}
        onClick={() => onDelete(editor.selectedIds)}><Trash size={21} /></button>
    </div>
    <p className="desktop-edit-shortcuts"><span>{tr("点击多选")}</span><span aria-hidden="true">/</span><span><kbd>Esc</kbd>{tr(" 退出编辑")}</span><span aria-hidden="true">/</span><span><kbd>Enter</kbd>{tr(" 保存")}</span></p>
  </div>;
}

export function DesktopScreenManager({ Dialog, state, columns, activeKey, editor, onSelect, onClose, renderIcon }) {
  const screens = layoutDesktop(state.entries, columns, null, state.settings.pages);
  return <Dialog title={tr("屏幕管理")} onClose={onClose} wide className="desktop-screen-manager">
    <div className="desktop-screen-list">
      {screens.map((screen, index) => <div className={`desktop-screen-card ${screen.key === activeKey ? 'is-current' : ''}`} key={screen.key}>
        <button type="button" className="desktop-screen-preview" aria-label={tr("前往第 {0} 屏", [index + 1])} aria-current={screen.key === activeKey ? 'page' : undefined}
          onClick={() => { onSelect(screen.key); onClose(); }}>
          <span className="desktop-screen-mini-grid" style={{ '--preview-columns': columns, '--preview-rows': DESKTOP_ROWS }} aria-hidden="true">
            {screen.items.map((entry) => {
              const placement = screen.placements.get(entry.id);
              return <span key={entry.id} className={`desktop-screen-mini-item ${entry.type === 'widget' ? 'is-widget' : ''}`}
                style={{ gridRow: `${placement.row} / span ${placement.rows}`, gridColumn: `${placement.column} / span ${placement.columns}` }}>
                {entry.type === 'widget' ? <span>{builtinName(entry.extensionId, entry.name)}</span> : renderIcon(entry)}
              </span>;
            })}
          </span>
        </button>
        <div className="desktop-screen-card-footer"><span>{tr("第 {0} 屏", [formatNumber(index + 1)])}{screen.key === activeKey && <Check size={14} aria-hidden="true" />}</span>
          <button type="button" className="desktop-screen-delete" aria-label={tr("删除第 {0} 屏", [index + 1])} title={screens.length === 1 ? tr("至少保留一屏") : tr("删除屏幕")}
            disabled={screens.length === 1 || editor.saving} onClick={() => editor.removePage(screen.key)}><Trash size={17} /></button>
        </div>
      </div>)}
      {screens.length < 2000 && <button type="button" className="desktop-screen-new" disabled={editor.saving} onClick={() => editor.addPage()}><Plus size={28} /><span>{tr("添加一屏")}</span></button>}
    </div>
    {editor.error && <p className="form-error" role="alert">{tr(editor.error)}</p>}
  </Dialog>;
}

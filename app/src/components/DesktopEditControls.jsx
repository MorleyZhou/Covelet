import { tr, builtinName, formatNumber } from "../i18n/index.js";
import { Plus, Trash, Check, SquaresFour, ArrowCounterClockwise, ArrowClockwise, LockSimple, CaretLeft, CaretRight } from '@phosphor-icons/react';
import { DESKTOP_ROWS, layoutDesktop } from '../lib/desktop-layout.js';
import { desktopPageName } from '../lib/desktop-pages.js';
import FolderName from './FolderName.jsx';
import './desktop-edit.css';
import { Button } from './ui/button.jsx';

export function DesktopEditBar({ editor, onManage, drag, onDelete }) {
  return <div className="desktop-edit-bar" data-layout-control>
    {editor.error && <p className="desktop-edit-error" role="alert">{tr(editor.error)}</p>}
    <div className="desktop-edit-actions" role="toolbar" aria-label={tr("编辑布局")}>
      <Button variant="unstyled" size="unstyled" type="button" disabled={editor.saving} onClick={onManage}><SquaresFour size={17} />{tr("屏幕管理")}</Button>
      <span className="desktop-edit-divider" />
      <Button variant="unstyled" size="unstyled" type="button" className="desktop-edit-history" disabled={!editor.canUndo} onClick={editor.undo}
        aria-label={tr("撤销布局操作")} title={`${tr("撤销布局操作")} (Ctrl/⌘+Z)`}><ArrowCounterClockwise size={18} /><span>{tr("撤销")}</span></Button>
      <Button variant="unstyled" size="unstyled" type="button" className="desktop-edit-history" disabled={!editor.canRedo} onClick={editor.redo}
        aria-label={tr("重做布局操作")} title={`${tr("重做布局操作")} (Ctrl/⌘+Shift+Z)`}><ArrowClockwise size={18} /><span>{tr("重做")}</span></Button>
      <span className="desktop-edit-divider" />
      <Button variant="unstyled" size="unstyled" type="button" disabled={editor.saving} onClick={editor.cancel}>{tr("取消")}</Button>
      <Button variant="unstyled" size="unstyled" type="button" className="desktop-edit-done" disabled={editor.saving || editor.conflict} onClick={editor.save}>{tr("完成")}</Button>
      <Button variant="unstyled" size="unstyled" type="button" data-layout-trash className={`desktop-edit-trash ${drag?.target?.kind === 'delete' ? 'is-drop-target' : ''}`}
        disabled={editor.saving || editor.conflict || !editor.selectedIds.length} aria-label={tr("删除所选项目")} title={tr("删除所选项目")}
        onClick={() => onDelete(editor.selectedIds)}><Trash size={21} /></Button>
    </div>
    <p className="desktop-edit-shortcuts"><span>{tr("点击多选")}</span><span aria-hidden="true">/</span><span><kbd>Esc</kbd>{tr(" 退出编辑")}</span><span aria-hidden="true">/</span><span><kbd>Enter</kbd>{tr(" 保存")}</span></p>
  </div>;
}

export function DesktopScreenManager({ Dialog, state, columns, activeKey, editor, onSelect, onClose, renderIcon, hiddenIds = [] }) {
  const screens = layoutDesktop(state.entries, columns, null, state.settings.pages);
  const hidden = new Set(hiddenIds);
  return <Dialog title={tr("屏幕管理")} onClose={onClose} wide className="desktop-screen-manager">
    <div className="desktop-screen-list">
      {screens.map((screen, index) => <div className={`desktop-screen-card ${screen.key === activeKey ? 'is-current' : ''}`} key={screen.key}>
        <Button variant="unstyled" size="unstyled" type="button" className="desktop-screen-preview" aria-label={state.settings.desktopPages?.[screen.page]?.name ? tr('前往 {0}', [desktopPageName(state.settings, screen.page)]) : tr("前往第 {0} 屏", [index + 1])} aria-current={screen.key === activeKey ? 'page' : undefined}
          onClick={() => { onSelect(screen.key); onClose(); }}>
          <span className="desktop-screen-mini-grid" style={{ '--preview-columns': columns, '--preview-rows': DESKTOP_ROWS }} aria-hidden="true">
            {screen.items.map((entry) => {
              const placement = screen.placements.get(entry.id);
              return <span key={entry.id} className={`desktop-screen-mini-item ${entry.type === 'widget' ? 'is-widget' : ''}`}
                style={{ gridRow: `${placement.row} / span ${placement.rows}`, gridColumn: `${placement.column} / span ${placement.columns}` }}>
                {hidden.has(entry.id) ? <span style={{ display: 'grid', justifyItems: 'center', gap: 2, fontSize: 9, lineHeight: 1.2 }}><LockSimple size={16} aria-hidden="true" /><span>{tr('已隐藏')}</span></span>
                  : entry.type === 'widget' ? <span>{builtinName(entry.extensionId, entry.name)}</span> : renderIcon(entry)}
              </span>;
            })}
          </span>
        </Button>
        <div className="desktop-screen-card-footer"><span>{screen.key === `${screen.page}:0`
          ? <FolderName name={state.settings.desktopPages?.[screen.page]?.name || ''} allowEmpty
            placeholder={tr("第 {0} 屏", [formatNumber(index + 1)])} label={tr('第 {0} 屏名称', [formatNumber(index + 1)])}
            onSave={(name) => editor.renamePage(screen.page, name)} />
          : tr("第 {0} 屏", [formatNumber(index + 1)])}{screen.key === activeKey && <Check size={14} aria-hidden="true" />}</span>
          <div className="desktop-screen-actions">
            {screen.key === `${screen.page}:0` && <>
              <Button variant="unstyled" size="unstyled" type="button" aria-label={tr('前移 {0}', [desktopPageName(state.settings, screen.page)])}
                disabled={editor.saving || editor.conflict || screen.page === state.settings.pages[0]} onClick={() => editor.movePage(screen.page, -1)}><CaretLeft size={17} /></Button>
              <Button variant="unstyled" size="unstyled" type="button" aria-label={tr('后移 {0}', [desktopPageName(state.settings, screen.page)])}
                disabled={editor.saving || editor.conflict || screen.page === state.settings.pages.at(-1)} onClick={() => editor.movePage(screen.page, 1)}><CaretRight size={17} /></Button>
            </>}
            <Button variant="unstyled" size="unstyled" type="button" className="desktop-screen-delete" aria-label={tr("删除第 {0} 屏", [index + 1])} title={screens.length === 1 ? tr("至少保留一屏") : tr("删除屏幕")}
              disabled={screens.length === 1 || editor.saving} onClick={() => editor.removePage(screen.key)}><Trash size={17} /></Button>
          </div>
        </div>
      </div>)}
      {screens.length < 2000 && <Button variant="unstyled" size="unstyled" type="button" className="desktop-screen-new" disabled={editor.saving} onClick={() => editor.addPage()}><Plus size={28} /><span>{tr("添加一屏")}</span></Button>}
    </div>
    {editor.error && <p className="form-error" role="alert">{tr(editor.error)}</p>}
  </Dialog>;
}

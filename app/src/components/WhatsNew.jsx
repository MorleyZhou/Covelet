import { tr } from '../i18n/index.js';
import { Disclosure } from './ui/disclosure.jsx';

export default function WhatsNew() {
  return <Disclosure title={tr('{0} 更新内容', ['0.3.0'])}>
    <ul>
      <li>{tr('新安装默认空桌面。时间和日期移到搜索框上方，可在极简模式中隐藏。')}</li>
      <li>{tr('自备存储同步（Beta）：冲突时整组选择本机或云端版本，改进图片同步和中断重试。')}</li>
      <li>{tr('完整备份可恢复导航、便笺和图片；恢复前保留一份副本。')}</li>
      <li>{tr('取消文件夹重命名不再关闭文件夹，弹窗焦点也已修正。')}</li>
    </ul>
    <p className="hint">{tr('阿里云 OSS 仍为 Beta。')}</p>
  </Disclosure>;
}

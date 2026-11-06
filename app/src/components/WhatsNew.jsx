import { tr } from '../i18n/index.js';
import manifest from '../../extension.manifest.json' with { type: 'json' };
import { Disclosure } from './ui/disclosure.jsx';

export default function WhatsNew() {
  return <>
    <Disclosure title={tr('{0} 更新内容', [manifest.version])}>
      <ul>
        <li>{tr('首页保持一屏。可设置时区，并分别显示或隐藏农历与星座。')}</li>
        <li>{tr('自备存储同步移到扩展中心。解锁只需同步密码，中断后可接着同步。')}</li>
        <li>{tr('备份与恢复可在设置中直接完成。回收站和关于各有独立入口。')}</li>
        <li>{tr('随机壁纸支持 Bing 和 Wikimedia Commons，可设置自动更换间隔。')}</li>
      </ul>
    </Disclosure>
    <Disclosure title={tr('{0} 更新内容', ['0.3.0'])}>
      <ul>
        <li>{tr('新安装默认空桌面。时间和日期移到搜索框上方，可在极简模式中隐藏。')}</li>
        <li>{tr('同步遇到冲突时，可选择整份本机或云端版本。图片同步支持中断后重试。')}</li>
        <li>{tr('完整备份可恢复导航、便笺和图片；恢复前保留一份副本。')}</li>
        <li>{tr('取消文件夹重命名不再关闭文件夹，弹窗焦点也已修正。')}</li>
      </ul>
    </Disclosure>
  </>;
}

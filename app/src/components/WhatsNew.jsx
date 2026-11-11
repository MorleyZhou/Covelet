import { tr } from '../i18n/index.js';
import { Disclosure } from './ui/disclosure.jsx';

export default function WhatsNew() {
  return <>
    <Disclosure title={tr('{0} 更新内容', ['0.5.0'])}>
      <ul>
        <li>{tr('网站和稍后读支持备注，网站、便笺与稍后读共用标签。')}</li>
        <li>{tr('保存动态清单，在链接列表中按位置整理，并审阅重复网址。')}</li>
        <li>{tr('网页选文连同出处存为便笺，便笺支持 Markdown 导入导出。')}</li>
        <li>{tr('稍后读支持再看日期，以及批量标记、归档和删除。')}</li>
        <li>{tr('用搜索引擎关键词快速搜索，删除的网站和文件夹可从回收站恢复。')}</li>
        <li>{tr('完整备份可用独立密码加密，在另一浏览器中离线恢复。')}</li>
      </ul>
    </Disclosure>
    <Disclosure title={tr('{0} 更新内容', ['0.4.0'])}>
      <ul>
        <li>{tr('命名桌面、设置默认桌面并搜索跳转。')}</li>
        <li>{tr('批量打开文件夹中的网站，或将链接保存到指定桌面。')}</li>
        <li>{tr('导入 Markdown 链接，按桌面或文件夹导出书签 HTML。')}</li>
      </ul>
    </Disclosure>
    <Disclosure title={tr('{0} 更新内容', ['0.3.1'])}>
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

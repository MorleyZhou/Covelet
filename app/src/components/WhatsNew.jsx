import { tr } from '../i18n/index.js';
import { Disclosure } from './ui/disclosure.jsx';

export default function WhatsNew() {
  return <Disclosure title={tr('0.2.2 更新内容')}>
    <ul>
      <li>{tr('WebDAV：分步设置，单独测试连接；重启浏览器后需重新解锁。')}</li>
      <li>{tr('书签 HTML：预览后导入，默认保留本地网址并报告跳过数量。')}</li>
      <li>{tr('隐私自查：查看权限、联网功能和数据位置。无遥测或请求次数统计。')}</li>
    </ul>
  </Disclosure>;
}

import { tr } from '../i18n/index.js';
import { Disclosure } from './ui/disclosure.jsx';

export default function WhatsNew() {
  return <Disclosure title={tr('0.2.2 更新内容')}>
    <ul>
      <li>{tr('WebDAV 支持分步设置和连接测试，重启浏览器后需重新解锁。')}</li>
      <li>{tr('可导入浏览器书签 HTML 文件，导入前可预览，默认保留已有网址。')}</li>
      <li>{tr('新增隐私自查，可查看权限用途、联网功能和数据位置。')}</li>
    </ul>
  </Disclosure>;
}

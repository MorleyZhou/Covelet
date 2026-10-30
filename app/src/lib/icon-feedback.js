import { tr } from '../i18n/index.js';

export function iconFailureMessage(failure) {
  switch (failure?.code) {
    case 'ACCESS': return tr('无法获取图片，请检查网络或网站访问权限。');
    case 'NETWORK': return tr('图片加载失败，请检查网络。');
    case 'HTTP': return tr('图片加载失败（{0}）。', [failure.httpStatus || '?']);
    case 'FORMAT': return tr('未找到可用图片，请检查图标地址。');
    case 'DECODE': return tr('无法打开这张图片，请换一个地址。');
    case 'LIMIT': return tr('图片过大，请换一张较小的图片。');
    case 'STORAGE': return tr('图标保存失败，请重试。');
    case 'TIMEOUT': return tr('获取图标超时，请重试。');
    case 'REDIRECT': return tr('无法访问图片链接，请换一个地址。');
    case 'CANCELLED': return tr('已取消');
    default: return tr('未获取到图标，请重新获取或更换地址。');
  }
}

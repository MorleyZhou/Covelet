import { tr, formatNumber } from '../i18n/index.js';

export default function NavigationIconStatus({ report, busy = false }) {
  if (!report) return null;
  const progressing = busy && report.completed < report.total;
  if (!progressing && !report.cancelled && (busy || !report.failed && !report.unrecoverableLocalAssets)) return null;
  return <div className="form-stack" role="status" aria-live="polite">
    {progressing && <p className="hint">{tr('正在补齐图标：{0}/{1}', [formatNumber(report.completed), formatNumber(report.total)])}</p>}
    {report.cancelled && <p className="hint">{tr('内容已更新，请重试。')}</p>}
    {!busy && report.failed > 0 && <p className="hint">{tr('{0} 个图标未能获取，可授权后重试，或更换图标地址。', [formatNumber(report.failed)])}</p>}
    {!busy && report.unrecoverableLocalAssets > 0 && <p className="hint">{tr('{0} 张图片已丢失，请重新选择图片或恢复备份。', [formatNumber(report.unrecoverableLocalAssets)])}</p>}
  </div>;
}

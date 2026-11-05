import { useEffect, useRef, useState } from 'react';
import { tr, formatNumber, getLocale } from '../i18n/index.js';
import { recoveryCenter } from '../lib/recovery-center.js';
import { requestNavigationIconAccess } from '../lib/navigation-icon-intake.js';
import { repairNavigationIcons } from '../lib/navigation-icon-repair.js';
import { userErrorMessage } from '../lib/user-error.js';
import NavigationIconStatus from './NavigationIconStatus.jsx';
import { Button } from './ui/button.jsx';
import { Input } from './ui/input.jsx';
import { Checkbox } from './ui/checkbox.jsx';
import Select from './Select.jsx';
import './recovery-center.css';

const labels = () => ({ navigation: tr('导航、文件夹与外观'), notes: tr('便笺'), reading: tr('稍后读'), trash: tr('工具回收站'), templates: tr('桌面方案'), preferences: tr('别名与隐私标记') });
const formatDateTime = (date) => new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(date);
export function downloadRecoveryFile(blob, name) {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function RecoveryCenter({ onBusyChange, onRestored }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [plan, setPlan] = useState(null), [selected, setSelected] = useState([]), [mode, setMode] = useState('append'), [point, setPoint] = useState(null), [confirmed, setConfirmed] = useState(false);
  const [iconReport, setIconReport] = useState(null);
  const input = useRef(null), source = useRef(null), sourcePointId = useRef(null), working = useRef(false);
  useEffect(() => { recoveryCenter.getRecoveryPoint().then(setPoint).catch((reason) => setError(userErrorMessage(reason))); }, []);
  async function run(action) {
    if (working.current) return;
    working.current = true; setBusy(true); onBusyChange?.(true); setError(''); setMessage('');
    try { await action(); } catch (reason) { setError(userErrorMessage(reason)); }
    finally { working.current = false; setBusy(false); onBusyChange?.(false); recoveryCenter.getRecoveryPoint().then(setPoint).catch(() => {}); }
  }
  const show = (next) => { setPlan(next); setSelected(next.categories); setConfirmed(false); };
  const names = labels();
  return <div className="form-stack recovery-center">
    <p className="hint">{tr('备份包含私人内容，请勿公开分享。登录凭据、同步连接和密码不会备份。')}</p>
    <div className="recovery-actions">
      <Button variant="secondary" disabled={busy} onClick={() => run(async () => downloadRecoveryFile(await recoveryCenter.exportCompleteBackup(), 'Covelet-complete-backup.json'))}>{tr('导出完整备份')}</Button>
      <Button variant="secondary" disabled={busy} onClick={() => input.current?.click()}>{tr('选择备份文件')}</Button>
      <Input ref={input} type="file" accept=".json,.zip,application/json,application/zip" hidden tabIndex={-1} onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
        source.current = file; sourcePointId.current = null; run(async () => show(await recoveryCenter.preview(file)));
      }} />
    </div>
    <p className="hint">{tr('恢复前会在当前浏览器保留一份副本。')}</p>
    <div className="form-stack">
      <div className="recovery-actions">
        <Button variant="secondary" disabled={busy} onClick={() => run(async () => {
          const result = await repairNavigationIcons({ onIconProgress: setIconReport });
          setIconReport(result); if (result.state) onRestored?.(result.state);
        })}>{tr('补齐缺失图标')}</Button>
        {iconReport?.failed > 0 && <Button variant="secondary" disabled={busy} onClick={() => {
          const sourceUrls = iconReport.missing.map(({ source }) => source);
          const authorization = requestNavigationIconAccess(iconReport.missing);
          run(async () => {
            if (!await authorization) throw Error(tr('未获得图片网站访问权限，已保留现有图标。'));
            const result = await repairNavigationIcons({ sourceUrls, onIconProgress: setIconReport });
            setIconReport(result); if (result.state) onRestored?.(result.state);
          });
        }}>{tr('授权并重试缺失图标')}</Button>}
      </div>
      <NavigationIconStatus report={iconReport} busy={busy} />
    </div>
    {[point, point?.previous].filter(Boolean).map((item) => <section className="recovery-point" key={item.id}>
      <strong>{tr('恢复前副本')}</strong>
      <span>{formatDateTime(new Date(item.createdAt))}</span>
      {['applying', 'needs-recovery'].includes(item.status) && <p role="alert" className="form-error">{tr('上次恢复未完成，请预览「恢复前副本」，选择需要找回的内容。')}</p>}
      <div className="recovery-actions">
        <Button variant="secondary" disabled={busy} onClick={() => run(async () => { source.current = null; sourcePointId.current = item.id; show(await recoveryCenter.previewRecoveryPoint(item.id)); })}>{tr('预览副本')}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => run(async () => downloadRecoveryFile(await recoveryCenter.exportRecoveryPoint(item.id), 'Covelet-recovery-point.json'))}>{tr('导出副本')}</Button>
      </div>
    </section>)}
    {plan && <section className="form-stack recovery-preview">
      <strong>{tr('恢复预览')}</strong>
      {plan.createdAt && <p className="hint">{tr('备份时间：{0}', [formatDateTime(new Date(plan.createdAt))])}</p>}
      {plan.categories.map((key) => <label className="recovery-category" key={key}>
        <Checkbox disabled={busy} checked={selected.includes(key)} onCheckedChange={(checked) => { setSelected((current) => checked ? [...current, key] : current.filter((value) => value !== key)); setConfirmed(false); }} />
        <span>{names[key]}</span><span>{formatNumber(plan.summary[key])}</span>
      </label>)}
      <Select label={tr('恢复方式')} value={mode} disabled={busy} onChange={(value) => { setMode(value); setConfirmed(false); }} options={[
        { value: 'append', label: tr('添加新内容，保留已有内容') }, { value: 'replace', label: tr('替换所选类别') },
      ]} />
      <p className="hint">{mode === 'append' ? tr('只添加新内容，重复内容保留现有版本。新增导航会放到新屏幕。') : tr('所选类别将被替换；备份中为空的类别也会清空。')}</p>
      <p className="hint">{tr('如果已开启同步，恢复的内容也会同步到其他设备。当前隐藏状态不变。')}</p>
      <label className="recovery-category"><Checkbox checked={confirmed} disabled={busy} onCheckedChange={(value) => setConfirmed(value === true)} /><span>{tr('我已确认所选类别和恢复方式')}</span></label>
      <div className="recovery-actions">
        <Button disabled={busy || !selected.length || !confirmed} onClick={() => run(async () => {
          const result = await recoveryCenter.restore(plan, { selected, mode, onIconProgress: setIconReport });
          if (result.iconReport) setIconReport(result.iconReport);
          setPlan(null); setConfirmed(false); setMessage(tr('恢复完成。')); onRestored?.(result.state);
        })}>{busy ? tr('正在恢复…') : tr('开始恢复')}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => run(async () => show(source.current ? await recoveryCenter.preview(source.current) : await recoveryCenter.previewRecoveryPoint(sourcePointId.current)))}>{tr('重新预览')}</Button>
      </div>
    </section>}
    {message && <p role="status">{message}</p>}
    {error && <p className="form-error" role="alert">{tr(error)}</p>}
  </div>;
}

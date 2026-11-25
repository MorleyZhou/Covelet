import { tr } from '../i18n/index.js';
import { getExtensionApi } from './extension-api.js';

export const SCHEDULED_BACKUP_ALARM = 'covelet:backup:due';
const RUN = 'covelet:backup:run', REFRESH = 'covelet:backup:refresh';
const safeCode = (value) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : 'SCHEDULED_BACKUP_FAILED';
const failure = (code = 'SCHEDULED_BACKUP_FAILED') => ({ ok: false, error: {
  code, message: tr('自动备份未完成，请检查备份目录和权限后重试。'),
} });
const scalar = (value) => value === null || ['string', 'number', 'boolean'].includes(typeof value);

function publicStatus(value) {
  const result = {};
  for (const key of ['enabled', 'frequency', 'directoryName', 'lastSuccess', 'nextDue', 'phase', 'permission'])
    if (scalar(value?.[key])) result[key] = value[key];
  if (value?.lastError === null) result.lastError = null;
  else if (value?.lastError && typeof value.lastError === 'object') {
    result.lastError = {};
    for (const key of ['code', 'message', 'at']) if (scalar(value.lastError[key])) result.lastError[key] = value.lastError[key];
  }
  if (Array.isArray(value?.files)) result.files = value.files.map((file) => {
    const entry = {};
    for (const key of ['name', 'filename', 'size', 'createdAt', 'at', 'digest']) if (scalar(file?.[key])) entry[key] = file[key];
    return entry;
  });
  return result;
}

// Register synchronously when the MV3 module starts. The initialization promise
// gates work, never listener installation, so an event waking a fresh worker is
// retained. Scheduler methods persist their own failure state before rejecting.
export function startScheduledBackupBackground(controller, { extension = getExtensionApi(), ready = Promise.resolve(),
  reportError = ({ operation, code }) => console.error('Covelet scheduled backup worker failure', operation, code) } = {}) {
  let stopped = false, restoration;
  const report = (operation, cause) => {
    try { reportError({ operation, code: safeCode(cause?.code) }); }
    catch { console.error('Covelet scheduled backup error reporting failed'); }
  };
  const broadcast = async (value) => {
    if (typeof extension.runtime.sendMessage !== 'function') return;
    try { await extension.runtime.sendMessage({ type: 'covelet:backup:status', status: publicStatus(value) }); }
    catch { /* No open extension page is a normal background-only state. */ }
  };
  const perform = async (operation, manual = false) => {
    try {
      await ready;
      if (stopped) return failure('SCHEDULED_BACKUP_STOPPED');
      const result = operation === 'run' ? await controller.run({ manual }) : await controller.restoreSchedule();
      await broadcast(result);
      return { ok: true, status: publicStatus(result) };
    } catch (cause) {
      // Never forward raw exceptions: filesystem messages can contain a path,
      // and unexpected dependency errors can contain private input. The UI can
      // read the scheduler's persisted, sanitized lastError for recovery.
      report(operation, cause);
      const reply = failure(safeCode(cause?.code));
      let state;
      try { state = await controller.getSettings(); }
      catch (reason) {
        report('status', reason);
        state = { phase: 'error', lastError: { ...reply.error, at: Date.now() } };
      }
      await broadcast(state);
      return reply;
    }
  };
  const restore = () => {
    if (!restoration) restoration = perform('refresh').finally(() => { restoration = undefined; });
    return restoration;
  };
  const onAlarm = (alarm) => {
    if (alarm?.name !== SCHEDULED_BACKUP_ALARM || stopped) return;
    return perform('run', false);
  };
  const onMessage = (message, sender, respond) => {
    if (stopped || !message || ![RUN, REFRESH].includes(message.type)
      || sender?.id !== extension.runtime.id || typeof sender.url !== 'string'
      || !sender.url.startsWith(extension.runtime.getURL(''))) return undefined;
    // FileSystemDirectoryHandle, CryptoKey and passwords are native local
    // capabilities. They are never accepted in the worker's JSON request API.
    if (Array.isArray(message) || Object.keys(message).length !== 1 || !Object.hasOwn(message, 'type')) {
      respond(failure('SCHEDULED_BACKUP_INVALID_REQUEST')); return false;
    }
    const action = message.type === RUN ? perform('run', true) : restore();
    action.then((result) => { try { respond(result); } catch (cause) { report('reply', cause); } });
    return true;
  };
  extension.alarms.onAlarm.addListener(onAlarm);
  extension.runtime.onMessage.addListener(onMessage);
  extension.runtime.onStartup.addListener(restore);
  extension.runtime.onInstalled.addListener(restore);
  restore();
  return () => {
    stopped = true;
    extension.alarms.onAlarm.removeListener(onAlarm);
    extension.runtime.onMessage.removeListener(onMessage);
    extension.runtime.onStartup.removeListener(restore);
    extension.runtime.onInstalled.removeListener(restore);
  };
}

import { tr } from '../i18n/index.js';
import { recoveryCenter } from './recovery-center.js';
import { PASSWORD_BACKUP_LIMITS, prepareScheduledBackupKey, encryptScheduledBackup } from './password-backup.js';
import { scheduledBackupStore } from './scheduled-backup-store.js';

export const SCHEDULED_BACKUP_ALARM = 'covelet:backup:due';
const LOCK = 'covelet.scheduled-backup.job.v1', RETAIN = 3;
const intervals = { daily: 86400000, weekly: 7 * 86400000 };
const phases = new Set(['disabled', 'idle', 'running', 'saved', 'error']);
const messages = {
  SCHEDULED_BACKUP_PERMISSION: () => tr('备份目录需要重新授权，请在设置中重新选择目录。'),
  SCHEDULED_BACKUP_STORAGE: () => tr('无法保存自动备份设置，请重试。'),
  SCHEDULED_BACKUP_WRITE: () => tr('备份文件未能写入，已有备份已保留。'),
  SCHEDULED_BACKUP_VERIFY: () => tr('备份文件校验失败，已有备份已保留。'),
  SCHEDULED_BACKUP_QUOTA: () => tr('备份目录空间不足，已有备份已保留。'),
  SCHEDULED_BACKUP_UNSUPPORTED: () => tr('此浏览器不支持所选目录的自动备份。'),
  SCHEDULED_BACKUP_CHANGED: () => tr('备份文件已在其他应用修改，已保留该文件。'),
  SCHEDULED_BACKUP_ALARM: () => tr('无法设置自动备份时间，请重试。'),
  SCHEDULED_BACKUP_INVALID: () => tr('自动备份设置无效，请重新设置。'),
  SCHEDULED_BACKUP_CAPACITY: () => tr('完整备份超过 50 MiB，未写入新备份。'),
  SCHEDULED_BACKUP_CAPTURE: () => tr('无法读取完整备份，已有备份已保留。'),
  SCHEDULED_BACKUP_DISABLED: () => tr('请先设置自动备份。'),
  SCHEDULED_BACKUP_INTERRUPTED: () => tr('上次自动备份未完成，将在后台重试。'),
};
const fail = (code) => { throw Object.assign(Error(messages[code]()), { code }); };
function safeError(reason, fallback = 'SCHEDULED_BACKUP_WRITE') {
  const code = Object.hasOwn(messages, reason?.code) ? reason.code : reason?.name === 'QuotaExceededError' ? 'SCHEDULED_BACKUP_QUOTA'
    : ['NotAllowedError', 'SecurityError'].includes(reason?.name) ? 'SCHEDULED_BACKUP_PERMISSION' : fallback;
  return Object.assign(Error(messages[code]()), { code });
}
const timestamp = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
const hex = (value, length) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const blank = () => ({ version: 1, enabled: false, frequency: 'daily', directory: null, key: null, salt: null, owner: null, directoryName: '',
  phase: 'disabled', lastSuccess: null, nextDue: null, lastError: null, files: [], pending: null });
const validDirectory = (directory) => directory?.kind === 'directory' && typeof directory.name === 'string'
  && ['queryPermission', 'getFileHandle', 'removeEntry'].every((key) => typeof directory[key] === 'function');
function owned(file, owner) {
  if (!file || !hex(owner, 32) || typeof file.name !== 'string' || !timestamp(file.createdAt) || !Number.isSafeInteger(file.size)
    || file.size < PASSWORD_BACKUP_LIMITS.overhead + 1 || file.size > PASSWORD_BACKUP_LIMITS.plaintext + PASSWORD_BACKUP_LIMITS.overhead || !hex(file.digest, 64)) return false;
  const match = /^Covelet-auto-([a-f0-9]{32})-(\d{1,16})-([a-f0-9]{32})\.covelet$/.exec(file.name);
  return Boolean(match && match[1] === owner && match[2] === String(file.createdAt));
}
function validate(state) {
  if (!state || state.version !== 1 || typeof state.enabled !== 'boolean' || !Object.hasOwn(intervals, state.frequency)
    || !phases.has(state.phase) || typeof state.directoryName !== 'string' || state.directoryName.length > 200
    || state.lastSuccess !== null && !timestamp(state.lastSuccess) || state.nextDue !== null && !timestamp(state.nextDue)
    || state.lastError !== null && (!Object.hasOwn(messages, state.lastError?.code) || !timestamp(state.lastError.at))
    || !Array.isArray(state.files) || state.files.length > RETAIN + 1 || state.files.some((file) => !owned(file, state.owner))
    || new Set(state.files.map((file) => file.name)).size !== state.files.length
    || state.pending !== null && !owned(state.pending?.file, state.owner)) fail('SCHEDULED_BACKUP_INVALID');
  if (state.enabled && (!validDirectory(state.directory) || !hex(state.owner, 32) || !(state.salt instanceof Uint8Array) || state.salt.length !== 16
    || !state.key || state.key.type !== 'secret' || state.key.extractable !== false || state.key.algorithm?.name !== 'AES-GCM'
    || state.key.algorithm?.length !== 256 || state.key.usages?.length !== 1 || state.key.usages[0] !== 'encrypt')) fail('SCHEDULED_BACKUP_INVALID');
  return state;
}

export function createScheduledBackups({ store = scheduledBackupStore, capture = () => recoveryCenter.exportCompleteBackup(),
  alarms = globalThis.chrome?.alarms, now = () => Date.now(), crypto = globalThis.crypto, locks = globalThis.navigator?.locks } = {}) {
  let queue = Promise.resolve();
  const exclusive = (action) => {
    if (locks?.request) return locks.request(LOCK, { mode: 'exclusive' }, action);
    // Production extension contexts must share a cross-page/worker lock.
    if (globalThis.chrome?.runtime?.id) return Promise.reject(safeError(null, 'SCHEDULED_BACKUP_UNSUPPORTED'));
    const next = queue.catch(() => {}).then(action); queue = next.catch(() => {}); return next;
  };
  const read = async () => { try { return validate(await store.read() || blank()); } catch (reason) { throw safeError(reason, 'SCHEDULED_BACKUP_STORAGE'); } };
  const save = async (state) => { try { validate(state); await store.write(state); } catch (reason) { throw safeError(reason, 'SCHEDULED_BACKUP_STORAGE'); } };
  const randomId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const digest = async (file) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  async function permission(state) {
    if (!state.enabled || !state.directory) return null;
    try { const result = await state.directory.queryPermission({ mode: 'readwrite' }); return ['granted', 'prompt', 'denied'].includes(result) ? result : 'unavailable'; }
    catch { return 'unavailable'; }
  }
  const requirePermission = async (state) => { if (await permission(state) !== 'granted') fail('SCHEDULED_BACKUP_PERMISSION'); };
  async function settings(state) {
    return { enabled: state.enabled, frequency: state.frequency, directoryName: state.directoryName,
      lastSuccess: state.lastSuccess, nextDue: state.nextDue, phase: state.phase, permission: await permission(state),
      lastError: state.lastError ? { ...state.lastError, message: messages[state.lastError.code]() } : null,
      files: state.files.map(({ name, createdAt, size, digest }) => ({ name, createdAt, size, digest })) };
  }
  async function ensureAlarm(state) {
    if (!state.enabled) { if (alarms?.clear) await alarms.clear(SCHEDULED_BACKUP_ALARM); return; }
    if (!alarms?.create || !alarms?.get) fail('SCHEDULED_BACKUP_UNSUPPORTED');
    try {
      const when = Math.max(now() + 1000, state.nextDue || now() + intervals[state.frequency]);
      const current = await alarms.get(SCHEDULED_BACKUP_ALARM);
      if (!current || Math.abs(current.scheduledTime - when) > 1000 || current.periodInMinutes !== undefined) await alarms.create(SCHEDULED_BACKUP_ALARM, { when });
    } catch (reason) { throw safeError(reason, 'SCHEDULED_BACKUP_ALARM'); }
  }
  async function rememberFailure(state, reason, fallback) {
    const error = safeError(reason, fallback);
    state.phase = 'error'; state.lastError = { code: error.code, at: now() };
    if (state.enabled) state.nextDue = now() + intervals[state.frequency];
    await save(state);
    try { await ensureAlarm(state); } catch { /* The original failure remains visible and startup retries scheduling. */ }
    return error;
  }
  async function fileAt(state, name) {
    try { const handle = await state.directory.getFileHandle(name); return { handle, file: await handle.getFile() }; }
    catch (reason) { if (reason?.name === 'NotFoundError') return null; throw reason; }
  }
  async function matches(file, expected) { return file.size === expected.size && await digest(file) === expected.digest; }
  async function prune(state) {
    while (state.files.length > RETAIN) {
      // The durable append order survives a system clock adjustment. Sorting
      // wall timestamps could otherwise delete the backup we just created.
      const oldest = state.files[0];
      if (!owned(oldest, state.owner)) fail('SCHEDULED_BACKUP_INVALID');
      await requirePermission(state);
      const found = await fileAt(state, oldest.name);
      if (found && !await matches(found.file, oldest)) {
        // A modified file is now user-owned. Forget our deletion authority;
        // preserve its bytes and stop this run with a visible explanation.
        state.files = state.files.filter((file) => file.name !== oldest.name); await save(state); fail('SCHEDULED_BACKUP_CHANGED');
      }
      if (found) {
        try { await state.directory.removeEntry(oldest.name); }
        catch (reason) { if (reason?.name !== 'NotFoundError') throw reason; }
      }
      state.files = state.files.filter((file) => file.name !== oldest.name); await save(state);
    }
  }
  async function repair(state) {
    if (state.pending) {
      const expected = state.pending.file;
      if (!owned(expected, state.owner)) fail('SCHEDULED_BACKUP_INVALID');
      const found = await fileAt(state, expected.name);
      if (found) {
        if (!await matches(found.file, expected)) {
          // Never delete an unverified partial file or a user replacement.
          // It is not counted as a successful, managed backup.
          state.pending = null; await save(state); fail('SCHEDULED_BACKUP_CHANGED');
        }
        if (!state.files.some((file) => file.name === expected.name)) state.files.push(expected);
        state.lastSuccess = expected.createdAt;
      }
      state.pending = null; await save(state);
    }
    await prune(state);
  }
  const api = {
    async getSettings() { return settings(await read()); },
    async configure({ directory, frequency, password } = {}) {
      if (!validDirectory(directory) || !Object.hasOwn(intervals, frequency)) fail('SCHEDULED_BACKUP_INVALID');
      // Derive first; invalid passwords never replace a working schedule.
      const retained = await prepareScheduledBackupKey(password, { crypto }); password = '';
      return exclusive(async () => {
        const previous = await read();
        const candidate = { ...blank(), enabled: true, frequency, directory, directoryName: directory.name.slice(0, 200),
          key: retained.key, salt: retained.salt, owner: randomId(), phase: 'idle', nextDue: now() + intervals[frequency] };
        await requirePermission(candidate);
        let same = false;
        if (previous.directory && typeof directory.isSameEntry === 'function') {
          try { same = await directory.isSameEntry(previous.directory); } catch { /* An unknown identity does not grant deletion authority. */ }
        }
        if (same) {
          await requirePermission(previous); await repair(previous);
          candidate.owner = previous.owner; candidate.files = previous.files; candidate.lastSuccess = previous.lastSuccess;
        }
        await save(candidate);
        try { await ensureAlarm(candidate); } catch (reason) { throw await rememberFailure(candidate, reason, 'SCHEDULED_BACKUP_ALARM'); }
        return settings(candidate);
      });
    },
    async run({ manual = false } = {}) {
      return exclusive(async () => {
        const state = await read();
        if (!state.enabled) { if (manual) fail('SCHEDULED_BACKUP_DISABLED'); return settings(state); }
        if (!manual && state.nextDue > now() && !state.pending && state.files.length <= RETAIN) return settings(state);
        let writable;
        try {
          await requirePermission(state); await repair(state);
          state.phase = 'running'; state.lastError = null; await save(state);
          let plain;
          try { plain = await capture(); } catch (reason) { throw safeError(reason, 'SCHEDULED_BACKUP_CAPTURE'); }
          if (!(plain instanceof Blob) || plain.size < 1 || plain.size > PASSWORD_BACKUP_LIMITS.plaintext) fail('SCHEDULED_BACKUP_CAPACITY');
          const encrypted = await encryptScheduledBackup(plain, { key: state.key, salt: state.salt }, { crypto }); plain = null;
          const createdAt = now(), name = `Covelet-auto-${state.owner}-${createdAt}-${randomId()}.covelet`;
          const descriptor = { name, createdAt, size: encrypted.size, digest: await digest(encrypted) };
          // A random collision must never overwrite an existing user file.
          if (await fileAt(state, name)) fail('SCHEDULED_BACKUP_CHANGED');
          state.pending = { file: descriptor }; await save(state);
          await requirePermission(state);
          const handle = await state.directory.getFileHandle(name, { create: true });
          writable = await handle.createWritable({ keepExistingData: false, mode: 'exclusive' });
          await writable.write(encrypted); await writable.close(); writable = undefined;
          const found = await fileAt(state, name);
          if (!found || !await matches(found.file, descriptor)) fail('SCHEDULED_BACKUP_VERIFY');
          state.files.push(descriptor); state.pending = null; state.lastSuccess = now();
          state.nextDue = now() + intervals[state.frequency]; await save(state);
          await prune(state);
          state.phase = 'saved'; state.lastError = null; await save(state); await ensureAlarm(state);
          return settings(state);
        } catch (reason) {
          if (writable?.abort) { try { await writable.abort(); } catch { /* Keep the journal for the next run. */ } }
          throw await rememberFailure(state, reason, 'SCHEDULED_BACKUP_WRITE');
        }
      });
    },
    async disable() {
      return exclusive(async () => {
        const state = await read();
        Object.assign(state, { enabled: false, directory: null, key: null, salt: null, phase: 'disabled', nextDue: null, lastError: null, pending: null });
        await save(state);
        try { await ensureAlarm(state); } catch (reason) { throw await rememberFailure(state, reason, 'SCHEDULED_BACKUP_ALARM'); }
        return settings(state);
      });
    },
    async restoreSchedule() {
      return exclusive(async () => {
        const state = await read();
        try {
          if (state.enabled) {
            await requirePermission(state);
            if (state.phase === 'running') {
              await repair(state);
              state.phase = 'error'; state.lastError = { code: 'SCHEDULED_BACKUP_INTERRUPTED', at: now() }; state.nextDue = now();
              await save(state);
            }
          }
          await ensureAlarm(state); return settings(state);
        }
        catch (reason) { throw await rememberFailure(state, reason, 'SCHEDULED_BACKUP_ALARM'); }
      });
    },
  };
  return api;
}

export const scheduledBackups = createScheduledBackups();

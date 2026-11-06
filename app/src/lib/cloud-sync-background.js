import { localData } from './local-data.js';
import { SYNC_JOB_KEY } from './sync-data-rules.js';

const RUN = 'covelet:sync:run';
const STATUS = 'covelet:sync:status';
const ALARM = 'covelet:sync:resume';
const SESSION = 'covelet.cloud.session.v1';
const SETTINGS = 'covelet.cloud.local.v1';
const choices = new Set(['local', 'remote']);
const transportInterrupted = new Set(['CLOUD_TIMEOUT', 'CLOUD_NETWORK', 'CLOUD_OFFLINE']);
const available = () => globalThis.chrome?.runtime?.id && globalThis.chrome.runtime.sendMessage;
const interrupted = () => ({ phase: 'error', code: 'DATA_SYNC_LOCAL' });

function fromExtension(extension, sender) {
  return sender?.id === extension.runtime.id && sender.url?.startsWith(extension.runtime.getURL(''));
}

export function requestBackgroundCloudSync(choice) {
  if (!available() || choice !== undefined && !choices.has(choice)) return Promise.resolve(interrupted());
  return globalThis.chrome.runtime.sendMessage({ type: RUN, choice }).catch(interrupted);
}

export function subscribeBackgroundCloudSyncStatus(listener) {
  if (!available()) return () => {};
  const { runtime } = globalThis.chrome;
  let active = true;
  let received = false;
  const onMessage = (message, sender) => {
    if (!fromExtension(globalThis.chrome, sender) || message?.type !== STATUS || !message.status) return;
    received = true;
    listener(message.status);
  };
  runtime.onMessage.addListener(onMessage);
  runtime.sendMessage({ type: STATUS }).then(status => { if (active && !received && status) listener(status); }).catch(() => {});
  return () => { active = false; runtime.onMessage.removeListener(onMessage); };
}

function defaultStore() {
  return {
    async read() { return (await localData.get(SYNC_JOB_KEY))[SYNC_JOB_KEY]; },
    write(job) { return localData.set({ [SYNC_JOB_KEY]: job }); },
    clear() { return localData.remove(SYNC_JOB_KEY); },
  };
}

function validJob(job) {
  return job?.version === 1 && typeof job.id === 'string' && /^[a-f0-9]{32}$/.test(job.id)
    && typeof job.target === 'string' && /^[a-f0-9]{64}$/.test(job.target)
    && (job.choice === null || choices.has(job.choice));
}

export function startCloudSyncBackground(controller, { extension = globalThis.chrome, ready = Promise.resolve(), store = defaultStore(), uuid = () => crypto.randomUUID(),
  subscribeSettings = listener => localData.subscribe(changes => { if (Object.hasOwn(changes, SETTINGS)) listener(); }),
} = {}) {
  const { runtime, alarms, storage } = extension;
  let preparation = Promise.resolve(), flight, flightChoice, visibleStatus = null, visibleTarget;

  async function ensureAlarm(enabled) {
    const exists = await alarms.get(ALARM);
    if (enabled && !exists) await alarms.create(ALARM, { periodInMinutes: 1 });
    else if (!enabled && exists) await alarms.clear(ALARM);
  }

  async function readJob(target) {
    const job = await store.read();
    if (!job) return null;
    if (validJob(job) && job.target === target) return job;
    await store.clear();
    return null;
  }

  const emit = status => {
    visibleStatus = status;
    runtime.sendMessage({ type: STATUS, status }).catch(() => {});
  };
  const unsubscribe = controller.subscribeCloudSyncStatus(status => { if (flight) emit(status); });

  function resultForChoice(choice) {
    if (!choice || choice === flightChoice) return flight;
    if (flightChoice) return { phase: 'error', code: 'DATA_SYNC_CONFLICT_STALE' };
    // A tab can see the conflict result before its completed sync job clears.
    // Queue the choice after that job, outside the serialized preparation.
    return flight.then(status => status.phase === 'conflict' ? prepare({ requested: true, choice }) : status);
  }

  function prepare({ requested = false, choice, automatic = false, resume = true } = {}) {
    const prepared = preparation.then(async () => {
      if (flight) return { result: resultForChoice(choice) };
      await ready;
      const settings = await controller.loadCloudSyncSettings();
      const target = settings.configured ? await controller.getCloudSyncTarget() : null;
      if (visibleTarget !== target) { visibleTarget = target; visibleStatus = null; }
      let job = await readJob(target);
      if (!target || !settings.unlocked) {
        await ensureAlarm(false);
        visibleStatus = null;
        return { result: controller.getCloudSyncStatus() };
      }
      const autoSync = settings.autoSync && !controller.getCloudSyncStatus().conflicts;
      if (!job && (requested || automatic && autoSync)) {
        job = { version: 1, id: uuid().replaceAll('-', ''), target, choice: choice ?? null };
        if (!validJob(job)) throw Error('Invalid sync job');
        // Establish the wake-up before marking the job active. Once the marker
        // commits, either this worker or the next alarm can execute the job.
        await ensureAlarm(true);
        await store.write(job);
      }
      await ensureAlarm(Boolean(job || autoSync));
      if (!job || !resume) return { result: controller.getCloudSyncStatus() };

      const options = { taskId: job.id, expectedTarget: job.target };
      flightChoice = job.choice;
      flight = Promise.resolve().then(async () => {
        let status;
        try { status = job.choice ? await controller.resolveCloudSyncConflicts(job.choice, options) : await controller.syncCloudNow(options); }
        catch { status = interrupted(); emit(status); }
        // Keep interrupted transport jobs for the next alarm. Authentication,
        // conflicts and other explicit terminal outcomes end the current job.
        if (status.cleanup !== 'deferred' && status.phase !== 'locked' && !(status.phase === 'error' && transportInterrupted.has(status.code))) await store.clear();
        return status;
      }).finally(() => {
        flight = flightChoice = undefined;
        void prepare({ resume: false }).catch(() => {});
      });
      return { result: resultForChoice(choice) };
    });
    preparation = prepared.then(() => {}, () => {});
    return prepared.then(result => result.result);
  }

  const wake = () => { void prepare().catch(() => {}); };
  const onAlarm = alarm => { if (alarm.name === ALARM) void prepare({ automatic: true }).catch(() => {}); };
  const onStorage = (changes, area) => { if (area === 'session' && Object.hasOwn(changes, SESSION)) wake(); };
  const onMessage = (message, sender, respond) => {
    if (!fromExtension(extension, sender)) return;
    if (message?.type === STATUS && !message.status) { respond(visibleStatus); return; }
    if (message?.type !== RUN || message.choice !== undefined && !choices.has(message.choice)) return;
    prepare({ requested: true, choice: message.choice }).then(respond, () => respond(interrupted()));
    return true;
  };
  runtime.onMessage.addListener(onMessage);
  runtime.onStartup.addListener(wake);
  runtime.onInstalled.addListener(wake);
  alarms.onAlarm.addListener(onAlarm);
  storage.onChanged.addListener(onStorage);
  const unsubscribeSettings = subscribeSettings(wake);
  wake();
  return () => {
    unsubscribe();
    unsubscribeSettings();
    runtime.onMessage.removeListener(onMessage);
    runtime.onStartup.removeListener(wake);
    runtime.onInstalled.removeListener(wake);
    alarms.onAlarm.removeListener(onAlarm);
    storage.onChanged.removeListener(onStorage);
  };
}

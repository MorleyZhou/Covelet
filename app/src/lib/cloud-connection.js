import { tr } from '../i18n/index.js';

// Shared setup boundary for Settings and onboarding. Testing needs
// provider credentials only; the independent sync password is used at save/
// unlock, and first-sync performs encryption/decryption and write validation.
export const SYNC_SETUP_STEPS = Object.freeze(['channel', 'connection-test', 'sync-password', 'first-sync']);
export const SYNC_PROVIDERS = Object.freeze(['webdav', 'r2', 'oss', 'github', 'gitlab']);
export function cloudProviderLabel(provider) {
  const name = { webdav: 'WebDAV', r2: 'Cloudflare R2', oss: tr('阿里云 OSS'), github: 'GitHub', gitlab: 'GitLab' }[provider];
  return provider === 'oss' ? tr('{0}（Beta）', [name]) : name;
}

export function requireCloudSyncSuccess(result) {
  if (result?.phase !== 'saved') throw Object.assign(new Error(result?.message || tr('同步操作未完成，本机数据已保留。')), { code: result?.code || 'CLOUD_REQUEST' });
}

// A first attempt must not start background retries before the user has seen
// its outcome. Saving alone still performs no provider I/O or connection test.
export async function finishCloudSetup({ profile, secrets, password, autoSync = false, firstSync = true, onSaved }, api) {
  let saved = await api.saveCloudSyncSettings(profile, secrets, password, { autoSync: false });
  onSaved?.(saved);
  if (firstSync) {
    const result = await api.syncCloudNow();
    // A detected conflict preserves the configured connection for the choice.
    if (result?.phase !== 'conflict') requireCloudSyncSuccess(result);
    if (autoSync) saved = await api.saveCloudSyncSettings(profile, secrets, password, { autoSync: true, onlyIfCurrent: true });
  }
  return saved;
}

export async function probeCloudConnection(profile, secrets, { providerFactory, signer, check, now }) {
  const provider = providerFactory(profile, secrets, { signer, beforeRequest: check });
  await check();
  if (provider.testConnection) await provider.testConnection();
  else await provider.list();
  await check();
  return { testedAt: now(), scope: 'directory-read' };
}

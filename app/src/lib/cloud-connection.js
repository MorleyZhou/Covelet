import { tr } from '../i18n/index.js';

// Shared setup boundary for Settings and onboarding. Testing needs
// provider credentials only; the independent sync password is used at save/
// unlock, and first-sync performs encryption/decryption and write validation.
export const SYNC_SETUP_STEPS = Object.freeze(['channel', 'connection-test', 'sync-password', 'first-sync']);
export const SYNC_PROVIDERS = Object.freeze(['webdav', 'r2', 'oss', 'github', 'gitlab']);
export function cloudProviderLabel(provider) {
  const name = { webdav: 'WebDAV', r2: 'Cloudflare R2', oss: tr('阿里云 OSS'), github: 'GitHub', gitlab: 'GitLab' }[provider];
  return name;
}

// A first attempt must not start background retries before the user has seen
// its outcome. Saving alone still performs no provider I/O or connection test.
export async function finishCloudSetup({ profile, secrets, password, autoSync = false, firstSync = true }, api) {
  let saved = await api.saveCloudSyncSettings(profile, secrets, password, { autoSync: false });
  if (firstSync) {
    // The hardened controller resolves to a status on transport/decrypt errors.
    // Only its actual saved phase completes onboarding or opts into auto sync.
    const result = await api.syncCloudNow();
    if (result?.phase !== 'saved') throw Object.assign(new Error(result?.message || tr('同步操作未完成，本机数据已保留。')), { code: result?.code || 'CLOUD_REQUEST' });
    if (autoSync) saved = await api.saveCloudSyncSettings(profile, secrets, password, { autoSync: true });
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

import { tr } from '../i18n/index.js';

// Shared setup boundary for Settings and future onboarding. Testing needs
// provider credentials only; the independent sync password is used at save/
// unlock, and first-sync performs encryption/decryption and write validation.
export const SYNC_SETUP_STEPS = Object.freeze(['channel', 'connection-test', 'sync-password', 'first-sync']);
export const SYNC_PROVIDERS = Object.freeze(['webdav', 'r2', 'oss', 'github', 'gitlab']);
export function cloudProviderLabel(provider) {
  const name = { webdav: 'WebDAV', r2: 'Cloudflare R2', oss: tr('阿里云 OSS'), github: 'GitHub', gitlab: 'GitLab' }[provider];
  return provider === 'webdav' ? name : tr('{0}（Beta）', [name]);
}

export async function probeCloudConnection(profile, secrets, { providerFactory, signer, check, now }) {
  const provider = providerFactory(profile, secrets, { signer, beforeRequest: check });
  await check();
  if (provider.testConnection) await provider.testConnection();
  else await provider.list();
  await check();
  return { testedAt: now(), scope: 'directory-read' };
}

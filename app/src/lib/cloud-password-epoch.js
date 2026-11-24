import { encryptCloudPayload, decryptCloudPayload } from './cloud-crypto.js';

const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const identifier = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const fail = (code = 'CLOUD_PASSWORD_CHANGED') => { throw Object.assign(Error(code), { code }); };
export const epochPrefix = (root, epoch) => epoch ? `${root}/key-${epoch}` : root;

export function decodePasswordEpoch(bytes, previous) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 64 * 1024) fail();
  let value; try { value = JSON.parse(decoder.decode(bytes)); } catch { fail(); }
  if (!value || Object.keys(value).sort().join(',') !== 'format,next,previous,proof,version'
    || value.format !== 'covelet-password-epoch' || value.version !== 1 || value.previous !== previous
    || !identifier(value.next) || value.next === previous || typeof value.proof !== 'string' || !value.proof.length) fail();
  return value;
}

export async function createPasswordEpoch(previous, next, target, password, crypto = globalThis.crypto) {
  if (previous !== null && !identifier(previous) || !identifier(next) || next === previous) fail('CLOUD_INVALID');
  const proof = await encryptCloudPayload(encoder.encode(JSON.stringify({ format: 'covelet-password-proof', version: 1, target, previous, epoch: next })), password, { crypto });
  return encoder.encode(JSON.stringify({ format: 'covelet-password-epoch', version: 1, previous, next, proof: decoder.decode(proof) }));
}

// A create-once link is the commit point. Each generation has one successor,
// so even providers without mutable-object CAS can perform a fenced cutover.
// Intermediate links are routing only; the active proof authenticates the
// current password, target and complete generation identity.
export async function resolvePasswordEpoch({ root, providerAt, target, password, crypto = globalThis.crypto }) {
  let epoch = null, link = null;
  const seen = new Set();
  for (let depth = 0; depth <= 100; depth++) {
    const prefix = epochPrefix(root, epoch), provider = providerAt(prefix);
    if (!provider.readPasswordEpoch) {
      if (link) fail('CLOUD_EPOCH_UNSUPPORTED');
      return { epoch, prefix, provider, lineage: [...seen] };
    }
    const bytes = await provider.readPasswordEpoch();
    if (!bytes) {
      if (link) {
        let proof;
        try { proof = JSON.parse(decoder.decode(await decryptCloudPayload(encoder.encode(link.proof), password, { crypto }))); }
        catch { fail(); }
        if (JSON.stringify(Object.keys(proof).sort()) !== JSON.stringify(['epoch', 'format', 'previous', 'target', 'version'])
          || proof.format !== 'covelet-password-proof' || proof.version !== 1 || proof.target !== target
          || proof.epoch !== epoch || proof.previous !== link.previous) fail();
      }
      return { epoch, prefix, provider, lineage: [...seen] };
    }
    link = decodePasswordEpoch(bytes, epoch);
    if (seen.has(link.next)) fail();
    seen.add(link.next); epoch = link.next;
  }
  fail('CLOUD_CAPACITY');
}

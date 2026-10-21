// Deterministic encoder for the small, import-free scalar clock kernel.
// --write generates implementation assets; --check is a future packaging gate.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../', import.meta.url);
const binary = new URL('src/wasm/clock-core.wasm', root), metadata = new URL('wasm/clock-core/manifest.json', root);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const unsigned = (value) => { const bytes = []; do { let part = value & 127; value >>>= 7; if (value) part |= 128; bytes.push(part); } while (value); return bytes; };
const vector = (items) => [...unsigned(items.length), ...items.flat()];
const string = (value) => { const bytes = [...new TextEncoder().encode(value)]; return [...unsigned(bytes.length), ...bytes]; };
const section = (id, bytes) => [id, ...unsigned(bytes.length), ...bytes];
const local = (index) => [0x20, index];
const number = (value) => { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setFloat64(0, value, true); return [0x44, ...bytes]; };
const type = (count) => [0x60, ...unsigned(count), ...Array(count).fill(0x7c), 1, 0x7c];
const body = (ops) => { const bytes = [0, ...ops.flat(), 0x0b]; return [...unsigned(bytes.length), ...bytes]; };
function encode() {
  const definitions = [
    { name: 'elapsed', type: 0, ops: [local(0), local(1), 0xa1, number(0), 0xa5, local(3), 0xa2, local(2), 0xa0, number(0), 0xa5] },
    { name: 'remaining', type: 1, ops: [local(0), local(1), 0xa1, number(0), 0xa5] },
    { name: 'hour_angle', type: 2, ops: [local(0), number(30), 0xa2, local(1), number(.5), 0xa2, 0xa0, local(2), number(1 / 120), 0xa2, 0xa0] },
    { name: 'minute_angle', type: 1, ops: [local(0), number(6), 0xa2, local(1), number(.1), 0xa2, 0xa0] },
    { name: 'second_angle', type: 3, ops: [local(0), number(6), 0xa2] },
  ];
  return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0,
    ...section(1, vector([type(4), type(2), type(3), type(1)])),
    ...section(3, vector(definitions.map((item) => [item.type]))),
    ...section(7, vector(definitions.map((item, index) => [...string(item.name), 0, ...unsigned(index)]))),
    ...section(10, vector(definitions.map((item) => body(item.ops)))),
  ]);
}
const sourceHash = hash(await readFile(new URL('scripts/clock-wasm.mjs', root)));
if (process.argv[2] === '--write') {
  const bytes = encode();
  await mkdir(new URL('src/wasm/', root), { recursive: true });
  await mkdir(new URL('wasm/clock-core/', root), { recursive: true });
  await writeFile(binary, bytes);
  await writeFile(metadata, JSON.stringify({ abi: 1, bytes: bytes.length, sha256: hash(bytes), sourceHash, imports: [], memory: 0 }, null, 2) + '\n');
  console.log('Generated packaged clock kernel. No runtime checks executed.');
} else if (process.argv[2] === '--check') {
  const meta = JSON.parse(await readFile(metadata, 'utf8')), bytes = await readFile(binary);
  if (meta.sourceHash !== sourceHash || meta.sha256 !== hash(bytes) || !bytes.equals(Buffer.from(encode()))) throw Error('Clock kernel assets need regeneration.');
  console.log(`Clock WASM asset checksum matches: ${bytes.length} bytes.`);
} else throw Error('Use --write to generate assets or --check to compare their checksum.');

# GitHub calendar core

Bundled, import-free Rust WebAssembly. The browser host fetches and text-parses the selected user's public GitHub calendar. This module calculates totals, active days, longest/current streak and Sunday-first grid alignment; it neither fetches data nor renders remote content.

ABI 1 accepts up to 378 triples of UTC epoch day, count and GitHub level. Dates must be consecutive; counts are bounded at 1,000,000 per day and levels at 0–4 with consistent zero/nonzero counts. The fixed output has at most 392 cells and eight summary words. Memory is fixed at 512 KiB. Invalid input returns a nonzero status; the JS bridge checks the status and clears its buffers after each operation.

Build with pinned Rust 1.85.1 and wasm32-unknown-unknown:

```text
node scripts/build-github-wasm.mjs --rebuild
node scripts/build-github-wasm.mjs --check
```

The script uses the installed/cached compiler, never downloads tools or dependencies, and records source/binary SHA-256 in manifest.json. Ordinary builds verify the checked-in binary without requiring Rust. Runtime uses only the fixed packaged `src/wasm/github-core.wasm` URL.

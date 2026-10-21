# Packaged visual core

This dependency-free Rust module is compiled into `src/wasm/visual-core.wasm` and included in the extension's audited install package. It has no host imports, no allocator, no network, no local plugin upload, and a fixed 512 KiB linear memory (8 pages, growth prohibited). The worker owns one instance and executes calls sequentially.

## Build and verification

`node scripts/build-wasm.mjs --check` checks source and binary SHA-256, ABI exports, zero imports, the 32 KiB code budget and fixed memory. Ordinary builds need only Node and the checked-in binary. It never downloads executable code or build dependencies.

For a reproducible rebuild, install Rust 1.85.1 with the `wasm32-unknown-unknown` target, then run `node scripts/build-wasm.mjs --rebuild`. The compiler version and every flag are pinned in that script; `COVELET_RUSTC` can point directly to the pinned `rustc` executable when another Rust version is on PATH. The manifest intentionally records no timestamps or machine-specific paths. The local bootstrap used a separate toolchain cache without modifying the user's PATH. No third-party crates or runtime libraries are used.

`node scripts/build-wasm.mjs --generate` only compiles the packaged resource and writes its checksum manifest; it skips module inspection and verification. This mode was used on 2026-10-21 to implement the requested caption algorithm while honoring the instruction not to run tests/checks/app builds/browser QA. The generated binary is 9,471 bytes. Generation is not a passing validation result.

## ABI version 1

All dimensions and statuses are unsigned 32-bit integers. RGBA pixels are unpremultiplied 8-bit sRGB in row-major order. Write exactly `width * height * 4` input bytes before each call. Dimensions must each be 1..256; the JavaScript bridge must validate the byte length before writing. Neither function reads beyond the validated dimensions. WASM cannot distinguish previously written bytes from a short host write, so validating input length is part of the host contract.

Exports:

| Export | Meaning |
| --- | --- |
| `memory` | Fixed 524288-byte memory |
| `abi_version()` | `1` |
| `input_ptr()` | Byte address of a 262144-byte RGBA input buffer |
| `output_ptr()` | Byte address of a 65536-byte RGBA output buffer |
| `result_ptr()` | Byte address of 32 little-endian `u32` result words |
| `analyze_wallpaper(width, height)` | Analyze input pixels; return a status |
| `analyze_caption(width, height, previous, scale)` | Analyze glyph-weighted local contrast; height ≤ 64, previous 0/1/2 = none/dark/light, scale = pixels per CSS pixel × 100 in 10..200 |
| `normalize_icon(width, height)` | Produce 128×128 RGBA; return a status |

Statuses are `0` success, `1` invalid dimensions, `2` no nontransparent pixels. Results reset on every operation, including errors. The icon output is cleared before normalization, including errors. Only read operation-specific results after status `0`.

Result words:

| Index | Meaning |
| --- | --- |
| 0 | ABI version (`1`) |
| 1 | Status |
| 2 | Number of input pixels with alpha > 0 |
| 3 | Dominant RGB packed as `0xRRGGBB` (wallpaper) |
| 4 | Alpha-weighted mean RGB (wallpaper) |
| 5 | Alpha-weighted mean relative luminance, 0..10000 (wallpaper) |
| 6, 7, 8 | Alpha-weighted p10, p50, p90 relative luminance, 0..10000 (wallpaper) |
| 9, 10, 11 | Top three palette RGB colors, 0xRRGGBB; absent slots are zero |
| 12, 13, 14 | Corresponding alpha weights, 0..10000, relative to all visible input pixels |
| 15, 16, 17, 18 | Visible alpha bounding box: left, top, width, height (icon) |
| 19 | Whether output pixels/dimensions differ from input: 0 or 1 (icon) |
| 20 | Caption only: selected ink, 1 dark or 2 light |
| 21 | Caption only: support level, 0 none, 1 small shadow, 2 shadow plus thin opposite-ink stroke |
| 22, 23 | Caption only: coverage at 4.5:1 and fraction below 3:1, 0..10000 |
| 24 | Caption only: weighted contrast deficit below 4.5:1, scaled by 1000 |
| 25 | Caption only: nearby luminance-edge detail, 0..10000 |
| 26..31 | Reserved; always zero |

Luminance uses the standard linear-sRGB coefficients (0.2126, 0.7152, 0.0722) and a fixed 256-entry sRGB transfer lookup table. Percentiles use a bounded 256-bin luminance histogram, so their precision is approximately 1/255. Palette extraction counts fixed 3-bit-per-channel RGB buckets, weighted by alpha; each palette color is the actual weighted average of its bucket, preserving the sampled color rather than the bucket center. Ties are resolved by ascending bucket index.

The 2026-10-21 caption revision adds `analyze_caption` to ABI 1 while retaining the existing operations. Input RGB is the composited local wallpaper, with alpha replaced by the actual glyph mask. It compares black/white contrast over the full glyph footprint and its weakest occupied horizontal slice, severe low-contrast pixels and luminance edges at approximately one/two CSS pixels. Narrow hysteresis retains close choices. The host applies a small text shadow for mixed imagery and a 0.7px opposite-ink text stroke only for high-risk detail. Caption result words 5 and 20..25 are populated; wallpaper palette/percentile words are not populated by this operation.

The host samples bounded 256×64 patches at up to 2× device-pixel density, after actual cover cropping, blur and shade. Local wallpaper detail is capped at 2048px per edge, with at most two wallpaper samples cached. Separate budgets allow 64 visible captions/controls and 48 icon surfaces; only the newest queued frame is retained. Icon surfaces reuse `analyze_wallpaper` for their local color and never recolor the image itself. There is no full-viewport transfer or additional image request. Sampled photograph contrast is not a claim of WCAG conformance. The resource was regenerated, but no tests, checks, application builds or browser validation were run.

The later widget-surface revision adds a separate budget of 48 visible clock/GitHub surfaces (160 regions in total), each still at most 256×64. It reuses `analyze_wallpaper` for local mean color/luminance and derives a translucent surface plus matching UI colors in the packaged worker, with explicit theme polarity and a narrow tie band. The clock dial has no fixed white desktop disk; image assets are not recolored. Derived styles are local, restore on disable/failure, and never enter sync/backups. This revision did not change Rust, ABI or binary, regenerate resources, or run tests/checks/builds/browser QA.

Icon normalization crops only alpha=0 borders; opaque white/background pixels are retained. The visible bounding box is fitted without changing aspect ratio into a 102×102 area centered on a transparent 128×128 canvas. The longest content edge is exactly 102 pixels, with small aspect ratios clamped to a minimum one pixel. Downsampling uses weighted area filtering; upsampling uses bilinear filtering. Both accumulate premultiplied alpha and then unpremultiply, so hidden RGB values in transparent source pixels cannot create color fringes. No recoloring, background removal or brand substitution occurs. The renderer may bypass normalized padding for complete app artwork and adapt a separate background surface, respecting manual colors.

Run `node --test src/lib/visual-core.test.js` for real binary tests and bounded performance diagnostics. Browser/image decoding, worker integration and real extension CSP acceptance are separate validation layers.

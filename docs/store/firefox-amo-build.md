# Firefox AMO source and build instructions — Covelet 0.7.0

These instructions accompany the source archive submitted with the Firefox package. Use the exact source commit recorded in that submission's receipt. The already published `v0.7.0` tag and its Chrome/Edge package are not moved or overwritten by Firefox submission preparation.

## Build the submitted extension

Use Node.js 22 LTS and its bundled npm on Linux or Windows. The project requires Node.js 22 or newer; the submission workflow records its actual tool versions. JavaScript dependencies are resolved by `app/package-lock.json` (lockfile version 3), including WXT 0.21.4, Vite 6.4.2, React 19.2.0 and esbuild 0.25.12. Do not replace `npm ci` with an unlocked dependency update.

From the root of the attached source archive:

```sh
cd app
npm ci
npm run build:firefox
```

The normal command performs the packaged WASM checks, runs WXT's Firefox MV3 build, checks the extension, and creates:

- `app/dist/extension-firefox/`: the complete unsigned extension directory.
- `app/dist/covelet-0.7.0-firefox.zip`: its distributable archive.

`app/dist/extension-firefox/manifest.json` is generated from `app/extension.manifest.json` through `app/scripts/extension-target.mjs` and `app/wxt.config.ts`. It has Gecko ID `covelet@morleyzhou.github.io`; Firefox compatibility comes from that generated manifest. No browser installation, API key, account, cloud service or interactive configuration is needed to build. `npm ci` needs access to the locked npm registry packages. Application runtime requests and build dependency downloads are separate.

Use the normal build command above rather than `--unpacked` or `--skip-checks`: those are development/packaging shortcuts that omit checks. Compare the files in the generated directory with the unsigned package submitted to AMO, before Mozilla adds its signatures. Archive container metadata is separate from the extension's file bytes. Mozilla requires reviewable source and a reproducible build for bundled/minified code; this archive includes the original JS/JSX, Rust sources, dependency locks and build scripts. See [Mozilla source-code submission instructions](https://extensionworkshop.com/documentation/publish/source-code-submission/).

## Firefox data consent and offline review

The Firefox submission is built from the fixed `main` source SHA recorded in its receipt, including Firefox consent handling. It is separate from the previously published `v0.7.0` Chrome/Edge package; neither that tag nor those packages are replaced.

The generated Firefox manifest declares no required data collection and six optional types: `searchTerms`, `browsingActivity`, `websiteContent`, `authenticationInfo`, `personallyIdentifyingInfo`, and `technicalAndInteraction`. Privacy Checkup exposes explicit purpose buttons for web search, websites/reading/RSS, configured storage sync, public GitHub contributions, and online wallpaper. The first new-tab page provides an entry when no types are granted. Buttons call the browser's native request directly from a user gesture; opening the page or checkup does not request consent. Firefox authorizes data types shared by several purposes; individual host permissions are still separate. Revocation is available in `about:addons` → Covelet → Permissions.

Declining or revoking consent keeps local navigation, text notes and manual backup available and stops corresponding new requests. Technical and interaction data is used only for extension settings explicitly synchronized to user-selected storage, never telemetry or usage analytics. Sync and RSS retain their own opt-in configuration; granting a data type does not enable either feature.

Folio note images require special handling because native `<img>` loads bypass JavaScript `fetch`. Until reading consent is present, an editor-local DOM serializer and reader renderer emit placeholders before first mount instead of remote image `src` attributes. They preserve the original image attributes in the document, allow local text editing, and use plain-text paste. Granting consent renders the original images; revocation unmounts them. Chrome/Edge rendering is unchanged. This implementation does not edit or save a sanitized replacement of the user's note. Local cached article images remain click-only and independently origin-authorized.

The in-repository consent UI regression uses the actual Folio editor and reader and intercepts both native `img.src` assignments and `setAttribute('src', ...)`: initial load, insertion and preview assign no HTTP(S) image source before consent, and granting/revoking consent does not delete stored image attributes. Native browser acceptance and any authenticated provider checks are recorded separately from these component tests.

## Checked-in WebAssembly and complete regeneration

Routine extension builds **do not compile Rust**. They check the source/binary digests and the build configuration recorded in `app/wasm/*/manifest.json`, then package the checked-in binaries. The Firefox static checker additionally verifies that exactly four reviewed WASM binaries are shipped and that they have no host imports. This is not a claim that a new Rust rebuild was executed during metadata preparation.

| Shipped module | Source and recipe relative to `app/` | Binary bytes | SHA-256 |
| --- | --- | ---: | --- |
| `visual-core` | `wasm/visual-core/src/lib.rs`, `scripts/build-wasm.mjs` | 10,853 | `2eacea134baf76134678c3f3901e835798034a6bfcc4f30e007080896ca99f57` |
| `sync-core` | `wasm/sync-core/src/lib.rs`, `scripts/build-sync-wasm.mjs` | 10,773 | `45f0445669c48ae5326b624b77aaebb1b5ba792a6a54be382e3fee82c1830182` |
| `github-core` | `wasm/github-core/src/lib.rs`, `scripts/build-github-wasm.mjs` | 1,202 | `d4202ce71ab19aa9956d8c7cfd98f10ac521921fe1c4640e13d871c35eabc67b` |
| `tools-core` | `wasm/tools-core/src/lib.rs`, `scripts/build-tools-wasm.mjs` | 7,600 | `f7633e7189c3b33c70f632e84ea0489e0100564ae8c614c32074d6d9427b9149` |

The compiler is Rust **1.85.1**, exact identification `rustc 1.85.1 (4eb161250 2025-03-15)`, target `wasm32-unknown-unknown`, Rust edition 2021. Compiler/linker flags and fixed memory sizes are specified in each script and manifest. Visual, GitHub and tools use direct `rustc` compilation and have no third-party Rust crates. Sync uses locked Cargo dependencies: `sha2 = 0.10.9`, `hmac = 0.12.1`, and the complete registry checksums in `app/wasm/sync-core/Cargo.lock` (lock version 4). Retain `app/wasm/sync-core/LICENSES.txt` and the copied `app/public/SYNC_WASM_LICENSES.txt`.

To regenerate all Rust resources in a separate source copy, first install the pinned toolchain and populate Cargo's dependency cache, then run the offline build recipes. The setup commands need network access; the regeneration scripts themselves do not download tools or crates.

```sh
# From app/, with rustup available:
rustup toolchain install 1.85.1 --profile minimal --target wasm32-unknown-unknown
export COVELET_RUSTC="$(rustup which --toolchain 1.85.1 rustc)"
"$COVELET_RUSTC" --version
cargo +1.85.1 fetch --locked --manifest-path wasm/sync-core/Cargo.toml --target wasm32-unknown-unknown

node scripts/build-wasm.mjs --rebuild
node scripts/build-sync-wasm.mjs --rebuild
node scripts/build-github-wasm.mjs --rebuild
node scripts/build-tools-wasm.mjs --generate
node scripts/build-tools-wasm.mjs --check
npm run build:firefox
```

On PowerShell, set the compiler with `$env:COVELET_RUSTC = (& rustup which --toolchain 1.85.1 rustc)` and inspect it with `& $env:COVELET_RUSTC --version`; the remaining commands are the same. Preserve source line endings: `.gitattributes` pins digest-bearing Rust, Cargo and WASM build files to LF. Sync's script invokes Cargo with `--locked --offline`, selects the Cargo executable adjacent to the pinned compiler, and normalizes its checkout-path remapping in recorded metadata. An empty Cargo cache must be populated by the explicit `cargo fetch` step before this offline build.

Compare regenerated binary hashes to the submitted manifests and the table above. `--generate` only writes generated artifacts/metadata; it is not itself verification. `--rebuild` for visual, sync and GitHub also executes the corresponding checker. No `wasm-opt`, downloaded executable module, runtime compilation service or private Rust dependency is used.

The repository also retains `src/wasm/clock-core.wasm` and `scripts/clock-wasm.mjs` for retired-feature compatibility checks. The 253-byte clock binary is deterministically encoded by JavaScript, not Rust; `node scripts/clock-wasm.mjs --write` regenerates it and `--check` compares its bytes and source hash. It is **not shipped** in the Firefox extension. Keep it in the source archive because the normal packaging command still checks it.

## Source archive contents

The source archive must contain the matching commit's original directory layout: root `LICENSE` and `.gitattributes`; `app/package.json`, `app/package-lock.json`, `app/.npmrc`, `app/extension.manifest.json`, `app/wxt.config.ts`; and the full `app/entrypoints/`, `app/src/`, `app/public/`, `app/scripts/`, `app/wasm/` trees. Include this document and the submission metadata. The full tracked repository archive is suitable.

Keep the original Rust source, Cargo lock, byte manifests, packaged WASM files and third-party notices together. Exclude `.git`, `node_modules`, generated `dist`/`.wxt`, test output, local configurations, credentials and signing keys. The source upload is review material, not the installable XPI. Mozilla accepts a separate source archive and [multipart version-source upload](https://mozilla.github.io/addons-server/topics/api/addons.html#version-sources); it cannot be embedded as JSON during initial creation.

## Listing metadata and policy shape

`docs/store/firefox-amo.json` is the repository submission script's envelope, **not** a single AMO request body. `addon` contains listing fields, `version` contains version fields, and `policy` is sent to the separate policy endpoint. The upload's manifest supplies version `0.7.0`; no metadata field rewrites an existing version or release tag.

- `categories.firefox` contains the official extension category slugs `tabs` and `bookmarks`; `name`, `summary`, `description`, `homepage`, `support_email` and `support_url` use locale-to-string objects. The default is `en-US`; summaries cover all eight interface languages. Request URLs are plain strings per locale, not the API response's outgoing-link wrapper. See [AMO add-on fields](https://mozilla.github.io/addons-server/topics/api/addons.html#create), [translated fields](https://mozilla.github.io/addons-server/topics/api/overview.html#translated-fields), and Mozilla's [category constants](https://github.com/mozilla/addons-server/blob/master/src/olympia/constants/categories.py).
- `version.license` is the official slug `MIT`, matching the root license; it is not a top-level field or a response license object. `compatibility: ["firefox"]` inherits limits from the generated manifest and makes no Android claim. See [version creation](https://mozilla.github.io/addons-server/topics/api/addons.html#version-create) and [license choices](https://mozilla.github.io/addons-server/topics/api/licenses.html).
- `policy.privacy_policy` contains complete `en-US` and `zh-CN` text snapshots of the two articles in `site/privacy/index.html`, including optional network features and local-only exclusions. It is sent as `{ "privacy_policy": { "en-US": "...", "zh-CN": "..." } }` to `PATCH .../eula_policy/`. A privacy URL alone is not policy text. Refresh both snapshots when the hosted policy changes. See [Mozilla's policy endpoint](https://mozilla.github.io/addons-server/topics/api/addons.html#eula-and-privacy-policy-edit).

The current Mozilla [listing serializer](https://github.com/mozilla/addons-server/blob/master/src/olympia/addons/serializers.py) explicitly accepts localized `support_url`; its [category field](https://github.com/mozilla/addons-server/blob/master/src/olympia/addons/fields.py) accepts the documented Firefox category object as well as the newer flat form. Metadata contains no upload UUID, authentication secret, temporary path or fabricated privacy URL field. AMO credentials belong only to the `amo-addons` CI environment. An upload, signing result, listing review and public availability are separate outcomes recorded by the submission workflow.

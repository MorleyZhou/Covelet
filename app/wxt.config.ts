import { readFileSync } from "node:fs";
import path from 'node:path';
import react from "@vitejs/plugin-react";
import { defineConfig } from "wxt";
import dependencyReload from './scripts/vite-dependency-reload.mjs';
import { extensionManifest, extensionOutputDirectory } from './scripts/extension-target.mjs';

// One manifest baseline; WXT discovers new-tab, quick-add popup and background.
// Keep the regular Vite config separate for the web preview and Sites build.
const baseline = JSON.parse(
  readFileSync(new URL("./extension.manifest.json", import.meta.url), "utf8"),
);
const manifestVersion = baseline.manifest_version;
if (manifestVersion !== 3) throw new Error("Covelet requires Manifest V3.");

export default defineConfig({
  browser: "chrome",
  targetBrowsers: ["chrome", "firefox"],
  manifestVersion,
  imports: false,
  outDir: "dist",
  outDirTemplate: "extension{{modeSuffix}}",
  manifest: ({ browser }) => extensionManifest(baseline, browser),
  hooks: {
    'config:resolved'(wxt) {
      const directory = extensionOutputDirectory(wxt.config.browser, wxt.config.mode);
      // WXT 0.21.4's documented mutable config hook keeps direct Firefox CLI
      // builds separate as well as the npm wrappers. Chrome's path is unchanged.
      if (wxt.config.browser === 'firefox') {
        wxt.config.outDir = path.resolve(wxt.config.outBaseDir, directory);
      }
    },
  },
  // No runner dependency is installed; opening browsers is an explicit action.
  webExt: { enabled: false },
  vite: () => ({
    plugins: [react(), dependencyReload(), {
      name: "covelet:preserve-module-resource-urls",
      configResolved(config) {
        // WXT 0.21 replaces import.meta.url with self.location.href for its
        // background-script compatibility. All entries here are ESM, and that
        // replacement hides Worker/asset URLs from Vite. Keep
        // standard module URLs so the worker and its WASM are bundled locally.
        if (config.define) delete config.define["import.meta.url"];
      },
    }],
    worker: { format: "es", plugins: () => [] },
    build: { modulePreload: { polyfill: false }, sourcemap: false, assetsInlineLimit: 0 },
  }),
});

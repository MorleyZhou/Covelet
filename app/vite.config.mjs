import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import dependencyReload from './scripts/vite-dependency-reload.mjs';
import processingPdf from './scripts/vite-processing-pdf.mjs';

export default defineConfig({
  build: {
    outDir: "dist/client",
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
  },
  worker: { format: "es", plugins: () => [processingPdf()] },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    proxy: {
      // Preview only; production extensions use GitHub with exact-origin access.
      "^/__github/users/[A-Za-z0-9-]{1,39}/contributions$": {
        target: "https://github.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/__github/, ""),
        configure: (proxy) => {
          proxy.on("proxyReq", (request) => {
            request.removeHeader("cookie"); request.removeHeader("referer"); request.removeHeader("origin");
          });
          proxy.on("proxyRes", (response) => { delete response.headers["set-cookie"]; });
        },
      },
      // Preview only. The packaged extension uses its narrow Bing host permission.
      "^/__bing/(?:HPImageArchive\\.aspx|th)(?:\\?|$)": {
        target: "https://www.bing.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/__bing/, ""),
        configure: (proxy) => {
          proxy.on("proxyReq", (request) => {
            request.removeHeader("cookie");
            request.removeHeader("referer");
            request.removeHeader("origin");
          });
          proxy.on("proxyRes", (response) => {
            delete response.headers["set-cookie"];
          });
        },
      },
    },
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [processingPdf(), react(), dependencyReload()],
});

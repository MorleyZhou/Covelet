import { resolve } from 'node:path';
import { normalizePath } from 'vite';

// Updating npm dependencies while Vite is running must also replace its
// optimized modules. Source HMR alone otherwise keeps the old editor bundle.
export default function dependencyReload() {
  return {
    name: 'covelet:reload-installed-dependencies',
    apply: 'serve',
    configureServer(server) {
      const manifests = new Set(['package.json', 'package-lock.json'].map((name) => normalizePath(resolve(server.config.root, name))));
      let timer;
      const reload = (file) => {
        if (!manifests.has(normalizePath(file))) return;
        clearTimeout(timer);
        // npm writes both manifests near the end of installation. Coalesce
        // those writes rather than restarting against a half-written lockfile.
        timer = setTimeout(() => {
          timer = undefined;
          server.restart(true).catch((error) => server.config.logger.error(`Dependency reload failed: ${error.message}`));
        }, 600);
      };
      server.watcher.add([...manifests]);
      server.watcher.on('add', reload).on('change', reload);
      server.httpServer?.once('close', () => {
        clearTimeout(timer);
        server.watcher.off('add', reload).off('change', reload);
      });
    },
  };
}

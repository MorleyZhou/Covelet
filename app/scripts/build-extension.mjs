#!/usr/bin/env node
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const appRoot = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
);
const distRoot = path.resolve(appRoot, "dist");
const extensionRoot = path.resolve(distRoot, "extension");

// WXT clears its target output directory. Check the exact absolute scope and reject
// junctions/symlinks before allowing it to touch that directory on Windows.
if (path.relative(appRoot, extensionRoot) !== path.join("dist", "extension")) {
  throw new Error("Unsafe extension output directory.");
}
for (const candidate of [distRoot, extensionRoot, path.join(appRoot, ".wxt")]) {
  try {
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Output must be a real directory: ${candidate}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: appRoot,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (${result.status ?? result.signal ?? "unknown"}).`,
    );
  }
}

run(process.execPath, [path.join(appRoot, "scripts", "build-wasm.mjs"), "--check"]);
run(process.execPath, [path.join(appRoot, "scripts", "build-sync-wasm.mjs"), "--check"]);
run(process.execPath, [path.join(appRoot, "scripts", "build-github-wasm.mjs"), "--check"]);
run(process.execPath, [path.join(appRoot, "scripts", "clock-wasm.mjs"), "--check"]);
run(process.execPath, [path.join(appRoot, "scripts", "build-tools-wasm.mjs"), "--check"]);
run(process.execPath, [
  path.join(appRoot, "node_modules", "wxt", "bin", "wxt.mjs"),
  "build",
  "--browser",
  "chrome",
  "--mv3",
]);
run(process.execPath, [path.join(appRoot, "scripts", "check-extension.mjs")]);

const files = Object.create(null);
function collect(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true }).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const absolute = path.join(directory, item.name);
    if (item.isSymbolicLink())
      throw new Error(`Cannot package symlink: ${absolute}`);
    if (item.isDirectory()) {
      collect(absolute);
    } else if (item.isFile()) {
      const relative = path
        .relative(extensionRoot, absolute)
        .split(path.sep)
        .join("/");
      if (relative.startsWith("../") || path.isAbsolute(relative))
        throw new Error("Invalid ZIP path.");
      files[relative] = new Uint8Array(readFileSync(absolute));
    } else {
      throw new Error(`Unsupported output entry: ${absolute}`);
    }
  }
}
collect(extensionRoot);
const manifest = JSON.parse(
  readFileSync(path.join(extensionRoot, "manifest.json"), "utf8"),
);
const archive = path.join(distRoot, `covelet-${manifest.version}.zip`);
try {
  const stat = lstatSync(archive);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error(`Archive target must be a regular file: ${archive}`);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
mkdirSync(distRoot, { recursive: true });
writeFileSync(archive, zipSync(files, { level: 6 }));
console.log(`Extension directory: ${extensionRoot}`);
console.log(`Extension ZIP: ${archive} (${Object.keys(files).length} files)`);
console.log(
  "Build and static checks only; Chrome runtime acceptance and Web Store review remain separate.",
);

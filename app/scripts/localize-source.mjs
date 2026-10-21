// Source extraction/migration only; this does not build or execute the app.
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), { parse } = require('@babel/parser');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), sourceRoot = resolve(root, 'src');
const mode = process.argv[2];
if (!['--extract', '--write', '--catalog'].includes(mode)) throw Error('Use --extract, --write or --catalog.');
if (mode === '--catalog') {
  const locales = ['en', 'zh-TW', 'ja', 'ko', 'de', 'fr', 'ru'], catalog = Object.create(null);
  for (const file of ['errors.en.txt', 'folio.en.txt', 'folio.phrases.txt', 'phrases.txt']) {
    const lines = (await readFile(resolve(sourceRoot, 'i18n', file), 'utf8')).split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim() || line.startsWith('#')) continue;
      const [key, ...values] = line.split('|').map((value) => value.trim());
      if (values.length !== (file.endsWith('phrases.txt') ? 7 : 1) || !values[0]) throw Error(`Invalid translation source row: ${key}`);
      catalog[key] = Object.fromEntries(locales.slice(0, values.length).map((locale, index) => [locale, values[index]]));
    }
  }
  const inventory = JSON.parse(await readFile(resolve(root, 'scripts/i18n-source.json'), 'utf8'));
  const missing = inventory.filter((entry) => !catalog[entry.key]?.en).map((entry) => entry.key);
  if (missing.length) throw Error(`Add English source translations before generating:\n${missing.join('\n')}`);
  await writeFile(resolve(sourceRoot, 'i18n/catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'de', 'fr', 'ru']) {
    const directory = resolve(root, 'public/_locales', locale.replace('-', '_'));
    await mkdir(directory, { recursive: true });
    const read = (key) => locale === 'zh-CN' ? key : catalog[key][locale] || catalog[key].en;
    await writeFile(resolve(directory, 'messages.json'), `${JSON.stringify({
      extensionName: { message: 'Covelet' },
      extensionDescription: { message: locale === 'zh-CN' ? '私密新标签页，提供网站导航、搜索、外观、小组件、浏览器同步与 Bing 每日壁纸。' : read('扩展简介') },
      actionTitle: { message: read('添加到 Covelet') },
    }, null, 2)}\n`);
  }
  console.log('Generated packaged message catalogs and Chrome locale resources. No app was built or executed.');
  process.exit(0);
}
const han = /[\p{Script=Han}]/u, catalog = new Map();
const uiLibraries = new Set(['extensions.js', 'widget-model.js', 'revision-diff.js', 'search.js', 'background-colors.js', 'use-icon-drag.js', 'use-layout-edit.js']);
const errorCalls = new Set(['Error', 'TypeError', 'RangeError', 'DOMException', 'fail', 'failure', 'ownError', 'fault', 'error', 'notification', 'bytes', 'text', 'title', 'name', 'keys', 'object', 'identifier', 'integer', 'number', 'newRecord']);
const ignoredProperties = new Set(['start', 'end', 'loc', 'extra', 'comments', 'leadingComments', 'trailingComments', 'innerComments', 'tokens']);
const quote = (value) => JSON.stringify(value);
async function filesAt(dir) {
  const result = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, item.name);
    if (item.isDirectory() && !['i18n', 'assets', 'wasm'].includes(item.name)) result.push(...await filesAt(path));
    else if (item.isFile() && /\.(?:js|jsx)$/.test(item.name) && !/\.test\./.test(item.name)) result.push(path);
  }
  return result;
}
function jsxText(value) {
  const lines = value.replaceAll('\t', ' ').split(/\r\n|\n|\r/), last = lines.findLastIndex((line) => /[^ ]/.test(line));
  return lines.map((line, index) => {
    let text = index ? line.trimStart() : line;
    if (index !== lines.length - 1) text = text.trimEnd();
    return text && index < last ? `${text} ` : text;
  }).join('');
}
for (const path of await filesAt(sourceRoot)) {
  const original = await readFile(path, 'utf8'), filename = path.split(/[\\/]/).at(-1), jsx = /\.jsx$/.test(path);
  if (!han.test(original)) continue;
  const ast = parse(original, { sourceType: 'module', plugins: ['jsx', 'importAttributes'] });
  const source = (node) => original.slice(node.start, node.end);
  const apply = (node, edits) => {
    let value = source(node);
    for (const edit of [...edits].sort((a, b) => b.start - a.start)) value = value.slice(0, edit.start - node.start) + edit.value + value.slice(edit.end - node.start);
    return value;
  };
  function message(value) {
    const key = value.trim();
    if (!catalog.has(key)) catalog.set(key, { key, files: new Set(), ui: false });
    const entry = catalog.get(key); entry.files.add(relative(root, path).replaceAll('\\', '/')); if (jsx || uiLibraries.has(filename)) entry.ui = true;
    return value;
  }
  function visit(node, ancestors = []) {
    if (!node || typeof node.type !== 'string') return [];
    const parent = ancestors.at(-1), property = ancestors.findLast((item) => item.type === 'ObjectProperty');
    const inFunction = ancestors.some((item) => /Function|Method/.test(item.type));
    const inTranslation = ancestors.some((item) => item.type === 'CallExpression' && item.callee?.name === 'tr');
    if (inTranslation) return [];
    if (property?.key?.name === 'keywords') return [];
    const children = [];
    for (const [key, value] of Object.entries(node)) {
      if (ignoredProperties.has(key)) continue;
      if (Array.isArray(value)) { for (const item of value) if (item?.type) children.push(...visit(item, [...ancestors, node])); }
      else if (value?.type) children.push(...visit(value, [...ancestors, node]));
    }
    const make = (value) => [{ start: node.start, end: node.end, value }];
    if (node.type === 'StringLiteral' && ['zh-CN', 'en'].includes(node.value) && (jsx || filename === 'personal-tools.js')
      && ['CallExpression', 'NewExpression'].includes(parent?.type) && parent.arguments[0] === node
      && (['toLocaleDateString', 'toLocaleTimeString', 'toLocaleString', 'localeCompare'].includes(parent.callee?.property?.name)
        || parent.callee?.object?.name === 'Intl')) return make('getLocale()');
    const literal = node.type === 'StringLiteral' && han.test(node.value);
    const template = node.type === 'TemplateLiteral' && node.quasis.some((part) => han.test(part.value.cooked || part.value.raw));
    const call = ancestors.findLast((item) => ['CallExpression', 'NewExpression'].includes(item.type));
    const error = errorCalls.has(call?.callee?.name) || ['message', 'error', 'blockedError'].includes(property?.key?.name)
      || ancestors.some((item) => item.type === 'VariableDeclarator' && item.id?.name === 'messages')
      || parent?.type === 'VariableDeclarator' && /message/i.test(parent.id?.name || '')
      || parent?.type === 'AssignmentPattern' || uiLibraries.has(filename);
    const excluded = parent?.key === node || parent?.type === 'BinaryExpression' || parent?.type === 'RegExpLiteral';
    if (literal && !excluded && (jsx || error)) {
      message(node.value);
      const value = `tr(${quote(node.value)})`;
      if (parent?.type === 'JSXAttribute') return make(`{${value}}`);
      return make(value);
    }
    if (template && !excluded && (jsx || error) && parent?.type !== 'TaggedTemplateExpression') {
      const key = node.quasis.map((part, index) => `${part.value.cooked ?? part.value.raw}${index < node.expressions.length ? `{${index}}` : ''}`).join(''); message(key);
      const args = node.expressions.map((expression) => apply(expression, children.filter((edit) => edit.start >= expression.start && edit.end <= expression.end)));
      return make(`tr(${quote(key)}, [${args.join(', ')}])`);
    }
    if (node.type === 'JSXText' && han.test(node.value)) {
      const value = jsxText(node.value); message(value); return make(`{tr(${quote(value)})}`);
    }
    // Catalog constants must respond to language changes without mutating data.
    if (node.type === 'ObjectProperty' && !inFunction && children.length && (jsx || uiLibraries.has(filename) || ancestors.some((item) => item.type === 'VariableDeclarator' && item.id?.name === 'messages'))
      && node.value.type === 'StringLiteral' && han.test(node.value.value) && !node.computed) return make(`get ${source(node.key)}() { return ${apply(node.value, children)}; }`);
    // Only known message/status fields are translated at display time. User
    // names, URLs, notes, snapshots and imported text are never run through tr.
    if (jsx && node.type === 'JSXExpressionContainer' && node.expression.type !== 'JSXEmptyExpression') {
      const expression = node.expression;
      const trusted = expression.type === 'Identifier' && /^(?:error|loadError|feedback|description|metadata|dialogError)$/.test(expression.name)
        || expression.type === 'MemberExpression' && !expression.computed && expression.property.name === 'message';
      if (trusted) return make(`{tr(${apply(expression, children)})}`);
    }
    return children;
  }
  const edits = visit(ast);
  if (mode === '--write' && edits.length) {
    let value = apply(ast.program, edits);
    const prefix = relative(dirname(path), resolve(sourceRoot, 'i18n/index.js')).replaceAll('\\', '/');
    if (!/import\s*\{[^}]*\btr\b[^}]*\}\s*from\s*['"][^'"]*i18n\/index\.js['"]/.test(original)) value = `import { tr, getLocale } from ${quote(prefix.startsWith('.') ? prefix : `./${prefix}`)};\n${value}`;
    await writeFile(path, value);
  }
}
if (mode === '--extract') {
  // Preserve the initial inventory after calls have been migrated to tr().
  const previous = JSON.parse(await readFile(resolve(root, 'scripts/i18n-source.json'), 'utf8').catch(() => '[]'));
  const combined = new Map(previous.map((item) => [item.key, item]));
  for (const item of catalog.values()) combined.set(item.key, { key: item.key, ui: item.ui, files: [...item.files] });
  const entries = [...combined.values()].sort((a, b) => Number(b.ui) - Number(a.ui) || a.key.localeCompare(b.key, 'zh-CN'));
  await writeFile(resolve(root, 'scripts/i18n-source.json'), `${JSON.stringify(entries, null, 2)}\n`);
  console.log(`Extracted ${entries.length} source messages (${entries.filter((item) => item.ui).length} UI). No app code was executed.`);
} else console.log('Rewrote localized source phrases. No tests, checks or app build were run.');

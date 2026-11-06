import { createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { decryptCloudPayload } from '../../src/lib/cloud-crypto.js';
import { configure, fillSecret, settings, sync, withLiveSession } from './live-session.mjs';
import { createNote, exportCompleteBackup, imageDigest, makeImagePNG, revealDesktopItem, uploadedSiteImage } from '../playwright/backup-helpers.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pathOf = path => path.split('/').map(encodeURIComponent).join('/');
const oid = /^[0-9a-f]{40}$/;

function githubFixture(config, token) {
  const { owner, repo, branch, prefix } = config;
  if (!/^covelet-qa\/[0-9]{17}-[0-9a-f]{8}$/.test(branch)) throw Error('Expected a dedicated GitHub QA branch');
  const base = 'https://api.github.com/repos/' + pathOf(owner + '/' + repo);
  const sentinel = prefix + '/preserve.txt';
  const legacy = prefix + '/all-data-v1';
  const active = prefix + '/all-data-v2';
  async function request(path, { write, raw = false } = {}) {
    return fetch(base + '/' + path, {
      method: write ? 'PUT' : 'GET',
      headers: { authorization: 'Bearer ' + token, accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        ...(write && { 'content-type': 'application/json' }) },
      body: write ? JSON.stringify({ message: 'Covelet synthetic sync cleanup QA', branch, content: Buffer.from(write).toString('base64') }) : undefined,
      redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
  }
  async function tree(ref) {
    const response = await request('git/trees/' + encodeURIComponent(ref) + '?recursive=1');
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.truncated).toBe(false);
    return result.tree.filter(file => file.type === 'blob' && file.path.startsWith(prefix + '/'))
      .sort((a, b) => a.path.localeCompare(b.path));
  }
  return {
    sentinel, legacy, active, tree,
    async head() {
      const response = await request('branches/' + encodeURIComponent(branch));
      expect(response.status).toBe(200);
      const id = (await response.json()).commit.sha;
      expect(id).toMatch(oid);
      return id;
    },
    async writeSentinel() {
      const response = await request('contents/' + pathOf(sentinel), { write: 'unrelated synthetic QA file' });
      expect(response.status).toBe(201);
    },
    async tryLegacyWrite() {
      const response = await request('contents/' + pathOf(legacy + '/old-client.json'), { write: 'synthetic stale writer' });
      expect(response.status).toBe(409);
    },
    async raw(path, ref) {
      const response = await request('contents/' + pathOf(path) + '?ref=' + encodeURIComponent(ref), { raw: true });
      expect(response.status).toBe(200);
      return Buffer.from(await response.arrayBuffer());
    },
  };
}

async function verifySnapshot(github, commit, password) {
  const files = await github.tree(commit);
  const prefix = github.active + '/';
  const indexes = files.filter(file => file.path.startsWith(prefix) && !file.path.slice(prefix.length).includes('/'));
  expect(indexes).toHaveLength(1);
  const index = indexes[0].path;
  const indexName = index.slice(prefix.length);
  const seal = await github.raw(github.legacy, commit);
  expect(seal.toString()).toContain(indexName);
  const rawIndex = await github.raw(index, commit);
  expect(hash(rawIndex)).toBe(indexName.slice(-69, -5));
  const header = JSON.parse(Buffer.from(await decryptCloudPayload(rawIndex, password)).toString());
  const used = new Set();
  async function readReference(reference) {
    const parts = [];
    for (const chunk of reference.chunks) {
      const path = prefix + 'blobs/' + chunk.name;
      used.add(path);
      const encrypted = await github.raw(path, commit);
      expect(hash(encrypted)).toBe(chunk.name.slice(-69, -5));
      const plain = Buffer.from(await decryptCloudPayload(encrypted, password));
      expect(plain.length).toBe(chunk.size);
      expect(hash(plain)).toBe(chunk.hash);
      parts.push(plain);
    }
    const bytes = Buffer.concat(parts);
    expect(bytes.length).toBe(reference.size);
    expect(hash(bytes)).toBe(reference.digest);
    return bytes;
  }
  const document = JSON.parse((await readReference(header.document)).toString());
  for (const operation of Object.values(document.records)) if (operation.value) await readReference(operation.value);
  expect(files.map(file => file.path).sort()).toEqual([github.sentinel, github.legacy, index, ...used].sort());
  return { files, indexName };
}

async function renameSite(page, oldName, newName) {
  const site = page.locator('.site-link').filter({ hasText: oldName });
  await revealDesktopItem(page, site);
  await site.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '编辑', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑网站', exact: true });
  await editor.getByLabel('名称', { exact: true }).fill(newName);
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).toBeHidden();
}

test('GitHub local choice restores exact bytes, resumes after a dropped branch update, and removes obsolete blocks', async () => {
  test.setTimeout(480_000);
  await withLiveSession('github', async ({ launch, config, token, runId, at, state, armCleanupDrop }) => {
    const github = githubFixture(config, token);
    const password = 'Covelet-cleanup-' + runId + '-password';
    const oldImage = makeImagePNG([245, 158, 11, 255]);
    const chosenImage = makeImagePNG([37, 99, 235, 255]);
    const a = await launch(), b = await launch();
    for (const page of [a.page, b.page]) page.setDefaultTimeout(25_000);
    at('seed isolated GitHub branch and two profiles');
    await github.writeSentinel();
    await uploadedSiteImage(a.page, { name: 'QA original', url: 'https://example.com/cleanup-original', image: oldImage });
    at('upload the original image from profile A');
    await configure(a.page, 'github', config, token, password);
    at('restore the original image in profile B');
    await configure(b.page, 'github', config, token, password, { adoptInitialCloud: true });
    at('edit both profiles independently');
    await renameSite(a.page, 'QA original', 'QA losing side');
    await renameSite(b.page, 'QA original', 'QA chosen side');
    await uploadedSiteImage(b.page, { name: 'QA chosen image', url: 'https://example.com/cleanup-chosen', image: chosenImage });
    await createNote(b.page, { title: 'QA chosen note', body: 'restore this exact synthetic note' });
    at('publish profile A and detect profile B conflict');
    await sync(a.page);
    await sync(b.page, { conflict: true });

    const before = await github.head();
    const oldFiles = await github.tree(before);
    const oldChunks = oldFiles.filter(file => file.path.startsWith(github.legacy + '/blobs/'));
    expect(oldChunks.length).toBeGreaterThan(0);
    expect(oldFiles.some(file => file.path.startsWith(github.active + '/'))).toBe(false);
    const sentinelSha = oldFiles.find(file => file.path === github.sentinel)?.sha;
    expect(sentinelSha).toMatch(oid);

    at('drop the exact-head update after detached snapshot upload and validation');
    const conflict = await settings(b.page);
    const choose = conflict.getByRole('button', { name: '以本地为准', exact: true });
    await expect(choose).toBeEnabled();
    armCleanupDrop();
    await choose.click();
    await expect.poll(() => state.cleanup.dropped, { timeout: 120_000 }).toBe(true);
    const first = state.cleanup.attempts[0];
    expect(first.exactTestBranch).toBe(true);
    expect(first.before).toBe(before);
    expect(first.after).toMatch(oid);
    expect(first.after).not.toBe(first.before);

    at('close Chromium and verify interruption preserves all old branch files');
    await b.context.close(); b.context = null;
    expect(await github.head()).toBe(before);
    expect(await github.tree(before)).toEqual(oldFiles);
    const staged = await verifySnapshot(github, first.after, password);

    at('restart the same profile and unlock to resume without reselecting');
    const restarted = await launch(b.path);
    restarted.page.setDefaultTimeout(25_000);
    const locked = await settings(restarted.page);
    await expect(locked).toContainText('同步已锁定');
    await expect(locked.getByLabel('GitHub 访问令牌', { exact: true })).toHaveCount(0);
    await fillSecret(locked, '同步密码', password);
    await locked.getByRole('button', { name: '解锁', exact: true }).click();
    await expect.poll(() => state.cleanup.attempts.length, { timeout: 120_000 }).toBe(2);
    const resumed = state.cleanup.attempts[1];
    expect(resumed.exactTestBranch).toBe(true);
    expect(resumed.before).toBe(before);
    expect(resumed.after).toBe(first.after);
    await expect.poll(() => github.head(), { timeout: 60_000 }).toBe(resumed.after);
    await expect(locked.getByRole('button', { name: '立即同步', exact: true })).toBeEnabled({ timeout: 90_000 });

    at('check exact active files, old writer rejection, and independent profile restoration');
    const active = await verifySnapshot(github, resumed.after, password);
    expect(active.indexName).toBe(staged.indexName);
    expect(active.files.map(file => [file.path, file.sha])).toEqual(staged.files.map(file => [file.path, file.sha]));
    expect(active.files.find(file => file.path === github.sentinel).sha).toBe(sentinelSha);
    expect(active.files.some(file => file.path.startsWith(github.legacy + '/'))).toBe(false);
    await github.tryLegacyWrite();
    expect(await github.head()).toBe(resumed.after);

    const fresh = await launch();
    fresh.page.setDefaultTimeout(25_000);
    await configure(fresh.page, 'github', config, token, password, { adoptInitialCloud: true });
    const restored = await exportCompleteBackup(fresh.page);
    expect(restored.siteImages.map(item => [item.name, item.sha256]).sort()).toEqual([
      ['QA chosen image', imageDigest(chosenImage)], ['QA chosen side', imageDigest(oldImage)],
    ]);
    expect(restored.tools.notes.map(note => [note.title, note.body])).toEqual([['QA chosen note', 'restore this exact synthetic note']]);
    expect(await github.head()).toBe(resumed.after);
    console.log(JSON.stringify({ oldIndexesAndChunks: oldFiles.length - 1, activeFiles: active.files.length - 1,
      interruptedBeforeBranchUpdate: true, restoredImageCount: restored.siteImages.length, resumedAttempts: state.cleanup.attempts.length }));
  });
});

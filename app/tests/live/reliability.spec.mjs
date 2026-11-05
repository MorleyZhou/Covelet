import { test, expect } from '@playwright/test';
import { zlibSync } from 'fflate';
import { withLiveSession, LIVE_TEST_PROVIDERS, configure, sync, unlock } from './live-session.mjs';
import { uploadedSiteImage, createNote, exportCompleteBackup, revealDesktopItem, imageDigest } from '../playwright/backup-helpers.mjs';

// A deterministic, decodable PNG larger than one 256 KiB sync chunk.
// This exercises real multi-chunk image transfer without external artwork.
function largeImage(seed) {
  const width = 320, height = 320, raw = Buffer.alloc(height * (1 + width * 4));
  let random = seed;
  for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
    const offset = row * (1 + width * 4) + 1 + column * 4;
    for (let channel = 0; channel < 3; channel++) {
      random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
      raw[offset + channel] = random & 255;
    }
    raw[offset + 3] = 255;
  }
  const chunk = (type, bytes) => {
    const body = Buffer.concat([Buffer.from(type), bytes]), output = Buffer.alloc(bytes.length + 12);
    output.writeUInt32BE(bytes.length); body.copy(output, 4);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
    }
    output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
    return output;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', Buffer.from(zlibSync(raw))), chunk('IEND', Buffer.alloc(0))]);
  expect(png.length).toBeGreaterThan(256 * 1024);
  return png;
}

async function capture(page) {
  const backup = await exportCompleteBackup(page);
  const recovery = page.getByRole('dialog', { name: '备份与恢复中心', exact: true });
  await expect(recovery.getByRole('button', { name: '导出完整备份', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape'); await expect(recovery).toBeHidden();
  return backup;
}
function content(backup) {
  return {
    images: backup.siteImages.map(image => ({ id: image.id, name: image.name, sha256: image.sha256, bytes: image.bytes.length, mime: image.mime })).sort((a, b) => a.id.localeCompare(b.id)),
    notes: backup.tools.notes.map(({ id, title, body, document, pinned }) => ({ id, title, body, document, pinned })).sort((a, b) => a.id.localeCompare(b.id)),
  };
}
async function renameSite(page, from, to) {
  const item = page.locator('.site-link').filter({ hasText: from });
  await revealDesktopItem(page, item); await item.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '编辑', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑网站', exact: true });
  await dialog.getByLabel('名称', { exact: true }).fill(to);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toBeHidden();
}

for (const provider of LIVE_TEST_PROVIDERS) {
  test(`${provider}: closeout / image bytes / offline retry / committed timeout and restart`, async () => {
    test.setTimeout(720_000);
    await withLiveSession(provider, async ({ launch, config, token, runId, at, state, armCommitDrop }) => {
      let a = await launch();
      const b = await launch(), password = `Covelet-closeout-${runId}-password`;
      const first = largeImage(0x3ac57291), second = largeImage(0x62fa1903);
      at('prepare real image and note through UI');
      await uploadedSiteImage(a.page, { name: 'QA image A', url: 'https://example.com/qa-image-a', image: first });
      await createNote(a.page, { title: 'QA sync note', body: 'QA NOTE BEFORE OFFLINE — retained across restart' });
      const original = await capture(a.page);
      expect(original.siteImages[0].sha256).toBe(imageDigest(first));
      at('first real-cloud image transfer');
      await configure(a.page, provider, config, token, password);
      await configure(b.page, provider, config, token, password);
      expect(content(await capture(b.page))).toEqual(content(original));

      at('offline local edit and readable failure');
      await a.context.setOffline(true);
      await renameSite(a.page, 'QA image A', 'QA image offline edit');
      const offline = await sync(a.page, { failure: /网络|连接|离线|请求|超时/ });
      expect(offline.message).not.toMatch(/TypeError|fetch failed|PRIVATE|SYNTHETIC-TOKEN/);
      const retained = await capture(a.page);
      expect(retained.siteImages[0].name).toBe('QA image offline edit');
      expect(retained.siteImages[0].sha256).toBe(imageDigest(first));
      expect(content(retained).notes).toEqual(content(original).notes);
      await a.context.setOffline(false);
      at('retry after reconnect');
      await sync(a.page); await sync(b.page);
      expect(content(await capture(b.page))).toEqual(content(retained));

      at('add another image and lose a committed chunk response');
      await uploadedSiteImage(a.page, { name: 'QA image B', url: 'https://example.com/qa-image-b', image: second });
      const beforeFailure = await capture(a.page);
      armCommitDrop();
      const lost = await sync(a.page, { failure: /网络|连接|请求|超时/ });
      expect(state.lostWrite.used).toBe(true);
      expect(state.lostWrite.fetchFailed).toBe(false);
      expect(state.lostWrite.status).toBeGreaterThanOrEqual(200);
      expect(state.lostWrite.status).toBeLessThan(300);
      expect(state.lostWrite.attempts).toBe(1);
      expect(lost.pending).not.toContain('待同步：0 项');
      expect(content(await capture(a.page))).toEqual(content(beforeFailure));

      at('restart with pending ciphertext and re-enter session credentials');
      const path = a.path; await a.context.close(); a.context = null;
      a = await launch(path);
      expect(content(await capture(a.page))).toEqual(content(beforeFailure));
      await unlock(a.page, provider, config, token, password);
      at('reconcile committed chunk and complete pending upload');
      await sync(a.page); await sync(b.page);
      expect(state.lostWrite.attempts).toBe(1);
      await expect.poll(() => state.lostWrite.reconciledRead).toBe(true);
      const aFinal = await capture(a.page), bFinal = await capture(b.page);
      expect(content(aFinal)).toEqual(content(beforeFailure));
      expect(content(bFinal)).toEqual(content(beforeFailure));
      expect(bFinal.siteImages.map(image => image.sha256).sort()).toEqual([imageDigest(first), imageDigest(second)].sort());
      const writes = state.writes;
      at('unchanged repeat after restart has no new writes');
      await sync(a.page); await sync(b.page);
      expect(state.writes).toBe(writes);
    });
  });
}

import { test, expect } from '@playwright/test';
import { withLiveSession, LIVE_TEST_PROVIDERS, settings, configure, chooseCloud, sync, addSite, rename, unlock } from './live-session.mjs';

for (const provider of LIVE_TEST_PROVIDERS) {
  test(`${provider}: real service / two isolated extension profiles / bidirectional and repeated sync`, async () => {
    await withLiveSession(provider, async ({ launch, config, token, runId, at, state }) => {
      const a = await launch(), b = await launch(), password = `Covelet-live-${runId}-password`;
      await addSite(a.page, 'QA from profile A');
      at('profile A first sync');
      await configure(a.page, provider, config, token, password);
      at('profile B first sync');
      await configure(b.page, provider, config, token, password, { adoptInitialCloud: true });
      at('bidirectional edits');
      await sync(a.page); await sync(b.page);
      await expect(b.page.locator('.site-name')).toHaveText('QA from profile A');
      await rename(b.page, 'QA from profile B'); await sync(b.page); await sync(a.page);
      await expect(a.page.locator('.site-name')).toHaveText('QA from profile B');
      const beforeRepeat = state.writes;
      at('repeat without new writes');
      await sync(a.page); await sync(b.page);
      await expect(b.page.locator('.site-name')).toHaveText('QA from profile B');
      expect(state.writes).toBe(beforeRepeat);
      // Both profiles edit the same entire navigation record before syncing.
      // A shortcut added only by B must disappear if B explicitly adopts A.
      await rename(a.page, 'QA chosen A'); await rename(b.page, 'QA retained B');
      await addSite(b.page, 'QA B-only shortcut', 'covelet-qa-b-only');
      at('publish concurrent A'); await sync(a.page);
      at('detect concurrent B'); await sync(b.page, { conflict: true });
      await expect(b.page.locator('.site-name')).toHaveText(['QA retained B', 'QA B-only shortcut']);
      const conflicts = await settings(b.page);
      at('choose the entire cloud snapshot');
      await chooseCloud(conflicts);
      await expect(b.page.getByRole('alertdialog')).toHaveCount(0);
      await expect(conflicts.getByRole('button', { name: '立即同步', exact: true })).toBeEnabled();
      await b.page.keyboard.press('Escape'); await expect(conflicts).toHaveCount(0);
      await sync(a.page);
      await expect(a.page.locator('.site-name')).toHaveText('QA chosen A');
      await expect(b.page.locator('.site-name')).toHaveText('QA chosen A');
      // Browser restart must keep records while clearing session credentials.
      at('restart and unlock');
      await a.context.close(); a.context = null;
      const restarted = await launch(a.path);
      await expect(restarted.page.locator('.site-name')).toHaveText('QA chosen A');
      await unlock(restarted.page, provider, password);
      await sync(restarted.page);
      await expect(restarted.page.locator('.site-name')).toHaveText('QA chosen A');
    });
  });
}

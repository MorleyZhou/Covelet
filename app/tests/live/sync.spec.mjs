import { test, expect } from '@playwright/test';
import { withLiveSession, providerNames, LIVE_TEST_PROVIDERS, settings, configure, sync, addSite, rename, fillSecret } from './live-session.mjs';

for (const provider of LIVE_TEST_PROVIDERS) {
  test(`${provider}: real service / two isolated extension profiles / bidirectional and repeated sync`, async () => {
    await withLiveSession(provider, async ({ launch, config, token, runId, at, state }) => {
      const a = await launch(), b = await launch(), password = `Covelet-live-${runId}-password`;
      await addSite(a.page, 'QA from profile A');
      at('profile A first sync');
      await configure(a.page, provider, config, token, password);
      at('profile B first sync');
      await configure(b.page, provider, config, token, password);
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
      at('publish concurrent B'); await sync(b.page);
      await expect(b.page.locator('.site-name')).toHaveText(['QA retained B', 'QA B-only shortcut']);
      const conflicts = await settings(b.page);
      at('choose one whole record');
      await conflicts.getByRole('button', { name: '查看并选择版本', exact: true }).first().click();
      const choice = b.page.getByRole('alertdialog', { name: '选择保留的版本', exact: true });
      await expect(choice.locator('.prompt-dialog-actions button').last()).toBeDisabled();
      await choice.locator('.cloud-conflict-sides').getByRole('button', { name: '采用云端版本', exact: true }).click();
      await choice.locator('.prompt-dialog-actions').getByRole('button', { name: '采用云端版本', exact: true }).click();
      await expect(choice).toBeHidden();
      await expect(conflicts.getByRole('button', { name: '立即同步', exact: true })).toBeEnabled();
      await b.page.keyboard.press('Escape'); await expect(conflicts).toHaveCount(0);
      await sync(b.page); await sync(a.page);
      await expect(a.page.locator('.site-name')).toHaveText('QA chosen A');
      await expect(b.page.locator('.site-name')).toHaveText('QA chosen A');
      // Browser restart must keep records while clearing session credentials.
      at('restart and unlock');
      await a.context.close(); a.context = null;
      const restarted = await launch(a.path);
      await expect(restarted.page.locator('.site-name')).toHaveText('QA chosen A');
      const locked = await settings(restarted.page);
      await expect(locked).toContainText('需解锁');
      const credentialNames = ['github', 'gitlab'].includes(provider) ? [`${providerNames[provider]} 访问令牌`] : ['Access Key ID', 'Secret Access Key'];
      for (const name of [...credentialNames, '同步密码']) {
        expect((await locked.getByLabel(name, { exact: true }).inputValue()) === '', `${name} must be empty after browser restart`).toBe(true);
      }
      if (['github', 'gitlab'].includes(provider)) await fillSecret(locked, credentialNames[0], token);
      else {
        await fillSecret(locked, 'Access Key ID', config.accessKeyId); await fillSecret(locked, 'Secret Access Key', config.secretAccessKey);
        if (config.sessionToken) {
          await locked.getByRole('button', { name: '临时安全令牌', exact: true }).click();
          await fillSecret(locked, '临时安全令牌', config.sessionToken);
        }
      }
      await fillSecret(locked, '同步密码', password);
      await locked.getByRole('button', { name: '解锁', exact: true }).click();
      await expect(locked).toContainText('已解锁'); await expect(restarted.page.getByRole('alertdialog')).toHaveCount(0);
      await expect(locked.getByRole('button', { name: '立即同步', exact: true })).toBeEnabled();
      await restarted.page.keyboard.press('Escape'); await expect(locked).toHaveCount(0);
      await sync(restarted.page);
      await expect(restarted.page.locator('.site-name')).toHaveText('QA chosen A');
    });
  });
}

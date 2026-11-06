import { test, expect } from './extension.fixture.mjs';
import { makeImagePNG } from './backup-helpers.mjs';

test.use({ pregrantedHosts: ['https://upload.wikimedia.org/*'] });

async function mockBing(context, requests) {
  const bingImages = [1, 2].map(number => ({ startdate: '20261106', enddate: '20261107',
    url: `/th?id=OHR.Fixture${number}_1920x1080.jpg`, copyright: `Bing fixture ${number}`, title: `Fixture ${number}`,
    copyrightlink: 'https://www.bing.com/search?q=Covelet' }));
  await context.route(/^https:\/\/www\.bing\.com\/(?:HPImageArchive\.aspx|th)\?/, async route => {
    const url = new URL(route.request().url());
    requests.push(url);
    if (url.pathname === '/HPImageArchive.aspx') return route.fulfill({ json: { images: bingImages } });
    return route.fulfill({ contentType: 'image/png', body: makeImagePNG() });
  });
}

async function openWallpaper(page) {
  await page.getByRole('button', { name: '打开扩展', exact: true }).click();
  await page.locator('#extension-random-wallpaper').click();
  return page.getByRole('dialog', { name: '随机壁纸', exact: true });
}

test('the Random Wallpaper extension applies and shuffles either source, then can be turned off', async ({ extension }) => {
  const requests = [];
  await mockBing(extension.context, requests);
  await extension.context.route('https://upload.wikimedia.org/**', async route => {
    requests.push(new URL(route.request().url()));
    return route.fulfill({ contentType: 'image/png', body: makeImagePNG([34, 197, 94, 255]) });
  });
  const page = await extension.newtab();
  const background = () => page.locator('.wallpaper').evaluate(node => getComputedStyle(node).backgroundImage);
  await expect.poll(background).toContain('alpine-lake');
  let dialog = await openWallpaper(page);
  expect(requests).toHaveLength(0);
  await dialog.getByRole('button', { name: '设为背景', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('已更换壁纸。');
  await expect.poll(background).toContain('blob:');
  await dialog.getByRole('button', { name: '换一张', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('已更换壁纸。');
  expect(new Set(requests.filter(url => url.pathname === '/th').map(url => url.href)).size).toBe(2);

  await dialog.getByRole('combobox', { name: '壁纸源', exact: true }).click();
  await page.getByRole('option', { name: 'Wikimedia Commons', exact: true }).click();
  await dialog.getByRole('button', { name: '设为背景', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('已更换壁纸。');
  await expect(dialog.locator('figcaption a')).toHaveAttribute('href', /^https:\/\/commons\.wikimedia\.org\//);
  await dialog.getByRole('button', { name: '换一张', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('已更换壁纸。');
  expect(new Set(requests.filter(url => url.hostname === 'upload.wikimedia.org').map(url => url.href)).size).toBe(2);

  const beforeReload = requests.length;
  await page.reload();
  await expect.poll(background).toContain('blob:');
  dialog = await openWallpaper(page);
  await expect(dialog.getByRole('combobox', { name: '壁纸源', exact: true })).toHaveText('Wikimedia Commons');
  expect(requests).toHaveLength(beforeReload);
  await dialog.getByRole('button', { name: '关闭随机壁纸', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('已关闭随机壁纸。');
  await expect.poll(background).toContain('alpine-lake');
});

test('the saved wallpaper cadence changes the image at the deadline and stops after disabling', async ({ extension }) => {
  const requests = [];
  await mockBing(extension.context, requests);
  const page = await extension.newtab();
  await page.clock.install({ time: new Date('2026-11-06T12:00:00+08:00') });
  let dialog = await openWallpaper(page);
  const interval = () => dialog.getByRole('combobox', { name: '自动更换间隔', exact: true });
  await expect(interval()).toHaveText('1天');
  await interval().click();
  await expect(page.getByRole('option')).toHaveText(['5分钟', '10分钟', '15分钟', '30分钟', '1小时', '3小时', '6小时', '12小时', '1天', '3天', '5天', '10天', '15天', '1个月']);
  await page.getByRole('option', { name: '5分钟', exact: true }).click();
  await expect(interval()).toHaveText('5分钟');
  expect(requests).toHaveLength(0);

  await dialog.getByRole('button', { name: '设为背景', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('已更换壁纸。');
  const credit = () => dialog.locator('figcaption a');
  await expect(credit()).toContainText('Bing fixture');
  const first = await credit().textContent();
  await page.clock.fastForward('04:00');
  expect(requests).toHaveLength(2);
  await page.clock.fastForward('01:00');
  await expect(credit()).not.toHaveText(first);
  expect(new Set(requests.filter(url => url.pathname === '/th').map(url => url.href)).size).toBe(2);

  await page.reload();
  dialog = await openWallpaper(page);
  await expect(interval()).toHaveText('5分钟');
  expect(requests).toHaveLength(4);
  await dialog.getByRole('button', { name: '关闭随机壁纸', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('已关闭随机壁纸。');
  await page.clock.fastForward('06:00');
  expect(requests).toHaveLength(4);
});

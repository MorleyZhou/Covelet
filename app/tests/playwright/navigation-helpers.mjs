import { expect } from './extension.fixture.mjs';

export const visibleGrid = page => page.locator('.desktop-page[aria-hidden="false"] .desktop-grid');
export const tileNamed = (page, name) => page.locator('.site-tile').filter({ has: page.getByText(name, { exact: true }) });
export const desktopNames = page => visibleGrid(page).locator(':scope > .site-tile .site-name');

export async function editSiteThroughKeyboard(page, name) {
  const link = tileNamed(page, name).locator('.site-link');
  await link.focus();
  await link.press('Shift+F10');
  await expect(page.getByRole('menu', { name: '网站操作', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: '编辑', exact: true }).press('Enter');
  const dialog = page.getByRole('dialog', { name: '编辑网站', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function enterLayout(page, name) {
  const link = tileNamed(page, name).locator('.site-link');
  await link.focus();
  await link.press('Shift+F10');
  await page.getByRole('menuitem', { name: '编辑布局', exact: true }).press('Enter');
  await expect(page.getByRole('toolbar', { name: '编辑布局', exact: true })).toBeVisible();
  await expect(page.locator('.owntab')).toHaveClass(/layout-editing/);
}

// Use real mouse/pointer input. Do not synthesize drag events or write app state.
export async function pointerDrag(page, source, target, expectedLabel) {
  await expect(source).toBeVisible();
  await expect(target).toBeVisible();
  const from = await source.boundingBox(), to = await target.boundingBox();
  expect(from).not.toBeNull(); expect(to).not.toBeNull();
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const end = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  let released = false;
  try {
    await page.mouse.move(start.x + 12, start.y + 3, { steps: 3 });
    await expect(page.locator('.icon-drag-ghost')).toBeVisible();
    await page.mouse.move(end.x, end.y, { steps: 16 });
    await expect(page.locator('.drag-target-label')).toHaveText(expectedLabel);
    await page.mouse.up(); released = true;
    await expect(page.locator('.icon-drag-ghost')).toHaveCount(0);
  } finally { if (!released) await page.mouse.up(); }
}

export async function gridPosition(tile) {
  return { row: await tile.getAttribute('data-grid-row'), column: await tile.getAttribute('data-grid-column') };
}
export async function expectPosition(tile, position) {
  await expect(tile).toHaveAttribute('data-grid-row', position.row);
  await expect(tile).toHaveAttribute('data-grid-column', position.column);
}

export async function saveNavigationScreenshot(page, testInfo, name) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

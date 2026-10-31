import assert from 'node:assert/strict';

// Exercise the system theme through Chromium, without changing saved settings.
export async function polishScreens({ evaluate, send, delay, writeFile, output }, name, selector, scrollSelector) {
  for (const theme of ['light', 'dark']) for (const width of [1100, 390]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: width === 390 ? 844 : 850, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    await evaluate(`document.querySelector(${JSON.stringify(scrollSelector)}).scrollTop = 0`);
    await delay(120);
    assert.equal(await evaluate(`(() => { const root = document.querySelector(${JSON.stringify(selector)}), box = root.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1 && root.scrollWidth <= root.clientWidth + 1; })()`), true, `${name}: ${theme}, ${width}px fits viewport`);
    const data = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(`${output}/${name}-${theme}-${width}.png`, Buffer.from(data.data, 'base64'));
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 850, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
}

export async function keyboardDisclosure({ evaluate, send, delay }, title) {
  await evaluate(`(() => { const button = [...document.querySelectorAll('.ui-disclosure-trigger')].find(button => button.textContent.trim() === ${JSON.stringify(title)}); if (!button) throw Error('Missing disclosure'); button.focus(); })()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  await delay(100);
  assert.equal(await evaluate(`document.activeElement.textContent.trim() === ${JSON.stringify(title)} && document.activeElement.getAttribute('aria-expanded') === 'true'`), true, 'Space expands the named disclosure and retains focus');
}

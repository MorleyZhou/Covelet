// Existing domain assertions use the Simplified Chinese source messages.
// Pin the test browser language independently of the developer/CI OS locale.
Object.defineProperty(globalThis.navigator, 'languages', { configurable: true, value: ['zh-CN'] });
Object.defineProperty(globalThis.navigator, 'language', { configurable: true, value: 'zh-CN' });

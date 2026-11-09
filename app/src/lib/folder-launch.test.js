import test from 'node:test';
import assert from 'node:assert/strict';
import { folderLaunchSites, launchFolderSites, MAX_FOLDER_LAUNCH } from './folder-launch.js';

test('folder launch lists visible HTTP(S) sites in display order without duplicates', () => {
  const site = (id, order, url, parentId = 'folder') => ({ id, order, url, parentId, name: id, type: 'site' });
  const entries = [
    { id: 'folder', type: 'folder' },
    site('later', 10, 'https://example.com/next'),
    site('first', 2, 'HTTP://EXAMPLE.COM:80/'),
    site('duplicate', 3, 'http://example.com/'),
    site('hidden', 1, 'https://example.org/'),
    site('invalid', 6, 'https://a b/'),
    site('file', 4, 'file:///example'),
    site('implicit', 5, 'example.com'),
    site('other-folder', 0, 'https://example.net/', 'another'),
  ];
  assert.deepEqual(folderLaunchSites(entries, 'folder', new Set(['site:hidden'])), [
    { id: 'first', name: 'first', url: 'http://example.com/' },
    { id: 'later', name: 'later', url: 'https://example.com/next' },
  ]);
  assert.deepEqual(folderLaunchSites(entries, 'folder', new Set(['folder:folder'])), []);
  assert.deepEqual(folderLaunchSites(entries, 'missing'), []);
});

test('folder launch creates at most ten tabs, in order, and reports entries that did not open', async () => {
  const choices = Array.from({ length: MAX_FOLDER_LAUNCH + 1 }, (_, index) => ({
    id: String(index), url: `https://example.com/${index}`,
  }));
  const attempted = [];
  const result = await launchFolderSites(choices, async ({ url, active }) => {
    assert.equal(active, false);
    attempted.push(url);
    if (url.endsWith('/1')) throw Error('Tab creation failed');
  }, ({ id }) => id !== '2');
  assert.deepEqual(attempted, choices.slice(0, 10).filter(({ id }) => id !== '2').map(({ url }) => url));
  assert.deepEqual(result, { opened: ['0', '3', '4', '5', '6', '7', '8', '9'], failed: ['1', '2'] });
});

import test from "node:test";
import assert from "node:assert/strict";
import { submitWebSearch } from "./search.js";
test("default search sends raw text to browser, without provider navigation", async () => {
  const calls = [];
  await submitWebSearch("中文 & a=b", "browser", [], {
    api: { search: { query: async (info) => calls.push(info) } },
    navigate: () => assert.fail("no URL fallback"),
  });
  assert.deepEqual(calls, [{ text: "中文 & a=b", disposition: "CURRENT_TAB" }]);
});
test("API errors and missing API never trigger a provider fallback", async () => {
  await assert.rejects(
    submitWebSearch("hello", "browser", [], {
      api: {
        search: {
          query: async (info) => {
            assert.equal(info.disposition, "NEW_TAB");
            throw Error("rejected");
          },
        },
      },
      newTab: true,
      navigate: () => assert.fail(),
    }),
    /rejected/,
  );
  await assert.rejects(
    submitWebSearch("hello", "browser", [], {
      api: {},
      navigate: () => assert.fail(),
    }),
    /扩展/,
  );
});
test("explicit additional provider encodes parameters", async () => {
  let result;
  await submitWebSearch(
    "a&b=你好",
    "extra",
    [{ id: "extra", template: "https://example.com/search?q={query}" }],
    {
      navigate: (url) => (result = url),
      api: { search: { query: () => assert.fail() } },
    },
  );
  const url = new URL(result);
  assert.equal(url.hostname, "example.com");
  assert.equal(url.searchParams.get("q"), "a&b=你好");
  assert.equal([...url.searchParams].length, 1);
});

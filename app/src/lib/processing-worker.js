import { regexResult } from './processing-apps.js';
self.onmessage = (event) => {
  try { const { text, expression, flags, replacement } = event.data; self.postMessage({ result: regexResult(text, expression, flags, replacement) }); }
  catch (error) { self.postMessage({ error: error.message }); }
};

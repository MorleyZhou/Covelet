import { tr } from '../i18n/index.js';
import { readAppResponse } from './app-network.js';

export function safeContentURL(input, base) {
  try { const url = new URL(input, base); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; }
}
export function feedText(value, max = 12000) {
  const template = document.createElement('template');
  template.innerHTML = String(value).slice(0, 200000);
  template.content.querySelectorAll('script,style,iframe,object,embed').forEach((node) => node.remove());
  return (template.content.textContent || '').replace(/\s+/g, ' ').trim().slice(0, max);
}
export function parseFeed(text, source) {
  if (typeof text !== 'string' || text.length > 4000000 || /<!DOCTYPE|<!ENTITY/i.test(text)) throw Error(tr('订阅内容格式无效。'));
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw Error(tr('无法解析 RSS 或 Atom 订阅。'));
  const nodes = [...doc.getElementsByTagName('*')].filter((node) => ['entry', 'item'].includes(node.localName)).slice(0, 250);
  if (!['rss', 'feed', 'RDF'].includes(doc.documentElement.localName) && !nodes.length) throw Error(tr('此地址不是 RSS 或 Atom 订阅。'));
  const child = (node, names) => [...node.children].find((item) => names.includes(item.localName));
  return nodes.map((node) => {
    const links = [...node.children].filter((item) => item.localName === 'link');
    const link = links.find((item) => !item.getAttribute('rel') || item.getAttribute('rel') === 'alternate') || links[0];
    const url = safeContentURL(link?.getAttribute('href') || link?.textContent || '', source.url);
    const identity = child(node, ['guid', 'id'])?.textContent?.trim() || url;
    const published = child(node, ['published', 'updated', 'pubDate', 'date'])?.textContent;
    return { id: `${source.id}:${identity}`.slice(0, 2000), sourceId: source.id, title: child(node, ['title'])?.textContent?.trim().slice(0, 500) || url,
      url, summary: feedText(child(node, ['description', 'summary', 'content', 'encoded'])?.textContent || ''), publishedAt: Number.isFinite(Date.parse(published)) ? new Date(published).toISOString() : '', read: false, starred: false };
  }).filter((item) => item.url && item.title);
}
export function releaseItems(value, source) {
  if (!Array.isArray(value)) throw Error(tr('项目发布数据格式无效。'));
  return value.slice(0, 100).filter((item) => !item.draft && item.id && safeContentURL(item.html_url)).map((item) => ({
    id: `${source.id}:${item.id}`, sourceId: source.id, title: String(item.name || item.tag_name || '').slice(0, 500), url: item.html_url,
    summary: String(item.body || '').slice(0, 12000), publishedAt: item.published_at || '', read: false, starred: false,
  }));
}
export function mergeFeedItems(existing, incoming) {
  const old = new Map(existing.map((item) => [item.id, item]));
  for (const item of incoming) old.set(item.id, { ...item, read: old.get(item.id)?.read || false, starred: old.get(item.id)?.starred || false });
  return [...old.values()].sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0)).slice(0, 2000);
}
export function aiEndpoint(config, operation = 'chat') {
  const base = new URL(config.baseUrl), path = base.pathname.replace(/\/$/, '');
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw Error(tr('模型服务地址无效。'));
  base.pathname = config.provider === 'ollama' ? `${path.replace(/\/api$/, '')}/api/${operation === 'models' ? 'tags' : 'chat'}`
    : `${path || '/v1'}/${operation === 'models' ? 'models' : 'chat/completions'}`;
  return base.href;
}
export function parseModelList(value, provider) {
  const rows = provider === 'ollama' ? value.models : value.data;
  if (!Array.isArray(rows)) throw Error(tr('无法读取模型列表。'));
  return [...new Set(rows.map((item) => item.name || item.id).filter((name) => typeof name === 'string' && name.length < 300))].slice(0, 1000);
}
export function streamContent(line, provider) {
  const source = provider === 'ollama' ? line : line.replace(/^data:\s*/, '');
  if (!source.trim() || source === '[DONE]' || source.startsWith(':') || /^(event|id|retry):/.test(source)) return '';
  let value; try { value = JSON.parse(source); } catch { throw Error(tr('模型返回的流式数据无效。')); }
  if (value.error) throw Error(typeof value.error === 'string' ? value.error.slice(0, 500) : tr('模型生成失败。'));
  return provider === 'ollama' ? value.message?.content || '' : value.choices?.[0]?.delta?.content || value.choices?.[0]?.message?.content || '';
}
export async function readChatStream(response, provider, onContent) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json') && !contentType.includes('ndjson')) {
    const text = await readAppResponse(response, 2000000);
    const value = JSON.parse(text); if (value.error) throw Error(tr('模型生成失败。'));
    const content = provider === 'ollama' ? value.message?.content : value.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw Error(tr('模型回复格式无效。')); onContent(content); return content;
  }
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', content = '', size = 0;
  const consume = (line) => { const part = streamContent(line.trim(), provider); if (typeof part !== 'string') throw Error(tr('模型回复格式无效。')); content += part; if (content.length > 1000000) throw Error(tr('模型回复超过大小限制。')); if (part) onContent(content); };
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 4 * 1024 * 1024) throw Error(tr('模型回复超过大小限制。'));
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 512000) throw Error(tr('模型回复超过大小限制。'));
      const lines = buffer.split(/\r?\n/); buffer = lines.pop(); lines.forEach(consume);
    }
    buffer += decoder.decode(); if (buffer.trim()) consume(buffer);
    return content;
  } finally { await reader.cancel().catch(() => {}); }
}

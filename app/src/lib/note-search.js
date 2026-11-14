// Transient search projections only. These helpers do not edit a Folio document,
// DOM nodes, browser selection, persisted records or editor history.
const normalize = (value) => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
const DEFAULT_LIMIT = 1000;
let segmenter;

export function noteSearchTerms(query) {
  const values = Array.isArray(query) ? query : typeof query === 'string' ? [query] : [];
  if (values.some((value) => typeof value !== 'string') || values.reduce((sum, value) => sum + value.length, 0) > 2000) return [];
  const terms = [...new Set(values.flatMap((value) => normalize(value).split(' ')).filter(Boolean))];
  return terms.length <= 64 ? terms : [];
}

export function matchedNoteSearchTerms(text, query) {
  if (typeof text !== 'string') return [];
  const body = normalize(text);
  return noteSearchTerms(query).filter((term) => body.includes(term));
}

function graphemes(text) {
  if (typeof Intl.Segmenter === 'function') {
    segmenter ??= new Intl.Segmenter('und', { granularity: 'grapheme' });
    return segmenter.segment(text);
  }
  // Current supported Chromium has Segmenter. Keep canonical combining marks
  // together in older runtimes too, without splitting UTF-16 surrogate pairs.
  const result = [];
  let index = 0;
  for (const character of text) {
    if (/\p{M}/u.test(character) && result.length) result.at(-1).segment += character;
    else result.push({ segment: character, index });
    index += character.length;
  }
  return result;
}

function normalizedOffsets(text) {
  let canonical = '';
  const canonicalStarts = [], canonicalEnds = [];
  for (const part of graphemes(text)) {
    const value = part.segment.normalize('NFKC'), end = part.index + part.segment.length;
    canonical += value;
    for (let index = 0; index < value.length; index++) { canonicalStarts.push(part.index); canonicalEnds.push(end); }
  }
  // Lowercase the whole string so contextual casing (for example Greek final
  // sigma) matches the main content search. Length expansions still map back
  // to their original grapheme, such as U+0130 becoming i + combining dot.
  const lower = canonical.toLowerCase(), lowerStarts = [], lowerEnds = [];
  let offset = 0;
  for (const character of canonical) {
    const end = offset + character.length;
    for (let index = 0; index < character.toLowerCase().length; index++) {
      lowerStarts.push(canonicalStarts[offset]); lowerEnds.push(canonicalEnds[end - 1]);
    }
    offset = end;
  }
  if (lower.length !== lowerStarts.length) return { text: '', starts: [], ends: [] };
  const starts = [], ends = [], normalized = [];
  for (let index = 0; index < lower.length; index++) {
    if (/\s/u.test(lower[index])) {
      if (!normalized.length) continue;
      if (normalized.at(-1) === ' ') ends[ends.length - 1] = lowerEnds[index];
      else { normalized.push(' '); starts.push(lowerStarts[index]); ends.push(lowerEnds[index]); }
    } else { normalized.push(lower[index]); starts.push(lowerStarts[index]); ends.push(lowerEnds[index]); }
  }
  if (normalized.at(-1) === ' ') { normalized.pop(); starts.pop(); ends.pop(); }
  return { text: normalized.join(''), starts, ends };
}

export function findNoteMatches(text, query, { limit = DEFAULT_LIMIT } = {}) {
  const terms = noteSearchTerms(query), matches = [];
  if (typeof text !== 'string' || !text || !terms.length) return { matches, terms, truncated: false };
  if (!matchedNoteSearchTerms(text, terms).length) return { matches, terms, truncated: false };
  const maximum = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, DEFAULT_LIMIT) : DEFAULT_LIMIT;
  const projection = normalizedOffsets(text);
  const heads = terms.map((term) => ({ term, index: projection.text.indexOf(term) })).filter((head) => head.index >= 0);
  let truncated = false;
  // Merge a bounded stream instead of constructing every occurrence of every
  // term before showing the first result. All offsets are UTF-16 DOM offsets.
  while (heads.length) {
    let selected = 0;
    for (let index = 1; index < heads.length; index++) {
      const candidate = heads[index], before = heads[selected];
      const start = projection.starts[candidate.index], previousStart = projection.starts[before.index];
      if (start < previousStart || start === previousStart
        && projection.ends[candidate.index + candidate.term.length - 1] > projection.ends[before.index + before.term.length - 1]) selected = index;
    }
    const head = heads[selected], start = projection.starts[head.index], end = projection.ends[head.index + head.term.length - 1];
    const previous = matches.at(-1);
    if (previous && start < previous.end) previous.end = Math.max(previous.end, end);
    else {
      matches.push({ start, end, term: head.term });
      if (matches.length > maximum) { truncated = true; matches.pop(); break; }
    }
    head.index = projection.text.indexOf(head.term, head.index + head.term.length);
    if (head.index < 0) heads.splice(selected, 1);
  }
  return { matches, terms, truncated };
}

const ignored = 'script, style, button, input, textarea, select, [hidden], [inert], [aria-hidden="true"]';
const blockTags = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'PRE', 'BLOCKQUOTE', 'TD', 'TH']);

export function findRenderedNoteMatches(root, query, options) {
  const document = root?.ownerDocument;
  if (!document?.createTreeWalker || root.closest?.(ignored)) return { matches: [], terms: noteSearchTerms(query), truncated: false };
  const walker = document.createTreeWalker(root, 5, {
    acceptNode(node) { return node.nodeType === 1 && node.matches(ignored) ? 2 : 1; },
  });
  let node, text = '';
  const spans = [];
  while ((node = walker.nextNode())) {
    if (node.nodeType === 1) {
      if ((node.tagName === 'BR' || blockTags.has(node.tagName)) && text && !text.endsWith('\n')) text += '\n';
      continue;
    }
    if (node.nodeType !== 3 || !node.data) continue;
    spans.push({ node, start: text.length, end: text.length + node.data.length }); text += node.data;
  }
  const result = findNoteMatches(text, query, options);
  const matches = result.matches.flatMap((match) => {
    const first = spans.find((span) => span.start <= match.start && span.end > match.start);
    const last = spans.find((span) => span.start < match.end && span.end >= match.end);
    if (!first || !last) return [];
    const range = document.createRange();
    range.setStart(first.node, match.start - first.start); range.setEnd(last.node, match.end - last.start);
    return [{ ...match, range }];
  });
  return { ...result, matches };
}

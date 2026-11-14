import { useEffect, useMemo, useRef, useState } from 'react';
import { tr, formatNumber } from '../i18n/index.js';
import { getContentTags } from '../lib/content-preferences.js';
import { parseStructuredSearch, removeStructuredCondition } from '../lib/structured-search.js';
import { filterSavedContent } from '../lib/saved-views.js';
import { SAVED_VIEW_LIMITS } from '../lib/saved-views.js';
import { Input } from './ui/input.jsx';
import { Button } from './ui/button.jsx';
import './command-palette.css';

export function StructuredConditions({ parsed, onClear, onRemove }) {
  if (!parsed.structured && parsed.status === 'ready') return null;
  return <div className="structured-conditions" role="status">
    {parsed.status === 'invalid' ? <span className="form-error">{tr('搜索条件无效，请检查类型、标签或引号。')}</span>
      : parsed.conditions.map((condition, index) => <span className="query-condition" key={`${condition.key}:${index}`}>{condition.operator}: {condition.value}
        {onRemove && <Button type="button" variant="ghost" size="sm" aria-label={`${tr('移除条件')} ${condition.operator}: ${condition.value}`} onClick={() => onRemove(condition)}>×</Button>}</span>)}
    {onClear && <Button type="button" variant="ghost" size="sm" onClick={onClear}>{tr('清除条件')}</Button>}
  </div>;
}

export default function CommandPalette({ Dialog, navigation, tools, preferences, hiddenKeys, actions, onOpen, onSearch, onClose, today }) {
  const [query, setQuery] = useState(''), [selected, setSelected] = useState(0);
  const composing = useRef(false), list = useRef(null);
  const tags = getContentTags(preferences, { hiddenKeys });
  const parsed = useMemo(() => parseStructuredSearch(query, { tags }), [query, preferences, hiddenKeys]);
  const content = parsed.status === 'ready' ? filterSavedContent(navigation, tools, preferences, parsed.filters, { hiddenKeys, today }).rows : [];
  const terms = query.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
  const commands = parsed.status !== 'ready' || parsed.structured ? [] : actions.filter((action) => terms.every((word) => `${action.title} ${action.keywords || ''}`.normalize('NFKC').toLocaleLowerCase().includes(word)));
  const results = [...commands.map((action) => ({ key: `action:${action.id}`, title: action.title, group: tr('操作'), run: action.run })),
    ...content.slice(0, 24).map((item) => ({ key: item.key, title: item.title, subtitle: item.subtitle,
      group: tr('内容'), run: () => onOpen(item, parsed.textQuery) }))];
  const current = Math.min(selected, Math.max(0, results.length - 1));
  useEffect(() => { setSelected(0); }, [query]);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [current]);
  function run(index) { if (!composing.current && results[index]) { onClose(); results[index].run(); } }
  return <Dialog title={tr('命令面板')} className="command-palette-modal" onClose={onClose}>
    <div className="command-palette">
      <Input data-autofocus aria-label={tr('搜索内容或操作')} placeholder={tr('搜索内容或操作')} value={query} autoComplete="off" maxLength={SAVED_VIEW_LIMITS.query}
        role="combobox" aria-expanded={results.length > 0} aria-controls="command-results" aria-activedescendant={results[current] ? `command-${current}` : undefined}
        onChange={(event) => setQuery(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={(event) => {
          if (composing.current || event.nativeEvent.isComposing) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSelected((value) => (value + (event.key === 'ArrowDown' ? 1 : -1) + Math.max(1, results.length)) % Math.max(1, results.length)); }
          if (event.key === 'Enter') { event.preventDefault(); run(current); }
        }} />
      <StructuredConditions parsed={parsed} onClear={() => setQuery(parsed.status === 'ready' ? parsed.textQuery : '')} onRemove={(condition) => setQuery(removeStructuredCondition(query, condition))} />
      <div ref={list} id="command-results" className="command-results" role="listbox" aria-label={tr('搜索结果')}>
        {results.map((result, index) => <div key={result.key}>
          {(index === 0 || results[index - 1].group !== result.group) && <p className="command-group">{result.group}</p>}
          <Button type="button" variant="unstyled" size="unstyled" role="option" id={`command-${index}`} aria-selected={current === index}
            className="command-result" onMouseMove={() => setSelected(index)} onClick={() => run(index)}>
            <strong>{result.title}</strong>{result.subtitle && <small>{result.subtitle}</small>}
          </Button>
        </div>)}
      </div>
      <div className="command-footer"><span role="status">{tr('当前匹配 {0} 项', [formatNumber(results.length)])}</span>
        {parsed.status === 'ready' && query.trim() && <Button type="button" variant="ghost" onClick={() => { onClose(); onSearch(query); }}>{tr('在桌面中查看结果')}</Button>}
      </div>
    </div>
  </Dialog>;
}

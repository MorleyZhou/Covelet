import { useEffect, useState } from 'react';
import { loadPersonalTools, subscribePersonalTools } from './personal-tools.js';
import { loadToolsCore } from './tools-core.js';

export default function usePersonalTools({ loadCore = true } = {}) {
  const [data, setData] = useState(null), [core, setCore] = useState(null), [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const receive = (next) => { if (active) setData((current) => current?.revision > next.revision ? current : next); };
    const off = subscribePersonalTools(receive);
    Promise.all([loadPersonalTools(), loadCore ? loadToolsCore() : null]).then(([value, kernel]) => { receive(value); if (active) setCore(kernel); }).catch((reason) => { if (active) setError(reason.message); });
    return () => { active = false; off(); };
  }, [loadCore]);
  return { data, core, error };
}

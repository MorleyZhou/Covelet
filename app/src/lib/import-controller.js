import { tr } from '../i18n/index.js';
import { applyPreparedNavigationImport } from './storage.js';
import { prepareImportWithMetadata } from './import-plan.js';

const requestKeys = ['plan', 'options', 'expectedNavigationRevision', 'expectedPreferencesRevision'];
const optionKeys = ['selectedIndices', 'page', 'columns', 'skipDuplicates', 'targetFolderId', 'metadataChoices', 'includeMetadata'];
const plain = (value) => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const invalid = () => { throw Object.assign(Error(tr('导入计划无效或条目过多')), { code: 'IMPORT_PLAN_INVALID' }); };

// Only source rows and user decisions cross the UI boundary. Preview-created
// state, tag IDs and metadata are never accepted as a persistence payload.
export async function commitImportedPlan(request) {
  let held;
  try {
    if (!plain(request) || Object.keys(request).some((key) => !requestKeys.includes(key)) || !plain(request.plan)
      || !Array.isArray(request.plan.folders) || !Array.isArray(request.plan.sites)
      || request.options !== undefined && (!plain(request.options) || Object.keys(request.options).some((key) => !optionKeys.includes(key)))) invalid();
    const options = request.options || {};
    if (options.selectedIndices !== undefined && !Array.isArray(options.selectedIndices) && !(options.selectedIndices instanceof Set)
      || options.metadataChoices !== undefined && !plain(options.metadataChoices)) invalid();
    // Capture before waiting on navigation/preferences locks. A rerender or a
    // changed file cannot replace the source plan after confirmation starts.
    held = structuredClone({ plan: request.plan, options, expectedNavigationRevision: request.expectedNavigationRevision,
      expectedPreferencesRevision: request.expectedPreferencesRevision });
  } catch (reason) { if (reason?.code === 'IMPORT_PLAN_INVALID') throw reason; invalid(); }
  return applyPreparedNavigationImport({ expectedNavigationRevision: held.expectedNavigationRevision, expectedPreferencesRevision: held.expectedPreferencesRevision },
    (navigation, preferences) => prepareImportWithMetadata(navigation, preferences, held.plan, held.options));
}

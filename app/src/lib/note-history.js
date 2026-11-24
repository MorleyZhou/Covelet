import { localData } from './local-data.js';
import { NOTE_HISTORY_KEY, validateNoteHistory } from './note-history-core.js';
export * from './note-history-core.js';

export async function loadNoteHistory() { return validateNoteHistory((await localData.get(NOTE_HISTORY_KEY))[NOTE_HISTORY_KEY]); }
export function subscribeNoteHistory(callback) {
  return localData.subscribe((changes) => { if (changes[NOTE_HISTORY_KEY]) callback(validateNoteHistory(changes[NOTE_HISTORY_KEY].newValue)); });
}

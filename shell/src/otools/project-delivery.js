import { Library } from '../storage/library.js';
import { otoolsBackend } from './backend.js';

/** A native document is opened in place; a ZIP still goes through bundle import. */
export async function openNativeProject(path, raw, { prepareToLeave, activate }) {
  const normalized = String(path || '').replaceAll('\\', '/');
  const match = /^(\/.*|[A-Za-z]:\/.*)\/projects\/([\w-]+)\.json$/.exec(normalized);
  if (!match || normalized.split('/').some((p) => p === '.' || p === '..')
    || raw?.format !== 'video-studio-project' || raw.version !== 1
    || !Array.isArray(raw.tracks) || !raw.assets || typeof raw.assets !== 'object') return false;
  // Re-read after flushing: the delivered file can be the editor's current document.
  if ((await prepareToLeave?.()) === false) return true;
  const library = new Library(otoolsBackend(match[1]));
  try {
    const project = await library.openProject(match[2]);
    await activate(library, project, match[1]);
  } catch (error) {
    library.dispose();
    throw error;
  }
  return true;
}

/** One drain across all deliveries, including files arriving during an awaited open. */
export function deliveryQueue(open, ready = () => true) {
  const pending = [];
  let running = null;
  const flush = () => {
    if (running) return running;
    if (!ready() || !pending.length) return Promise.resolve();
    running = Promise.resolve().then(async () => {
      while (ready() && pending.length) await open(pending.shift());
    }).finally(() => { running = null; });
    return running;
  };
  return { add(files) { pending.push(...files); return flush(); }, flush };
}

/**
 * Project files: one portable file holding a project and the media it uses,
 * for backups and for moving work between accounts or browsers.
 *
 * The container is a plain ZIP (stored, see zip.js):
 *   manifest.json          { format: 'video-studio-bundle', version, exported, name, media: [...], missing: [...] }
 *   project.json           the project document
 *   media/<hash>.<ext>     each media file once
 *   cover.jpg              home screen thumbnail (optional)
 *
 * Importing creates a new project (new id, fresh dates) and stores the media
 * again under freshly computed content hashes, so a damaged or hand-edited
 * file cannot overwrite other projects' media.
 */
import { uid } from '../lib/ids.js';
import { normalizeProject } from '../model/project.js';
import { zipBlobs, readZip } from './zip.js';

export const BUNDLE_FORMAT = 'video-studio-bundle';
export const BUNDLE_VERSION = 1;
export const BUNDLE_SUFFIX = '.video-studio.zip';
export const BUNDLE_ACCEPT = '.zip,application/zip,application/x-zip-compressed';

const mediaName = (a) => `media/${a.hash}${a.ext ? `.${a.ext}` : ''}`;

function fileBase(name) {
  const clean = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return clean || 'Project';
}

/**
 * Pack a project (id or document) into a project file.
 * Returns { blob, fileName, missing: [asset names that could not be read] }.
 */
export async function exportProjectBundle(library, project, { onProgress } = {}) {
  const p = typeof project === 'string' ? await library.openProject(project) : structuredClone(project);
  delete p.deletedAt;
  const assets = Object.values(p.assets);
  const entries = [];
  const media = [];
  const missing = [];
  const packed = new Set();
  let done = 0;
  for (const a of assets) {
    onProgress?.({ done, total: assets.length, name: a.name });
    done++;
    const path = mediaName(a);
    if (packed.has(path)) continue;
    let blob = null;
    try {
      blob = a.hash ? await library.mediaBlob(a) : null;
    } catch {
      blob = null;
    }
    if (!blob) {
      missing.push(a.name);
      continue;
    }
    packed.add(path);
    entries.push({ name: path, data: blob, modified: a.added });
    media.push({ path, name: a.name, size: blob.size });
  }
  onProgress?.({ done, total: assets.length });
  const cover = await library.coverBlob(p.id).catch(() => null);
  const manifest = { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, exported: Date.now(), name: p.name, media, missing };
  const head = [
    { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
    { name: 'project.json', data: JSON.stringify(p) },
  ];
  if (cover) head.push({ name: 'cover.jpg', data: cover });
  const blob = await zipBlobs([...head, ...entries]);
  return { blob, fileName: `${fileBase(p.name)}${BUNDLE_SUFFIX}`, missing };
}

/**
 * Read a project file and add it to the library as a new project.
 * Returns { project, missing: [asset names without a media file] }.
 */
export async function importProjectBundle(library, file, { onProgress } = {}) {
  const entries = await readZip(file);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const manifestEntry = byName.get('manifest.json');
  if (manifestEntry) {
    let manifest = null;
    try {
      manifest = JSON.parse(await (await manifestEntry.blob()).text());
    } catch {
      manifest = null;
    }
    if (manifest?.format && manifest.format !== BUNDLE_FORMAT) throw new Error('This ZIP file is not a Video Studio project file.');
    if (manifest?.version > BUNDLE_VERSION) throw new Error('This project file was made by a newer version of Video Studio.');
  }
  const projectEntry = byName.get('project.json');
  if (!projectEntry) throw new Error('This ZIP file is not a Video Studio project file (project.json is missing).');
  let raw;
  try {
    raw = JSON.parse(await (await projectEntry.blob()).text());
  } catch {
    throw new Error('The project in this file is damaged.');
  }
  const project = normalizeProject(raw);
  const assets = Object.values(project.assets);
  const missing = [];
  let done = 0;
  for (const a of assets) {
    onProgress?.({ done, total: assets.length, name: a.name });
    done++;
    const entry = byName.get(mediaName(a));
    if (!entry) {
      // The library may already hold this file (same account); otherwise it shows as missing media.
      missing.push(a.name);
      continue;
    }
    const blob = await entry.blob();
    project.assets[a.id] = await library.addMediaBlob({ ...a }, blob);
  }
  onProgress?.({ done, total: assets.length });
  const now = Date.now();
  project.id = uid('p');
  project.created = now;
  project.modified = now;
  delete project.deletedAt;
  await library.saveProject(project);
  const cover = byName.get('cover.jpg');
  if (cover) await library.saveCover(project.id, await cover.blob()).catch(() => {});
  return { project, missing };
}

/** Save a Blob as a download (browser) — the caller decides on Puter saving. */
export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

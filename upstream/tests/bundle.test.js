import { describe, it, expect, beforeEach } from 'vitest';
import { zipBlobs, readZip, crc32 } from '../src/storage/zip.js';
import { exportProjectBundle, importProjectBundle, BUNDLE_SUFFIX } from '../src/storage/bundle.js';
import { Library } from '../src/storage/library.js';
import { memoryBackend } from '../src/storage/backends.js';
import { createProject, makeClip } from '../src/model/project.js';
import { mainTrack } from '../src/model/timeline.js';
import { fingerprint } from '../src/lib/ids.js';

const text = async (blob) => new TextDecoder().decode(await blob.arrayBuffer());
const bytesOf = async (blob) => [...new Uint8Array(await blob.arrayBuffer())];

describe('zip', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it.each([false, true])('writes and reads back files (zip64: %s)', async (force64) => {
    const zip = await zipBlobs([
      { name: 'a.txt', data: 'hello' },
      { name: 'dir/ünïcode.json', data: '{"x":1}' },
      { name: 'empty.bin', data: new Uint8Array(0) },
      { name: 'bin/data.bin', data: new Blob([new Uint8Array([0, 1, 2, 250, 255])]) },
    ], { force64 });
    expect(zip.type).toBe('application/zip');
    const entries = await readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(['a.txt', 'dir/ünïcode.json', 'empty.bin', 'bin/data.bin']);
    expect(await text(await entries[0].blob())).toBe('hello');
    expect(await text(await entries[1].blob())).toBe('{"x":1}');
    expect((await entries[2].blob()).size).toBe(0);
    expect(await bytesOf(await entries[3].blob())).toEqual([0, 1, 2, 250, 255]);
    expect(entries[3].size).toBe(5);
  });

  it('starts with a local file header and ends with an end-of-directory record', async () => {
    const zip = await zipBlobs([{ name: 'x', data: 'y' }]);
    const b = await bytesOf(zip);
    expect(b.slice(0, 4)).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(b.slice(-22, -18)).toEqual([0x50, 0x4b, 0x05, 0x06]);
  });

  it('rejects files that are not archives and duplicate names', async () => {
    await expect(readZip(new Blob(['not a zip at all, just some text here']))).rejects.toThrow(/not a project file/);
    await expect(readZip(new Blob(['x']))).rejects.toThrow(/not a project file/);
    await expect(zipBlobs([{ name: 'a', data: '1' }, { name: 'a', data: '2' }])).rejects.toThrow(/Duplicate/);
  });
});

describe('project files', () => {
  let lib;
  let project;
  let video;
  let image;
  beforeEach(async () => {
    lib = new Library(memoryBackend());
    project = createProject({ name: 'Trip / day 1', ratio: '9:16' });
    video = await lib.addMediaBlob({ kind: 'video', name: 'clip.mp4', ext: 'mp4', mime: 'video/mp4', duration: 4_000_000, width: 1080, height: 1920, hasAudio: true }, new Blob([new Uint8Array([1, 2, 3, 4, 5, 6])], { type: 'video/mp4' }));
    image = await lib.addMediaBlob({ kind: 'image', name: 'pic.png', ext: 'png', mime: 'image/png', width: 10, height: 10 }, new Blob([new Uint8Array([9, 8, 7])], { type: 'image/png' }));
    project.assets[video.id] = video;
    project.assets[image.id] = image;
    mainTrack(project).clips.push(
      makeClip('video', { assetId: video.id, start: 0, duration: 4_000_000 }),
      makeClip('image', { assetId: image.id, start: 4_000_000, duration: 2_000_000, transition: null }),
    );
    project.tracks.unshift({ id: 'tt', kind: 'text', locked: false, hidden: false, muted: false, clips: [makeClip('text', { text: 'Hello', start: 0 })] });
    await lib.saveProject(project);
    await lib.saveCover(project.id, new Blob(['jpeg']));
  });

  it('round-trips a project and its media into another library', async () => {
    const { blob, fileName, missing } = await exportProjectBundle(lib, project.id);
    expect(fileName).toBe(`Trip day 1${BUNDLE_SUFFIX}`);
    expect(missing).toEqual([]);
    const names = (await readZip(blob)).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['manifest.json', 'project.json', 'cover.jpg', `media/${video.hash}.mp4`, `media/${image.hash}.png`]));

    const other = new Library(memoryBackend());
    const { project: copy, missing: gone } = await importProjectBundle(other, new File([blob], fileName));
    expect(gone).toEqual([]);
    expect(copy.id).not.toBe(project.id);
    expect(copy.name).toBe('Trip / day 1');
    expect(copy.settings).toEqual(project.settings);
    const strip = (p) => p.tracks.map((t) => ({ kind: t.kind, main: t.main, clips: t.clips.map((c) => ({ ...c })) }));
    expect(strip(copy)).toEqual(strip(await lib.openProject(project.id)));
    expect(Object.keys(copy.assets).sort()).toEqual(Object.keys(project.assets).sort());
    expect(await bytesOf(await other.mediaBlob(copy.assets[video.id]))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(other.backend.files.has(`media/${video.hash}.mp4`)).toBe(true);
    expect((await other.listProjects()).map((p) => p.id)).toEqual([copy.id]);
    expect(await text(await other.coverBlob(copy.id))).toBe('jpeg');
    // Opening it again from storage gives the same document.
    expect(await other.openProject(copy.id)).toEqual(copy);
  });

  it('imports into the same library as a separate project', async () => {
    const { blob } = await exportProjectBundle(lib, project.id);
    const { project: copy } = await importProjectBundle(lib, blob);
    const list = await lib.listProjects();
    expect(list.map((p) => p.id).sort()).toEqual([project.id, copy.id].sort());
    expect((await lib.openProject(project.id)).name).toBe('Trip / day 1');
  });

  it('exports a trashed project as a normal one', async () => {
    await lib.trashProject(project.id, 1_700_000_000_000);
    const { blob } = await exportProjectBundle(lib, project.id);
    const { project: copy } = await importProjectBundle(new Library(memoryBackend()), blob);
    expect(copy.deletedAt).toBeUndefined();
  });

  it('lists media it could not read instead of failing', async () => {
    lib.blobs.clear();
    lib.backend.files.delete(`media/${image.hash}.png`);
    const { blob, missing } = await exportProjectBundle(lib, project.id);
    expect(missing).toEqual(['pic.png']);
    const { project: copy, missing: gone } = await importProjectBundle(new Library(memoryBackend()), blob);
    expect(gone).toEqual(['pic.png']);
    expect(copy.assets[image.id]).toBeTruthy();
  });

  it('stores imported media under its real content hash', async () => {
    const forged = structuredClone(project);
    forged.assets[video.id].hash = 'bogus';
    const zip = await zipBlobs([
      { name: 'project.json', data: JSON.stringify(forged) },
      { name: 'media/bogus.mp4', data: new Blob([new Uint8Array([7, 7, 7])]) },
    ]);
    const other = new Library(memoryBackend());
    const { project: copy } = await importProjectBundle(other, zip);
    const real = await fingerprint(new Blob([new Uint8Array([7, 7, 7])]));
    expect(copy.assets[video.id].hash).toBe(real);
    expect(other.backend.files.has('media/bogus.mp4')).toBe(false);
    expect(other.backend.files.has(`media/${real}.mp4`)).toBe(true);
  });

  it('rejects archives that are not project files', async () => {
    const lib2 = new Library(memoryBackend());
    await expect(importProjectBundle(lib2, await zipBlobs([{ name: 'readme.txt', data: 'hi' }]))).rejects.toThrow(/project\.json is missing/);
    await expect(importProjectBundle(lib2, await zipBlobs([{ name: 'manifest.json', data: '{"format":"something-else"}' }, { name: 'project.json', data: '{}' }]))).rejects.toThrow(/not a Video Studio project file/);
    await expect(importProjectBundle(lib2, await zipBlobs([{ name: 'project.json', data: '{oops' }]))).rejects.toThrow(/damaged/);
    await expect(importProjectBundle(lib2, await zipBlobs([{ name: 'project.json', data: '{"format":"other"}' }]))).rejects.toThrow(/Not a Video Studio project/);
    expect(await lib2.listProjects()).toEqual([]);
  });
});

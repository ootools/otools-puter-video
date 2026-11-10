// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject } from '../src/model/project.js';
import * as delivery from '../src/otools/project-delivery.js';

const disk = new Map();
vi.mock('../src/otools/host.js', () => ({
  readFile: async (path) => disk.has(path) ? { dataBase64: btoa(disk.get(path)), mime: 'application/json' } : null,
  base64ToBytes: (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0)),
}));
const root = '/recordings/session/video-studio';
const path = `${root}/projects/recording.json`;
let raw;
beforeEach(() => {
  disk.clear();
  raw = { ...createProject({ name: 'Original project' }), id: 'recording' };
  disk.set(path, JSON.stringify(raw));
});

describe('native project delivery', () => {
  it('reopens the same library/project after flushing the current view, without an import', async () => {
    let release;
    let opened;
    const flushed = new Promise((resolve) => { release = resolve; });
    const prepareToLeave = () => flushed;
    const opening = delivery.openNativeProject(path, raw, {
      prepareToLeave,
      activate: (library, project, libraryRoot) => { opened = { library, project, libraryRoot }; },
    });
    await Promise.resolve();
    expect(opened).toBeUndefined();
    // Latest autosave must win even when the delivered JSON predates the flush.
    disk.set(path, JSON.stringify({ ...raw, name: 'Saved edit' }));
    release(true);
    expect(await opening).toBe(true);
    expect(opened.project.id).toBe('recording');
    expect(opened.project.name).toBe('Saved edit');
    expect(opened.libraryRoot).toBe(root);
    expect(opened.library.backend.root).toBe(root);
    expect(localStorage.length).toBe(0);
    expect([...disk.keys()]).toEqual([path]);
  });

  it('honors a declined flush without switching the library', async () => {
    let switched = false;
    expect(await delivery.openNativeProject(path, raw, {
      prepareToLeave: async () => false,
      activate: () => { switched = true; },
    })).toBe(true);
    expect(switched).toBe(false);
  });

  it.each([
    ['/recordings/recording.json', null],
    [`${root}/projects/../recording.json`, null],
    [path, { format: 'other', version: 1 }],
    [path, { format: 'video-studio-project', version: 2 }],
  ])('leaves non-native deliveries to existing media/bundle handling', async (file, doc) => {
    let switched = false;
    expect(await delivery.openNativeProject(file, doc, { activate: () => { switched = true; } })).toBe(false);
    expect(switched).toBe(false);
  });

  it('serializes batches and drains arrivals while opening without losing later files', async () => {
    let ready = false;
    const order = [];
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    const queue = delivery.deliveryQueue(async (file) => {
      order.push(`start:${file}`);
      if (file === 'a') await blocked;
      order.push(`end:${file}`);
    }, () => ready);
    queue.add(['a']);
    expect(order).toEqual([]);
    ready = true;
    const drain = queue.flush();
    await Promise.resolve();
    queue.add(['b', 'c']);
    expect(order).toEqual(['start:a']);
    release();
    await drain;
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
  });
});

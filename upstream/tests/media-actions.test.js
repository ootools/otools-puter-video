import { describe, it, expect } from 'vitest';
import { unusedAssets, swapAsset } from '../src/ui/media-actions.js';
import { fixture, clip, onMain, addAsset, s } from './helpers.js';

describe('media housekeeping', () => {
  it('finds assets no clip uses, keeping reversed pairs together', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 2));
    addAsset(p, { id: 'rev', kind: 'video', duration: s(10), reversedOf: 'silent' });
    const ids = unusedAssets(p).map((a) => a.id).sort();
    expect(ids).toEqual(['aud', 'img', 'rev', 'silent']);
    p.tracks[0].clips[0].assetId = 'rev';
    expect(unusedAssets(p).map((a) => a.id).sort()).toEqual(['aud', 'img', 'vid']);
  });

  it('points every clip at a new file', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 2, { name: 'vid' }), clip('video', 2, 2, { name: 'Custom' }));
    p.assets.vid.folder = 'f1';
    const n = swapAsset(p, 'vid', { id: 'new', kind: 'video', name: 'take2.mp4', duration: s(10) });
    expect(n).toBe(2);
    expect(p.assets.vid).toBeUndefined();
    expect(p.assets.new.folder).toBe('f1');
    expect(a.assetId).toBe('new');
    expect(a.name).toBe('take2.mp4');
    expect(b.name).toBe('Custom');
  });
});

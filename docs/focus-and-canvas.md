# Focus following and global canvas framing

These features work with any video imported into Video Studio. Recording projects use the same fields and controls; recording is only a source of an initial pointer path and zoom segments.

## Controls

- Select a video clip and open **Basic → Focus and zoom**. Enable the effect, add zoom segments, choose a multiplier and either a fixed center or **Follow focal path**. Add focal points at source times and edit their X/Y positions to create a path. Smoothing controls how quickly the view follows that path. A video without points uses the segment's fixed center and does not show a fabricated pointer.
- Open the project's existing frame/canvas settings and enable **Outer canvas frame**. Choose a color or gradient, padding and corner radius. This frames the entire composition, including camera, text and overlays, after global effects. The existing Canvas background controls the inner composition's empty areas.
- Preview and export use the same compositor passes. Source-time focus paths stay aligned when a clip is trimmed, split or retimed. The normal clip transform, crop and masks remain available.

## Native project fields

`project.settings.canvasFrame`:

```js
{ enabled: true, style: 'gradient', color: '#18243a', color2: '#5368af', padding: 0.08, radius: 0.03 }
```

Padding and radius are fractions of the output's shorter side. The complete scene is uniformly fitted into the available frame.

`videoClip.focusFollow`:

```js
{
  version: 1, enabled: true,
  sourceDuration: 12, sourceWidth: 1920, sourceHeight: 1080,
  smoothing: 0.22,
  points: [{ t: 1, x: 0.25, y: 0.5 }, { t: 4, x: 0.75, y: 0.5 }],
  segments: [{ id: 'focus-1', start: 1, end: 5, scale: 2, follow: true, x: 0.5, y: 0.5 }],
  showPointer: false, clickEffects: false
}
```

Times are source seconds; positions are normalized. Optional point `buttons` and `visible` support recording input and click effects. Generic imported videos can leave them absent. Segments are nonoverlapping; effect normalization validates all data. There is no `otoolsRecording` wrapper or recording-only capability marker.

The plugin declares `videoProjectFeatures: ['focus-follow-v1', 'canvas-frame-v1']` so producers can verify support before delivering a native project. Old recording project migration is deliberately omitted because that format was not deployed.

All implementation lives in `shell/`; the upstream snapshot remains unchanged.

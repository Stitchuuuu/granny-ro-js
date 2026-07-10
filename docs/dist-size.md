# Distribution bundle sizes

Produced by `npm run build` (rolldown, minified). Brotli column ≈ what a CDN
serves over the wire (`content-encoding: br`). JS-only — the `./wasm` variant
lands in a later pass.

## Consumption vectors

| Artifact | Format | min (KB) | brotli (KB) | For |
|---|---|---:|---:|---|
| `granny-ro.esm.js` | ESM, single-file | 63.8 | 18.0 | default `import` — modern browsers, bundlers, CDN |
| `granny-ro.cjs` | CJS, single-file | 64.0 | 18.0 | Node `require()` (not browser-loadable — `require` is Node-only) |
| `granny-ro.global.js` | IIFE, `window.GrannyRO` | 63.8 | 18.0 | classic `<script src>` (no ESM support needed) |

All three inline the IGC decoder → texture decode is synchronous, no warmup.

## Code-split (`./split`) — anim-only consumers skip the IGC decoder

| Artifact | Format | min (KB) | brotli (KB) | Fetched |
|---|---|---:|---:|---|
| `granny-ro.split.esm.js` | ESM entry (core) | 45.9 | 13.0 | always |
| `granny-ro-igc.js` | ESM chunk (IGC decoder) | 18.0 | 5.5 | lazily, only on `await loadTextureCodec()` |

An anim-only consumer of `./split` fetches **13.0 KB br** and never downloads
the 5.5 KB IGC chunk. A texture consumer awaits `loadTextureCodec()` once, then
decodes synchronously. The chunk import is relative (`import('./granny-ro-igc.js')`)
so it resolves on a version-pinned CDN with no config.

## Sub-entries (advanced, tree-shaken direct imports)

| Artifact | min (KB) | brotli (KB) | Export |
|---|---:|---:|---|
| `file.esm.js` | 3.3 | 1.4 | `granny-ro-js/file` |
| `oodle0.esm.js` | 7.6 | 2.7 | `granny-ro-js/oodle0` |
| `typetree.esm.js` | 15.5 | 5.2 | `granny-ro-js/typetree` |

## Browser / CDN

`granny-ro.esm.js` is self-contained (zero runtime deps inlined), so it loads
directly:

```html
<script type="module">
  import { Granny, parseModel } from 'https://cdn.jsdelivr.net/npm/granny-ro-js@1.1.0/dist/granny-ro.esm.js';
  await Granny.ready();
  // parseModel(buf) …
</script>
```

The bare CDN URL (`/npm/granny-ro-js`) resolves to `granny-ro.esm.js` via the
`browser`/`jsdelivr`/`unpkg` package fields. For a non-module page, load
`granny-ro.global.js` and use `window.GrannyRO`.

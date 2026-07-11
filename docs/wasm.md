# WASM texture decode

`granny-ro-js` ships an **opt-in WebAssembly build** that moves the one
CPU-hot part of the pipeline — the Bink-family wavelet **texture decode** —
into WASM, behind the exact same API as the pure-JS build. This page is the
full how-to; the README has the 10-second version.

## What is (and isn't) in WASM

| Stage | Build |
|---|---|
| **IGC texture decode** — range coder + inverse wavelet (iDWT) + YUV→RGB | **WASM** (JS fallback) |
| GR2 parse (header, sections, fixups, type-tree reflection) | JS |
| Oodle0 section decompression | JS |
| Mesh / skeleton / animation extraction, pose composition | JS |

Only the texture decode is ported because it's the only stage that is a
tight numeric inner loop — exactly what WASM is good at. The rest is
pointer-chasing, string handling and dynamic object graphs, where a JS
engine's JIT + GC already win and a WASM port would be more code for no (or
negative) gain. The **pure-JS decoder stays the mandatory, byte-exact
oracle**: the WASM path is purely additive behind the seam, and decode falls
back to JS automatically if the module is not instantiated.

The whole per-texture decode runs as **one JS→WASM crossing** — the four
planes stay resident in linear memory across their inverse-wavelet passes, so
there's no per-kernel boundary copy.

## Using it

Same named exports as the default build; the only difference is `await
Granny.ready()` once before the first decode (WASM instantiation is async).

```js
import { parseTextured, Granny } from 'granny-ro-js/wasm';

await Granny.ready();                 // instantiate once; idempotent
const { textures } = parseTextured(gr2Bytes);   // decode runs in WASM
```

### Bundler (Vite / webpack / Rollup)

`import … from 'granny-ro-js/wasm'` — the `.wasm` is inlined as base64, so the
bundler emits one self-contained module. Nothing to configure, no asset path
to resolve.

### CDN — no install

```html
<script type="module">
  import { parseTextured, Granny } from 'https://esm.sh/granny-ro-js/wasm';
  await Granny.ready();
  const bytes = new Uint8Array(await (await fetch('model.gr2')).arrayBuffer());
  const { textures } = parseTextured(bytes);
</script>
```

- **esm.sh** honours the `./wasm` export: `https://esm.sh/granny-ro-js/wasm`.
- **jsDelivr**, explicit path: `https://cdn.jsdelivr.net/npm/granny-ro-js/dist/granny-ro.wasm.esm.js`.
- Pure-JS build (no `await`): drop `/wasm` — `https://esm.sh/granny-ro-js`.

Because the wasm is inlined, a CDN serves the whole thing in **one** request —
no second `.wasm` fetch, no CORS/path juggling. Same reason it works from a
`@grant none` userscript.

### Node

Works identically — `WebAssembly` is built into Node. `Granny.ready()`
instantiates from the inlined bytes (no fetch).

## Keep the main thread responsive — run it in a Worker

A full-corpus texture decode is hundreds of milliseconds of straight CPU
work. On the **main thread** that blocks rendering for the whole decode; in a
**Worker** the render loop never stalls. This is the setup roBrowser-style
apps want.

```js
// worker.js
import { parseTextured, Granny } from 'granny-ro-js/wasm';
let ready;
onmessage = async (e) => {
  ready ??= Granny.ready();
  await ready;
  const { textures } = parseTextured(new Uint8Array(e.data)); // transferred buffer
  postMessage(textures.map((t) => ({ ...t, pixels: t.pixels })), textures.map((t) => t.pixels.buffer));
};
```

```js
// main.js
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
worker.postMessage(gr2Buffer, [gr2Buffer]);   // transfer, no copy
worker.onmessage = (e) => { /* upload e.data pixels to a texture */ };
```

## Numbers (browser verdict)

Chrome, 20-`.gr2` corpus, 20 warm iterations, `parseTextured` end-to-end
(parse + decode), measured via `bench/browser/`:

| axis | total warm-best | max main-thread stall |
|---|---|---|
| JS · main | 255 ms | **1100 ms** |
| JS · worker | 238 ms | 9 ms |
| **WASM · main** | **186 ms** | 659 ms |
| **WASM · worker** | **186 ms** | 9 ms |

→ **WASM ≈ 1.37× on the main thread, ≈ 1.28× in a Worker** (the browser JIT
is less aggressive on the JS decode than Node's, so the WASM edge is a touch
bigger here than the ~1.2× Node shows). The Worker axis is the one that
matters for UX: decode off-thread, **no render hitch**.

`Granny.ready()` instantiation is ~a few ms (main) and shows up once; it's
timed separately in the bench (`readyMs`) so it doesn't inflate the decode
numbers.

## Delivery: single-file vs external `.wasm`

The shipped `./wasm` build **inlines** the module (base64) → one file, works
everywhere including userscripts, at the cost of ~+10 KB gzip over the JS
build and an `atob` at startup. A WASM module can never be pointed at *alone*
in a browser (it has no DOM / IO / JS-object creation — there is always a JS
entry), so "one file" means "one JS module with the wasm inside", which is
what you get.

An external variant (separate `dist/kernels.wasm` + `instantiateStreaming`)
would trade the single-file property for a smaller JS bundle and a faster
cold start — good for bundler-only targets, unusable from a userscript. It is
not shipped today; the inlined build covers every target with zero config.

## Guarantees

- **Byte-exact.** The 17-fixture end-to-end gate asserts the WASM RGBA
  matches the pure-JS RGBA and the pinned manifest sha, per texture.
- **Fallback is mandatory.** Skip `Granny.ready()`, or let instantiation
  fail, and decode still produces identical pixels in pure JS.
- **Additive.** The default build (`import 'granny-ro-js'`) is unchanged —
  no WASM, synchronous, zero deps.

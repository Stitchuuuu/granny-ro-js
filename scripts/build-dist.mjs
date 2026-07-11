// build-dist.mjs — produce the JS-only distribution surface for granny-ro-js.
//
// Targets (all minified, zero runtime deps inlined) :
//   dist/granny-ro.esm.js      single-file ESM, IGC static-inlined, fully sync
//   dist/granny-ro.cjs         single-file CJS for Node require()
//   dist/granny-ro.split.esm.js + dist/granny-ro-igc.js
//                              code-split ESM : the ~2 000-line IGC decoder in
//                              its own stable-named chunk, dynamic-import()'d
//                              on demand (anim-only consumers never fetch it)
//   dist/{file,oodle0,typetree}.{esm.js,cjs}   the ./file ./oodle0 ./typetree subpaths
//   dist/granny-ro.d.ts        rolled-up types
//
// The single-file ESM is self-contained → loads directly via <script
// type="module"> and version-pinned / dynamic CDNs. See docs/dist-size.md.

import { rolldown } from 'rolldown';
import { generateDtsBundle } from 'dts-bundle-generator';
import { rmSync, mkdirSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = (p) => resolve(ROOT, 'src', p);
const DIST = (p) => resolve(ROOT, 'dist', p);

// Swap the static IGC codec binding (`./igc-codec.js`) for the lazy
// dynamic-import flavor (`./igc-codec.lazy.js`). Applied ONLY to the
// code-split build so the IGC decoder lands in its own chunk. The default
// build keeps the static binding → IGC decode stays synchronous, no warmup.
const lazyIgc = {
    name: 'lazy-igc',
    resolveId(source, importer) {
        if (importer && source === './igc-codec.js') return SRC('igc-codec.lazy.js');
        return null;
    },
};

// Swap the pure-JS kernel seam (`./igc-kernels.js`) for the WASM flavor
// (`./igc-kernels.wasm.js`). Applied ONLY to the `./wasm` build (stage 6) :
// kernels dispatch to a WebAssembly module, with the JS versions kept as the
// mandatory fallback. `Granny.js` (via `ready()`) and `GrannyTextureIGC.js`
// both import `./igc-kernels.js`, so both resolve to the same swapped module —
// one singleton wasm instance shared across the build.
const wasmKernels = {
    name: 'wasm-kernels',
    resolveId(source, importer) {
        if (importer && source === './igc-kernels.js') return SRC('igc-kernels.wasm.js');
        return null;
    },
};

async function withBundle(input, plugins, fn) {
    const b = await rolldown({ input, plugins });
    try {
        await fn(b);
    } finally {
        await b.close();
    }
}

// --- 1. clean -----------------------------------------------------------
rmSync(DIST(''), { recursive: true, force: true });
mkdirSync(DIST(''), { recursive: true });

// --- 2. default single-file ESM + CJS + IIFE global (IGC static-inlined, sync) --
//   ESM  : modern browsers (<script type="module">) + bundlers + CDN
//   CJS  : Node require()  (browsers can't run CJS — require() is Node-only)
//   IIFE : classic <script src> → window.GrannyRO (no module support needed)
await withBundle(SRC('Granny.js'), [], async (b) => {
    await b.write({ file: DIST('granny-ro.esm.js'), format: 'esm', minify: true });
    await b.write({ file: DIST('granny-ro.cjs'), format: 'cjs', minify: true, exports: 'named' });
    await b.write({ file: DIST('granny-ro.global.js'), format: 'iife', name: 'GrannyRO', minify: true });
});

// --- 3. code-split ESM (IGC in its own chunk, lazy dynamic import) ------
await withBundle(SRC('Granny.js'), [lazyIgc], async (b) => {
    await b.write({
        dir: DIST(''),
        format: 'esm',
        minify: true,
        entryFileNames: 'granny-ro.split.esm.js',
        chunkFileNames: 'granny-ro-igc.js',
    });
});

// --- 4. sub-entries (./file ./oodle0 ./typetree) ------------------------
const SUBS = [
    ['file', 'GrannyFile.js'],
    ['oodle0', 'GrannyOodle0.js'],
    ['typetree', 'GrannyTypeTree.js'],
];
for (const [name, src] of SUBS) {
    await withBundle(SRC(src), [], async (b) => {
        await b.write({ file: DIST(`${name}.esm.js`), format: 'esm', minify: true });
        await b.write({ file: DIST(`${name}.cjs`), format: 'cjs', minify: true, exports: 'named' });
    });
}

// --- 5. rolled-up types (main barrel + one per sub-entry) ---------------
// Two-stage roll. dts-bundle-generator cannot parse .js function bodies
// (its usage evaluator throws on index-signature access like `fields.Name`),
// so it never sees the source .js. Instead tsc first emits per-file .d.ts
// from the inline JSDoc — the single source of truth — into dist/.types/,
// then dts-bundle-generator bundles those bodyless .d.ts.
//
// Carve-out .d.ts (the src/index.d.ts barrel, plus any hand fragment such as
// a CurveCodec union) are NOT emitted by tsc — it consumes them as inputs —
// so copy every remaining src/*.d.ts into the stage dir to complete the graph
// the roll entries resolve against.
const DTS_STAGE = DIST('.types');
execFileSync(
    process.execPath,
    [resolve(ROOT, 'node_modules/typescript/bin/tsc'), '-p', resolve(ROOT, 'tsconfig.dts.json')],
    { cwd: ROOT, stdio: 'inherit' },
);
for (const f of readdirSync(SRC(''))) {
    if (f.endsWith('.d.ts')) copyFileSync(SRC(f), resolve(DTS_STAGE, f));
}

// One generateDtsBundle call PER entry : a single multi-entry call shares
// dedup state across bundles and hoists the shared symbols out of the main
// barrel (leaving `export {}`), so each entry must roll independently.
const STAGED = (p) => resolve(DTS_STAGE, p);
const DTS_ENTRIES = [
    // src-relative barrel (index.d.ts) — NOT the root index.d.ts, which
    // re-exports the dist bundle we're generating (would roll to `export {}`).
    ['granny-ro.d.ts', STAGED('index.d.ts')],
    ['file.d.ts', STAGED('GrannyFile.d.ts')],
    ['oodle0.d.ts', STAGED('GrannyOodle0.d.ts')],
    ['typetree.d.ts', STAGED('GrannyTypeTree.d.ts')],
];
for (const [outName, filePath] of DTS_ENTRIES) {
    const [dts] = generateDtsBundle(
        [{ filePath, output: { noBanner: true, sortNodes: false } }],
        { preferredConfigPath: resolve(ROOT, 'jsconfig.json') },
    );
    writeFileSync(DIST(outName), dts);
}
rmSync(DTS_STAGE, { recursive: true, force: true });

// --- 6. WASM build (opt-in ./wasm) : IGC static-inlined + kernels on WASM ----
// Same single-file ESM as stage 2, but the `wasmKernels` plugin swaps the
// kernel seam so kernels dispatch to the WebAssembly module. The kernel bytes
// ride along inlined as base64 (src/wasm/kernels-b64.js, a normal ESM string
// import → bundled, zero network fetch). `Granny.ready()` awaits instantiation ;
// the JS kernels stay compiled in as the mandatory fallback. IGC stays
// static-inlined (no lazyIgc here) so `loadTextureCodec()` remains a no-op.
await withBundle(SRC('Granny.js'), [wasmKernels], async (b) => {
    await b.write({ file: DIST('granny-ro.wasm.esm.js'), format: 'esm', minify: true });
});

console.log('dist/ built.');

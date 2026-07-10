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
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
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
// One generateDtsBundle call PER entry : a single multi-entry call shares
// dedup state across bundles and hoists the shared symbols out of the main
// barrel (leaving `export {}`), so each entry must roll independently.
const DTS_ENTRIES = [
    // src-relative barrel (src/index.d.ts) — NOT the root index.d.ts, which
    // re-exports the dist bundle we're generating (would roll to `export {}`).
    ['granny-ro.d.ts', SRC('index.d.ts')],
    ['file.d.ts', SRC('GrannyFile.d.ts')],
    ['oodle0.d.ts', SRC('GrannyOodle0.d.ts')],
    ['typetree.d.ts', SRC('GrannyTypeTree.d.ts')],
];
for (const [outName, filePath] of DTS_ENTRIES) {
    const [dts] = generateDtsBundle(
        [{ filePath, output: { noBanner: true, sortNodes: false } }],
        { preferredConfigPath: resolve(ROOT, 'jsconfig.json') },
    );
    writeFileSync(DIST(outName), dts);
}

console.log('dist/ built.');

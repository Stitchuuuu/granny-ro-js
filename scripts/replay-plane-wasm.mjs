// replay-plane-wasm.mjs — per-plane WASM-vs-JS planeDecode differential gate.
//
// Bundles Granny.js against the dev-only differential seam (igc-plane.tee.js,
// swapped for ./igc-kernels.js via rolldown resolveId), then decodes every
// model fixture. The tee seam runs BOTH the JS oracle and the WASM plane driver
// on each plane bitstream and asserts the full S16 plane output + rowMask +
// consumed-bytes are byte-identical — throwing at the first diverging
// (plane#, offset).
//
// Finer than the end-to-end RGBA sha (wasm-corpus.test.js) : a prediction /
// renorm bug surfaces here at the diverging pixel, not 2 kernels downstream.
// Exit 0 = byte-exact. Run : node scripts/replay-plane-wasm.mjs

import { rolldown } from 'rolldown';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = (p) => join(ROOT, 'src', p);
const TEE = join(ROOT, 'scripts', 'igc-plane.tee.js');
const OUT = join(ROOT, 'scripts', '.granny-plane-tee-bundle.mjs');
const FIX = join(ROOT, 'tests/fixtures/source');
const ANIM = /^\d+_(attack|damage|dead|move)\.gr2$/;

const teeSwap = {
    name: 'plane-tee-kernels',
    resolveId(source, importer) {
        if (importer && source === './igc-kernels.js') return TEE;
        return null;
    },
};

const b = await rolldown({ input: SRC('Granny.js'), plugins: [teeSwap] });
await b.write({ file: OUT, format: 'esm' });
await b.close();

try {
    const mod = await import(pathToFileURL(OUT).href);
    await mod.ready(); // instantiate wasm + plane driver inside the tee seam

    const files = readdirSync(FIX).filter((f) => f.endsWith('.gr2') && !ANIM.test(f));
    if (files.length === 0) {
        console.error('no model fixtures under tests/fixtures/source — run `npm run bake` first');
        process.exit(2);
    }

    for (const f of files) {
        mod.parseTextured(readFileSync(join(FIX, f))); // throws on the first divergence
        console.log(`  ✓ ${f}`);
    }
    console.log(`\nplaneDecode WASM-vs-JS replay : ${files.length}/${files.length} fixtures, every plane byte-exact`);
} finally {
    rmSync(OUT, { force: true });
}

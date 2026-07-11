// replay-arith-wasm.mjs — per-symbol WASM-vs-JS arith differential gate.
//
// Bundles Granny.js against the dev-only differential seam (igc-kernels.tee.js,
// swapped for ./igc-kernels.js via rolldown resolveId), then decodes every
// model fixture. The tee seam drives BOTH the JS oracle and the WASM coder on
// the same bitstream and asserts every emitted symbol + per-call coder/model
// state is byte-identical — throwing at the first divergence (call# + field).
//
// This is finer-grained than the end-to-end RGBA sha (wasm-corpus.test.js) : an
// off-by-one renorm surfaces here at the diverging symbol, not 3 kernels
// downstream. Exit 0 = byte-exact. Run : node scripts/replay-arith-wasm.mjs

import { rolldown } from 'rolldown';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = (p) => join(ROOT, 'src', p);
const TEE = join(ROOT, 'scripts', 'igc-kernels.tee.js');
const OUT = join(ROOT, 'scripts', '.granny-tee-bundle.mjs');
const FIX = join(ROOT, 'tests/fixtures/source');
const ANIM = /^\d+_(attack|damage|dead|move)\.gr2$/;

const teeSwap = {
    name: 'tee-kernels',
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
    await mod.ready(); // instantiate wasm + arith driver inside the tee seam

    const files = readdirSync(FIX).filter((f) => f.endsWith('.gr2') && !ANIM.test(f));
    if (files.length === 0) {
        console.error('no model fixtures under tests/fixtures/source — run `npm run bake` first');
        process.exit(2);
    }

    for (const f of files) {
        mod.parseTextured(readFileSync(join(FIX, f))); // throws on the first divergence
        console.log(`  ✓ ${f}`);
    }
    console.log(`\narith WASM-vs-JS replay : ${files.length}/${files.length} fixtures, every symbol byte-exact`);
} finally {
    rmSync(OUT, { force: true });
}

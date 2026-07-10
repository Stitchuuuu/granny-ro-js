#!/usr/bin/env node
// Differential self-check for the arithBits f64 fast-path.
//
// The arithBits multiply sites in src/GrannyTextureIGC.js decode 64-bit range
// math in plain f64 (provably exact — range·scale < 2^45 < 2^53). This driver
// sets IGC_ARITH_VERIFY=1 so each of those sites recomputes the BigInt
// reference and throws on the first call whose f64 result differs, then
// decodes every model fixture's textures (the only path that exercises the
// arith coder). Exit 0 = zero divergences across the whole corpus.
//
// Usage : node scripts/replay-arith-selfcheck.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Must be set before the module is imported — the flag is read at load time.
process.env.IGC_ARITH_VERIFY = '1';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'tests/fixtures/source');
const ANIM = /^\d+_(attack|damage|dead|move)\.gr2$/;

const { parseTextured } = await import('../src/Granny.js');

const files = readdirSync(SRC).filter((f) => f.endsWith('.gr2') && !ANIM.test(f));
if (files.length === 0) {
    console.error('no model fixtures under tests/fixtures/source — run `npm run bake` first');
    process.exit(2);
}

let ok = 0;
for (const f of files) {
    parseTextured(readFileSync(join(SRC, f))); // throws on the first divergence
    console.log(`  ✓ ${f}`);
    ok++;
}
console.log(`\narith self-check : ${ok}/${files.length} model fixtures decoded, 0 divergences`);

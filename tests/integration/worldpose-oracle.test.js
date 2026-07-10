/**
 * tests/integration/worldpose-oracle.test.js — wine-gated numeric oracle.
 *
 * Asserts the JS pose/placement layer matches the REAL granny2.dll
 * float-for-float, not just the Python `blendergranny` twin. The Wine shim
 * `gr2_worldpose.exe --pose-json` (shim/gr2_worldpose.c) drives the DLL's
 * actual anim+skin chain and prints two parseable line kinds :
 *
 *   PLACEMENT flags=… pos=… orient=… scale=…   (model InitialPlacement @ model+8)
 *   POSE t=… bone=… m=<16 floats>              (GetWorldPoseComposite4x4Array)
 *
 * We compare :
 *   - `extractModels()[0].initialPlacement` vs PLACEMENT for all 6 model
 *     fixtures (flags exact ; pos/orient/scaleShear within 1e-4).
 *   - `poseAt(parseAnimated(buf), 0, t).skinningMatrices` vs POSE for the 2
 *     fixtures that carry an animation. The DLL composite is built with a NULL
 *     offset, folding each bone's inverse-bind in — so it is the SKINNING
 *     matrix (world × invBind), col-major, T@12..14. Empirically confirmed
 *     (b4 @ t=0 : skinning maxdiff 8.6e-6 vs DLL ; worldMatrices diverge by 29).
 *
 * Gated on wine + the runtime bundle + the fixtures : CI has no wine and the
 * runtime bundle / corpus are gitignored, so this skips cleanly (green) there.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, statSync, copyFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    PKG_ROOT,
    SHIM_PREBUILT,
    SHIM_RUNTIME,
    findWine,
    spawnShim,
} from '../../scripts/lib/platform.mjs';
import { parseAnimated, poseAt } from '../../src/Granny.js';
// extractModels / loadGR2 / parseGR2File are re-exported by Granny.js at
// runtime but only typed in their submodules' .d.ts — import from there (as
// tests/unit/GrannyModel.test.js does) so tsc resolves them.
import { parseGR2File } from '../../src/GrannyFile.js';
import { loadGR2 } from '../../src/GrannyTypeTree.js';
import { extractModels } from '../../src/GrannyModel.js';

const SOURCE_DIR = resolve(PKG_ROOT, 'tests/fixtures/source');
const EXE_PREBUILT = resolve(SHIM_PREBUILT, 'gr2_worldpose.exe');
const EXE_RUNTIME = resolve(SHIM_RUNTIME, 'gr2_worldpose.exe');
const DLL_RUNTIME = resolve(SHIM_RUNTIME, 'granny2.dll');
const TOL = 1e-4;

/** All 6 model fixtures carry an InitialPlacement ; only 2 embed an animation. */
const MODEL_FIXTURES = [
    'guildflag90_1',
    'aguardian90_8',
    'sguardian90_9',
    'kguardian90_7',
    'empelium90_0',
    'treasurebox_2',
];
const ANIM_FIXTURES = [
    { name: 'guildflag90_1', mesh: 'Object08' },
    { name: 'aguardian90_8', mesh: 'body' },
];

// The runtime bundle is gitignored ; refresh the exe from the (committed)
// prebuilt when it's newer, so a rebuilt --pose-json shim is picked up. Only
// needs granny2.dll already staged beside it (LoadLibrary resolves by CWD).
if (existsSync(EXE_PREBUILT) && existsSync(DLL_RUNTIME)) {
    if (!existsSync(EXE_RUNTIME) ||
        statSync(EXE_RUNTIME).mtimeMs < statSync(EXE_PREBUILT).mtimeMs) {
        copyFileSync(EXE_PREBUILT, EXE_RUNTIME);
    }
}

let haveWine = false;
try { findWine(); haveWine = true; } catch { haveWine = false; }

const haveRuntime = existsSync(EXE_RUNTIME) && existsSync(DLL_RUNTIME);
const haveFixtures = MODEL_FIXTURES.every(
    (n) => existsSync(resolve(SOURCE_DIR, `${n}.gr2`)),
);
const canRun = haveWine && haveRuntime && haveFixtures;

/**
 * Run the shim in --pose-json mode for one fixture and parse its stdout.
 * Fixtures are passed by path relative to the runtime CWD (wine resolves it
 * against the unix cwd). A placement-only run passes a bogus mesh — the shim
 * prints PLACEMENT then exits 0 cleanly.
 * @returns {{ placement: object|null, poses: Array<{t:number,bone:number,m:number[]}> }}
 */
function runShim(name, mesh, duration, samples) {
    const rel = `../../tests/fixtures/source/${name}.gr2`;
    const res = spawnShim(
        EXE_RUNTIME,
        [rel, mesh, String(duration), String(samples), '--pose-json'],
        { cwd: SHIM_RUNTIME },
    );
    const stdout = (res.stdout ?? '').toString('utf8');
    let placement = null;
    const poses = [];
    for (const line of stdout.split(/\r?\n/)) {  // wine emits CRLF
        if (line.startsWith('PLACEMENT')) {
            const m = line.match(
                /flags=(\d+) pos=([^ ]+) orient=([^ ]+) scale=([^ ]+)/,
            );
            placement = {
                flags: Number(m[1]),
                position: m[2].split(',').map(Number),
                orientation: m[3].split(',').map(Number),
                scaleShear: m[4].split(',').map(Number),
            };
        } else if (line.startsWith('POSE')) {
            const m = line.match(/t=([^ ]+) bone=(\d+) m=(.+)$/);
            poses.push({
                t: Number(m[1]),
                bone: Number(m[2]),
                m: m[3].split(',').map(Number),
            });
        }
    }
    return { placement, poses };
}

/** Max abs elementwise difference across two equal-length numeric arrays. */
function maxDiff(a, b) {
    let d = 0;
    for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
    return d;
}

// Cache one shim run per fixture (wine spawns are slow). Anim fixtures are
// swept at the JS animation's real duration so sampled t stays in range —
// past-duration t makes the DLL clock wrap/clamp differently from JS.
const shimCache = {};
function shimFor(name) {
    if (!shimCache[name]) {
        const anim = ANIM_FIXTURES.find((f) => f.name === name);
        if (anim) {
            const dur = parseAnimated(
                readFileSync(resolve(SOURCE_DIR, `${name}.gr2`)),
            ).animations[0].duration;
            // 4 samples → t = {0, dur/3, 2·dur/3, dur}, incl. t=0.
            shimCache[name] = runShim(name, anim.mesh, dur, 4);
        } else {
            shimCache[name] = runShim(name, '__no_mesh__', 1, 1);
        }
    }
    return shimCache[name];
}

describe.skipIf(!canRun)('worldpose DLL oracle — InitialPlacement (6 models)', () => {
    it.each(MODEL_FIXTURES)('%s : JS initialPlacement matches granny2.dll', (name) => {
        const { placement } = shimFor(name);
        expect(placement, `no PLACEMENT line for ${name}`).not.toBeNull();

        const buf = readFileSync(resolve(SOURCE_DIR, `${name}.gr2`));
        const js = extractModels(loadGR2(parseGR2File(buf)))[0].initialPlacement;

        expect(js.flags).toBe(placement.flags);
        expect(maxDiff(js.position, placement.position)).toBeLessThan(TOL);
        expect(maxDiff(js.orientation, placement.orientation)).toBeLessThan(TOL);
        expect(maxDiff(js.scaleShear, placement.scaleShear)).toBeLessThan(TOL);
    });
});

describe.skipIf(!canRun)('worldpose DLL oracle — pose composite (anim fixtures)', () => {
    it.each(ANIM_FIXTURES)('$name : poseAt() skinning matrices match granny2.dll', ({ name }) => {
        const { poses } = shimFor(name);
        expect(poses.length, `no POSE lines for ${name}`).toBeGreaterThan(0);

        const parsed = parseAnimated(readFileSync(resolve(SOURCE_DIR, `${name}.gr2`)));

        // Group the DLL composites by their exact printed t, then pose JS once
        // per t and compare every bone's skinning matrix elementwise.
        const byT = new Map();
        for (const p of poses) {
            if (!byT.has(p.t)) byT.set(p.t, []);
            byT.get(p.t).push(p);
        }

        for (const [t, bones] of byT) {
            const snap = poseAt(parsed, 0, t);
            for (const { bone, m } of bones) {
                const js = snap.skinningMatrices[bone];
                const d = maxDiff(Array.from(js), m);
                expect(d, `${name} bone ${bone} @ t=${t} maxdiff ${d}`).toBeLessThan(TOL);
            }
        }
    });
});

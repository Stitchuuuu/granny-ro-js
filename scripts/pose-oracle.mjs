#!/usr/bin/env node
/**
 * pose-oracle.mjs — standalone granny2.dll pose oracle CLI.
 *
 * Drives the real granny2.dll (via the Wine shim gr2_worldpose.exe) and
 * compares its per-bone local-pose + skinning output against the JS `poseAt`,
 * at the RO 40 Hz tick grid. Two modes, both sharing scripts/lib/pose-oracle.mjs
 * with the vitest suite :
 *
 *   node scripts/pose-oracle.mjs                     # global : sweep all 21
 *   node scripts/pose-oracle.mjs --all               #   same
 *   node scripts/pose-oracle.mjs 7_attack            # targeted : full 40 Hz sweep
 *   node scripts/pose-oracle.mjs 7_attack all        #   explicit full sweep
 *   node scripts/pose-oracle.mjs 7_attack --frame 12 # one grid frame
 *   node scripts/pose-oracle.mjs 7_attack 0 --t 0.35 # one arbitrary time (seconds)
 *
 * <file> is a fixture basename (resolved under tests/fixtures/source/) or a
 * path to a .gr2. [anim] is the animation index (default 0). Cross-platform :
 * wine is resolved by findWine() inside the lib — never hardcoded. Exit codes :
 *   0  all within bound (local-pose strict 1e-4 ; skinning per-fixture bound)
 *   1  a strict bound was exceeded (a real faithfulness regression)
 *   2  infrastructure : no wine / no granny2.dll / shim crash
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import {
    SOURCE_DIR,
    POSE_MESH,
    ensureFixtures,
    haveWine,
    haveDll,
    frameGrid,
    runPoseShim,
    groupByT,
    compareLocalPose,
    compareSkinning,
    skinningBoundFor,
    localOrientBoundFor,
    SKINNING_BOUNDS,
    LOCAL_ORIENT_BOUNDS,
    DEFAULT_SKINNING_BOUND,
} from './lib/pose-oracle.mjs';
import { parseAnimated, poseAt } from '../src/Granny.js';

const LOCAL_TOL = 1e-4;
const ex = (x) => (typeof x === 'number' ? x.toExponential(2) : String(x));
const pad = (s, w) => String(s).padStart(w, ' ');
const padR = (s, w) => String(s).padEnd(w, ' ');

/** Parse argv into { file, animIndex, mode, tSec, frameN }. Unknown → throw. */
function parseArgs(argv) {
    const out = { file: null, animIndex: 0, mode: 'grid', tSec: null, frameN: null, all: false };
    const pos = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--all') out.all = true;
        else if (a === '--t') { out.tSec = Number(argv[++i]); out.mode = 't'; }
        else if (a === '--frame') { out.frameN = Number(argv[++i]); out.mode = 'frame'; }
        else if (a === 'all') out.mode = 'grid';
        else if (a.startsWith('--')) throw new Error(`unknown arg : ${a}`);
        else pos.push(a);
    }
    out.file = pos[0] ?? null;
    if (pos[1] != null) out.animIndex = Number(pos[1]);
    return out;
}

/** Resolve a fixture arg (basename or path) → { name, gr2Path }. */
function resolveFixture(file) {
    if (file.endsWith('.gr2') && existsSync(file)) {
        return { name: basename(file, '.gr2'), gr2Path: file };
    }
    const name = file.endsWith('.gr2') ? basename(file, '.gr2') : file;
    return { name, gr2Path: resolve(SOURCE_DIR, `${name}.gr2`) };
}

/** Load + parse one fixture. */
function loadFixture(gr2Path, animIndex) {
    const parsed = parseAnimated(readFileSync(gr2Path));
    const skeleton = parsed.skeletons[0] ?? null;
    const dur = parsed.animations[animIndex]?.duration ?? 0;
    return { parsed, skeleton, dur };
}

/** Format a worst-bone breakdown line for local-pose. */
function fmtLocalWorst(w) {
    if (!w) return 'exact';
    return `${w.name ?? `#${w.bone}`}(d${w.depth}) ${w.channel}[${w.index}] js=${ex(w.js)} dll=${ex(w.dll)} Δ=${ex(w.diff)}`;
}
/** Format a worst-bone breakdown line for skinning. */
function fmtSkinWorst(w) {
    if (!w) return 'exact';
    return `${w.name ?? `#${w.bone}`}(d${w.depth}) m[${w.index}] js=${ex(w.js)} dll=${ex(w.dll)} Δ=${ex(w.diff)}`;
}

/**
 * Compare one fixture across a set of tKeys already grouped from a shim run.
 * Local-pose is split per channel : position + scaleShear are the strict
 * metric, orientation carries the (per-fixture) curve-eval divergence.
 * @returns {{ localPosMax:number, localOrientMax:number, localScaleMax:number,
 *   localMax:number, skinMax:number, localWorst, skinWorst, frames:number }}
 */
function compareAll(parsed, skeleton, animIndex, locByT, posByT, { perFrame = false } = {}) {
    let localPosMax = 0;
    let localOrientMax = 0;
    let localScaleMax = 0;
    let localMax = 0;
    let skinMax = 0;
    let localWorst = null;
    let skinWorst = null;
    const keys = Object.keys(locByT);
    let f = 0;
    for (const tKey of keys) {
        const snap = poseAt(parsed, animIndex, Number(tKey));
        const rl = compareLocalPose(snap, locByT[tKey], skeleton);
        const rs = compareSkinning(snap, posByT[tKey] ?? [], skeleton);
        if (rl.posMax > localPosMax) localPosMax = rl.posMax;
        if (rl.orientMax > localOrientMax) localOrientMax = rl.orientMax;
        if (rl.scaleMax > localScaleMax) localScaleMax = rl.scaleMax;
        if (rl.max > localMax) { localMax = rl.max; localWorst = rl.worst; }
        if (rs.max > skinMax) { skinMax = rs.max; skinWorst = rs.worst; }
        if (perFrame) {
            f++;
            console.log(
                `  frame ${pad(f, 3)}/${keys.length}  t=${padR(tKey, 10)} ` +
                `local ${ex(rl.max)} [${fmtLocalWorst(rl.worst)}]  ` +
                `skin ${ex(rs.max)} [${fmtSkinWorst(rs.worst)}]`,
            );
        }
    }
    return {
        localPosMax, localOrientMax, localScaleMax, localMax, skinMax,
        localWorst, skinWorst, frames: keys.length,
    };
}

/** Local-pose verdict : position + scaleShear strict, orientation per-fixture. */
function localPass(name, r) {
    return r.localPosMax < LOCAL_TOL
        && r.localScaleMax < LOCAL_TOL
        && r.localOrientMax < localOrientBoundFor(name);
}

/** Targeted debug on one fixture. Returns process exit code. */
function runTargeted(opts) {
    const { name, gr2Path } = resolveFixture(opts.file);
    if (!existsSync(gr2Path)) {
        console.error(`[pose-oracle] fixture not found : ${gr2Path}`);
        return 2;
    }
    const { parsed, skeleton, dur } = loadFixture(gr2Path, opts.animIndex);
    console.log(`fixture ${name}  anim ${opts.animIndex}  duration ${dur.toFixed(3)}s  bones ${skeleton?.bones.length ?? 0}`);

    // Spawn per mode. `--t` needs duration=tSec, samples=2 (the shim forces
    // t=0 when samples<=1) and keeps the max-tKey group = the requested time.
    let data;
    let title;
    if (opts.mode === 't') {
        data = runPoseShim(name, POSE_MESH, opts.tSec, 2);
        title = `--t ${opts.tSec}`;
    } else {
        const { samples } = frameGrid(dur, 40);
        data = runPoseShim(name, POSE_MESH, dur, samples);
        title = opts.mode === 'frame' ? `--frame ${opts.frameN}` : 'full 40 Hz sweep';
    }

    if (!data.ok) {
        console.error(`[pose-oracle] shim failed (status=${data.status}) :\n${data.stderrTail}`);
        return 2;
    }

    const locByT = groupByT(data.locals);
    const posByT = groupByT(data.poses);
    const keys = Object.keys(locByT);
    if (opts.mode === 't') {
        keepOnly(locByT, posByT, keys[keys.length - 1]);
    } else if (opts.mode === 'frame') {
        const pick = keys[opts.frameN];
        if (pick === undefined) {
            console.error(`[pose-oracle] frame ${opts.frameN} out of range (0..${keys.length - 1})`);
            return 2;
        }
        keepOnly(locByT, posByT, pick);
    }

    console.log(`mode : ${title}  (${Object.keys(locByT).length} frame(s))\n`);
    const r = compareAll(parsed, skeleton, opts.animIndex, locByT, posByT, { perFrame: true });

    const skinBound = skinningBoundFor(name);
    const orientBound = localOrientBoundFor(name);
    const lPass = localPass(name, r);
    const skinPass = r.skinMax < skinBound;
    console.log(
        `\nsummary  local  pos ${ex(r.localPosMax)} orient ${ex(r.localOrientMax)} (bound ${ex(orientBound)}) ` +
        `scale ${ex(r.localScaleMax)}  [${fmtLocalWorst(r.localWorst)}] ${lPass ? 'PASS' : 'FAIL'}\n` +
        `         skin   max ${ex(r.skinMax)} (bound ${ex(skinBound)})  [${fmtSkinWorst(r.skinWorst)}] ${skinPass ? 'PASS' : 'FAIL'}`,
    );
    if (SKINNING_BOUNDS[name]) console.log(`         skin note  : ${SKINNING_BOUNDS[name].note}`);
    if (LOCAL_ORIENT_BOUNDS[name]) console.log(`         local note : ${LOCAL_ORIENT_BOUNDS[name].note}`);
    return (lPass && skinPass) ? 0 : 1;
}

/** Keep only `key` in both grouped objects (mutates). */
function keepOnly(locByT, posByT, key) {
    for (const k of Object.keys(locByT)) if (k !== key) delete locByT[k];
    for (const k of Object.keys(posByT)) if (k !== key) delete posByT[k];
}

/** Global sweep of all 21 fixtures. Returns process exit code. */
function runGlobal() {
    const { fixtures } = ensureFixtures();
    if (fixtures.length === 0) {
        console.error('[pose-oracle] no fixtures (set RO_FOLDER or populate tests/fixtures/source/)');
        return 2;
    }
    console.log(`pose-oracle — DLL sweep of ${fixtures.length} fixtures at 40 Hz\n`);

    const rows = [];
    let anyFail = false;
    let anyInfra = false;
    for (let i = 0; i < fixtures.length; i++) {
        const name = fixtures[i];
        const { parsed, skeleton, dur } = loadFixture(resolve(SOURCE_DIR, `${name}.gr2`), 0);
        const { samples } = frameGrid(dur, 40);
        const data = runPoseShim(name, POSE_MESH, dur, samples);
        if (!data.ok) {
            anyInfra = true;
            console.log(`[${pad(i + 1, 2)}/${fixtures.length}] ${padR(name, 14)} SHIM FAILED (status=${data.status})`);
            rows.push({ name, frames: 0, localMax: NaN, skinMax: NaN, bound: skinningBoundFor(name), status: 'INFRA' });
            continue;
        }
        const r = compareAll(parsed, skeleton, 0, groupByT(data.locals), groupByT(data.poses), {});
        const bound = skinningBoundFor(name);
        const lPass = localPass(name, r);
        const skinPass = r.skinMax < bound;
        if (!lPass || !skinPass) anyFail = true;
        const status = lPass && skinPass ? 'PASS' : (!lPass ? 'LOCAL-FAIL' : 'SKIN-FAIL');
        rows.push({ name, frames: r.frames, localMax: r.localMax, skinMax: r.skinMax, bound, status });
        console.log(
            `[${pad(i + 1, 2)}/${fixtures.length}] ${padR(name, 14)} ` +
            `frames ${pad(r.frames, 3)}  local ${ex(r.localMax)}  skin ${ex(r.skinMax)}  ` +
            `bound ${ex(bound)}  ${status}`,
        );
    }

    printTable(rows);
    if (anyInfra) return 2;
    return anyFail ? 1 : 0;
}

/** Final PASS/FAIL table (perf.mjs pad style). */
function printTable(rows) {
    const headers = ['fixture', 'frames', 'local max', 'skin max', 'bound', 'status'];
    const w = [
        Math.max(headers[0].length, ...rows.map((r) => r.name.length)),
        headers[1].length,
        Math.max(headers[2].length, 9),
        Math.max(headers[3].length, 9),
        Math.max(headers[4].length, 8),
        Math.max(headers[5].length, 10),
    ];
    const sep = w.map((x) => '-'.repeat(x)).join('  ');
    console.log('');
    console.log([padR(headers[0], w[0]), pad(headers[1], w[1]), pad(headers[2], w[2]), pad(headers[3], w[3]), pad(headers[4], w[4]), pad(headers[5], w[5])].join('  '));
    console.log(sep);
    for (const r of rows) {
        console.log([
            padR(r.name, w[0]),
            pad(r.frames, w[1]),
            pad(Number.isNaN(r.localMax) ? '—' : ex(r.localMax), w[2]),
            pad(Number.isNaN(r.skinMax) ? '—' : ex(r.skinMax), w[3]),
            pad(ex(r.bound), w[4]),
            pad(r.status, w[5]),
        ].join('  '));
    }
    console.log(sep);
    const pass = rows.filter((r) => r.status === 'PASS').length;
    console.log(`\n${pass}/${rows.length} PASS  (local-pose strict ${ex(LOCAL_TOL)} ; skinning per-fixture bound, default ${ex(DEFAULT_SKINNING_BOUND)})`);
}

function main() {
    if (!haveWine()) {
        console.error('[pose-oracle] no wine binary found — set WINE_BIN or install Wine.');
        process.exit(2);
    }
    if (!haveDll()) {
        console.error('[pose-oracle] granny2.dll not resolvable — set RO_FOLDER or GRANNY2_DLL.');
        process.exit(2);
    }
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (e) {
        console.error(`[pose-oracle] ${e.message}`);
        process.exit(2);
    }
    const code = (opts.all || !opts.file) ? runGlobal() : runTargeted(opts);
    process.exit(code);
}

main();

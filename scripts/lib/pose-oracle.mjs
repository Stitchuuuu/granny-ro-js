/**
 * pose-oracle.mjs — shared plumbing for the granny2.dll pose oracle.
 *
 * One implementation of the DLL-vs-JS pose comparison, used by BOTH the
 * wine-gated vitest suite (tests/integration/worldpose-oracle.test.js) and the
 * standalone CLI (scripts/pose-oracle.mjs). The Wine shim
 * `shim/gr2_worldpose.exe --pose-json` (shim/gr2_worldpose.c) drives the real
 * DLL's anim+skin chain and prints three parseable line kinds on stdout
 * (diagnostics on stderr) :
 *
 *   PLACEMENT flags=<u32> pos=<3f> orient=<4f> scale=<9f>        (model InitialPlacement)
 *   LOCALPOSE t=<f> bone=<i> flags=<u32> pos=<3f> orient=<4f xyzw> scale=<9f>
 *   POSE      t=<f> bone=<i> m=<16 floats col-major>             (skinning composite)
 *
 * Provisioning matches the bake scripts : `RO_FOLDER` (auto-loaded from the
 * committed .env below) resolves granny2.dll via platform.mjs, and the .gr2
 * fixtures are extracted from `${RO_FOLDER}/data.grf` on demand (ensureFixtures)
 * when tests/fixtures/source/ is empty — never a hard dependency on the cache.
 */

import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import {
    PKG_ROOT,
    SHIM_PREBUILT,
    SHIM_RUNTIME,
    findGranny2Dll,
    findWine,
    spawnShim,
    stageShimRuntime,
} from './platform.mjs';
import { walkGrf } from './discover-gr2.mjs';

// Auto-load the committed .env so RO_FOLDER (and GRANNY2_DLL, if set) reach
// findGranny2Dll without the caller prefixing them — same intent as the .env
// the bake scripts expect. Best-effort : missing file / old Node → no-op, and
// the CI gate simply skips (no wine, no RO_FOLDER).
try { process.loadEnvFile(resolve(PKG_ROOT, '.env')); } catch { /* no .env — fine */ }

export const SOURCE_DIR = resolve(PKG_ROOT, 'tests/fixtures/source');
export const SHIM_SRC = resolve(SHIM_PREBUILT, 'gr2_worldpose.exe');
/** Mesh placeholder — the POSE/LOCALPOSE dump is per-bone and mesh-independent,
 * so the shim continues with mesh==NULL and this name is never matched. */
export const POSE_MESH = '__pose__';

/** List fixture basenames (no .gr2) currently in SOURCE_DIR, sorted. */
function listFixtures() {
    if (!existsSync(SOURCE_DIR)) return [];
    return readdirSync(SOURCE_DIR)
        .filter((n) => n.endsWith('.gr2'))
        .map((n) => n.slice(0, -4))
        .sort();
}

/**
 * Guarantee tests/fixtures/source/ carries the .gr2 fixtures. If the dir is
 * already populated it's a cheap no-op (the in-container case). Otherwise, if
 * `${RO_FOLDER}/data.grf` is reachable, extract every .gr2 from it (via the
 * vendored grf-inspect through {@link walkGrf}) and materialize them by
 * basename into SOURCE_DIR — mirroring bake-all.mjs without touching it.
 *
 * @returns {{ fixtures: string[], provisioned: boolean }}
 *   `fixtures` = the resulting basenames (empty when nothing could be provided —
 *   the caller then skips). `provisioned` = whether an extraction actually ran.
 */
export function ensureFixtures() {
    const existing = listFixtures();
    if (existing.length > 0) return { fixtures: existing, provisioned: false };

    const roFolder = process.env.RO_FOLDER;
    const dataGrf = roFolder ? resolve(PKG_ROOT, roFolder, 'data.grf') : null;
    if (!dataGrf || !existsSync(dataGrf)) return { fixtures: [], provisioned: false };

    const { records, cleanup } = walkGrf(dataGrf);
    try {
        for (const rec of records) {
            if (!/\.gr2$/i.test(rec.name)) continue;
            writeFileSync(join(SOURCE_DIR, basename(rec.name)), rec.bytes);
        }
    } finally {
        cleanup();
    }
    return { fixtures: listFixtures(), provisioned: records.length > 0 };
}

/** True when a wine binary is resolvable (findWine throws otherwise). */
export function haveWine() {
    try { findWine(); return true; } catch { return false; }
}

/** True when granny2.dll is resolvable (RO_FOLDER/GRANNY2_DLL) or already
 * staged beside the shim runtime. Non-throwing — for the skip gate. */
export function haveDll() {
    if (existsSync(join(SHIM_RUNTIME, 'granny2.dll'))) return true;
    try { findGranny2Dll(); return true; } catch { return false; }
}

/**
 * Canonical RO 40 Hz sample grid for one animation. `samples` is the tick
 * count; `times[s] = duration*s/(samples-1)`, with `times[last]` pinned to
 * exactly `duration` (never past it). A zero-duration animation collapses to a
 * single t=0 sample.
 *
 * NOTE — `times[]` is an f64 grid used ONLY for CLI display and `--frame`
 * indexing. The numeric compare NEVER poses at these values : it poses at the
 * shim's f32-PRINTED t (see {@link runPoseShim} `tKey`), because the shim
 * already f32-rounded and emitted the t it actually sampled.
 *
 * @param {number} duration — seconds (= parseAnimated(...).animations[0].duration).
 * @param {number} [hz] tick rate, default 40.
 * @returns {{ samples: number, times: number[] }}
 */
export function frameGrid(duration, hz = 40) {
    if (!(duration > 0)) return { samples: 1, times: [0] };
    const samples = Math.max(1, Math.round(duration * hz) + 1);
    if (samples === 1) return { samples: 1, times: [0] };
    const times = new Array(samples);
    for (let s = 0; s < samples; s++) times[s] = (duration * s) / (samples - 1);
    times[samples - 1] = duration; // pin the endpoint exactly
    return { samples, times };
}

const FLOATS = (s) => s.split(',').map(Number);

/**
 * Run the shim once in --pose-json mode for one fixture and parse its stdout.
 * Stages the runtime (dll + exe into shim/runtime/, refreshed by mtime) via
 * `stageShimRuntime`, then spawns via `spawnShim` (wine resolved per platform —
 * never hardcoded). The fixture is passed by path relative to the runtime cwd.
 *
 * Each parsed local/pose row carries **`tKey`** — the exact printed `t=` token
 * (string) — and `t = Number(tKey)`. Group by `tKey` and pose JS at `Number(tKey)`
 * so the comparison uses the shim's f32-rounded sample time, not a recomputed grid.
 *
 * @param {string} name — fixture basename (no .gr2), resolved under SOURCE_DIR.
 * @param {string} mesh — normally {@link POSE_MESH}.
 * @param {number} duration — sweep duration in seconds.
 * @param {number} samples — number of grid samples.
 * @returns {{
 *   ok: boolean, status: number|null, stderrTail: string,
 *   placement: null | { flags: number, position: number[], orientation: number[], scaleShear: number[] },
 *   locals: Array<{ t: number, tKey: string, bone: number, flags: number,
 *                   position: number[], orientation: number[], scaleShear: number[] }>,
 *   poses:  Array<{ t: number, tKey: string, bone: number, m: number[] }>,
 * }}
 */
export function runPoseShim(name, mesh, duration, samples) {
    const runtimeExe = stageShimRuntime(SHIM_SRC);
    const rel = `../../tests/fixtures/source/${name}.gr2`;
    const res = spawnShim(
        runtimeExe,
        [rel, mesh, String(duration), String(samples), '--pose-json'],
        // 40 Hz × boneCount × (LOCALPOSE+POSE) reaches ~10 MB on the long,
        // high-bone fixtures (empelium ~398 samples) — well past spawnSync's
        // 1 MB default, which would SIGKILL the process (status=null). 128 MB
        // headroom covers the whole corpus.
        { cwd: SHIM_RUNTIME, maxBuffer: 128 * 1024 * 1024 },
    );
    const stdout = (res.stdout ?? '').toString('utf8');
    const stderr = (res.stderr ?? '').toString('utf8');

    let placement = null;
    const locals = [];
    const poses = [];
    for (const line of stdout.split(/\r?\n/)) { // wine emits CRLF
        if (line.startsWith('PLACEMENT')) {
            const m = line.match(
                /flags=(\d+) pos=([^ ]+) orient=([^ ]+) scale=([^ ]+)/,
            );
            if (m) {
                placement = {
                    flags: Number(m[1]),
                    position: FLOATS(m[2]),
                    orientation: FLOATS(m[3]),
                    scaleShear: FLOATS(m[4]),
                };
            }
        } else if (line.startsWith('LOCALPOSE')) {
            const m = line.match(
                /t=([^ ]+) bone=(\d+) flags=(\d+) pos=([^ ]+) orient=([^ ]+) scale=([^ ]+)/,
            );
            if (m) {
                locals.push({
                    t: Number(m[1]), tKey: m[1], bone: Number(m[2]), flags: Number(m[3]),
                    position: FLOATS(m[4]), orientation: FLOATS(m[5]), scaleShear: FLOATS(m[6]),
                });
            }
        } else if (line.startsWith('POSE')) {
            const m = line.match(/t=([^ ]+) bone=(\d+) m=(.+)$/);
            if (m) {
                poses.push({ t: Number(m[1]), tKey: m[1], bone: Number(m[2]), m: FLOATS(m[3]) });
            }
        }
    }

    const ok = res.status === 0 && (placement !== null || locals.length > 0 || poses.length > 0);
    const stderrTail = stderr.split(/\r?\n/).filter(Boolean).slice(-6).join('\n');
    return { ok, status: res.status ?? null, stderrTail, placement, locals, poses };
}

/**
 * Group shim rows (locals or poses) by their exact printed `tKey`. Insertion
 * order is preserved, so the key order matches the shim's emission order (=
 * frame-grid index). Plain object, no Map.
 *
 * @template {{ tKey: string }} T
 * @param {T[]} rows
 * @returns {{ [tKey: string]: T[] }}
 */
export function groupByT(rows) {
    /** @type {{ [tKey: string]: T[] }} */
    const out = {};
    for (const r of rows) {
        const key = r.tKey;
        (out[key] ??= []).push(r);
    }
    return out;
}

/**
 * Max absolute elementwise difference across two equal-length numeric arrays.
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {number}
 */
export function maxDiff(a, b) {
    let d = 0;
    const n = a.length;
    for (let i = 0; i < n; i++) {
        const delta = Math.abs(a[i] - b[i]);
        if (delta > d) d = delta;
    }
    return d;
}

/**
 * Sign-agnostic quaternion diff (q ≡ −q double cover) : the smaller of the
 * direct diff and the diff against the negated quaternion.
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {number}
 */
export function quatDiff(a, b) {
    const n = b.length;
    let dPos = 0;
    let dNeg = 0;
    for (let i = 0; i < n; i++) {
        const bi = b[i];
        const p = Math.abs(a[i] - bi);
        const q = Math.abs(a[i] + bi);
        if (p > dPos) dPos = p;
        if (q > dNeg) dNeg = q;
    }
    return Math.min(dPos, dNeg);
}

/**
 * Minimal skeleton shape this module actually reads — just the bone name +
 * parent chain. The real {@link PoseSkeleton}
 * satisfies it, and so do lightweight test mocks.
 * @typedef {{ bones: Array<{ name?: string, parentIndex: number }> }} PoseSkeleton
 */

/**
 * Depth of a bone in the skeleton (0 for a root). Walks `parentIndex` to the
 * root, capped at bone count so a malformed cyclic chain can't loop forever.
 * @param {PoseSkeleton} skeleton
 * @param {number} boneIndex
 * @returns {number}
 */
export function depthOf(skeleton, boneIndex) {
    const bones = skeleton.bones;
    let depth = 0;
    let i = boneIndex;
    const cap = bones.length;
    while (depth < cap) {
        const parent = bones[i]?.parentIndex ?? -1;
        if (parent < 0 || parent >= i) break;
        i = parent;
        depth++;
    }
    return depth;
}

/**
 * @typedef {object} WorstBone
 * @property {number} bone — bone index.
 * @property {string|null} name — bone name (null when no skeleton passed).
 * @property {number|null} depth — hierarchy depth (null when no skeleton passed).
 * @property {'position'|'orientation'|'scaleShear'} channel — which channel held the worst diff.
 * @property {number} index — element index within that channel.
 * @property {number} js — the JS scalar at that element.
 * @property {number} dll — the DLL scalar at that element.
 * @property {number} diff — |js − dll|.
 */

/** Track the single worst element across a channel, updating `acc` in place.
 * For orientation the caller passes the sign-aligned DLL array (see quatDiff)
 * so the surfaced scalar reflects the double-cover choice. */
function worstIn(acc, channel, jsArr, dllArr, bone) {
    const n = dllArr.length;
    for (let i = 0; i < n; i++) {
        const js = jsArr[i];
        const dll = dllArr[i];
        const d = Math.abs(js - dll);
        if (d > acc.diff) {
            acc.diff = d; acc.channel = channel; acc.index = i;
            acc.js = js; acc.dll = dll; acc.bone = bone;
        }
    }
}

/**
 * Compare ONE poseAt snapshot against the LOCALPOSE lines at that same t.
 * position / scaleShear use {@link maxDiff}; orientation uses sign-agnostic
 * {@link quatDiff}. The worst-bone breakdown surfaces the single largest
 * element so the CLI / test message can name it.
 *
 * @param {import('../../src/GrannyPose.js').PoseSnapshot} snap
 * @param {ReturnType<typeof runPoseShim>['locals']} locals — all bones at one t.
 * @param {PoseSkeleton|null} [skeleton]
 * @returns {{ posMax: number, orientMax: number, scaleMax: number, max: number, worst: WorstBone|null }}
 */
export function compareLocalPose(snap, locals, skeleton = null) {
    let posMax = 0;
    let orientMax = 0;
    let scaleMax = 0;
    /** @type {WorstBone} */
    const worst = { bone: -1, name: null, depth: null, channel: 'position', index: 0, js: 0, dll: 0, diff: -1 };
    for (const l of locals) {
        const js = snap.localTransforms[l.bone];
        if (!js) continue;
        const dPos = maxDiff(js.position, l.position);
        const dOri = quatDiff(js.orientation, l.orientation);
        const dSca = maxDiff(js.scaleShear, l.scaleShear);
        if (dPos > posMax) posMax = dPos;
        if (dOri > orientMax) orientMax = dOri;
        if (dSca > scaleMax) scaleMax = dSca;
        // worst-element tracking (position/scaleShear plain; orientation via
        // the sign that quatDiff chose so the surfaced scalar is meaningful).
        worstIn(worst, 'position', js.position, l.position, l.bone);
        worstIn(worst, 'scaleShear', js.scaleShear, l.scaleShear, l.bone);
        const negated = l.orientation.map((x) => -x);
        const aligned = maxDiff(js.orientation, l.orientation) <= maxDiff(js.orientation, negated)
            ? l.orientation : negated;
        worstIn(worst, 'orientation', js.orientation, aligned, l.bone);
    }
    if (worst.diff > 0 && skeleton) {
        worst.name = skeleton.bones[worst.bone]?.name ?? null;
        worst.depth = depthOf(skeleton, worst.bone);
    }
    return {
        posMax, orientMax, scaleMax,
        max: Math.max(posMax, orientMax, scaleMax),
        worst: worst.diff > 0 ? worst : null,
    };
}

/**
 * @typedef {object} WorstSkinBone
 * @property {number} bone
 * @property {string|null} name
 * @property {number|null} depth
 * @property {number} index — element index within the 16-float matrix.
 * @property {number} js
 * @property {number} dll
 * @property {number} diff
 */

/**
 * Compare `snap.skinningMatrices` (Float32Array(16), col-major) against the
 * POSE `m[16]` lines at one t.
 *
 * @param {import('../../src/GrannyPose.js').PoseSnapshot} snap
 * @param {ReturnType<typeof runPoseShim>['poses']} poses — all bones at one t.
 * @param {PoseSkeleton|null} [skeleton]
 * @returns {{ max: number, worst: WorstSkinBone|null }}
 */
export function compareSkinning(snap, poses, skeleton = null) {
    let max = 0;
    /** @type {WorstSkinBone} */
    const worst = { bone: -1, name: null, depth: null, index: 0, js: 0, dll: 0, diff: -1 };
    for (const p of poses) {
        const js = snap.skinningMatrices[p.bone];
        if (!js) continue;
        for (let i = 0; i < 16; i++) {
            const d = Math.abs(js[i] - p.m[i]);
            if (d > max) max = d;
            if (d > worst.diff) {
                worst.diff = d; worst.index = i; worst.js = js[i]; worst.dll = p.m[i]; worst.bone = p.bone;
            }
        }
    }
    if (worst.diff > 0 && skeleton) {
        worst.name = skeleton.bones[worst.bone]?.name ?? null;
        worst.depth = depthOf(skeleton, worst.bone);
    }
    return { max, worst: worst.diff > 0 ? worst : null };
}

// -------------------------------------------------------------------------
// Per-fixture divergence bounds (measured on the first real 21-fixture 40 Hz
// sweep, session 2). Two DISTINCT divergences the oracle surfaced :
//
//   1. SKINNING — the JS f64 FK cascade vs the DLL's f32 world-pose composite
//      (`_GrannyBuildWorldPose@24`). Grows with bone depth ; worst on the
//      deep humanoid finger chains. Local-pose is (mostly) exact, so this is
//      downstream of the curve evaluator. → session 3 (FK).
//   2. LOCAL-POSE ORIENTATION — the JS curve evaluator's quaternion output vs
//      the DLL's, on a handful of fixtures (7_attack/9_attack marginally,
//      8_dead grossly). Position + scaleShear stay float-exact everywhere
//      (≤1e-6), so ONLY orientation is fenced. This falsifies session 1's
//      "local-pose is exact" premise (it only tested 2 fixtures) and is a
//      SEPARATE root-cause from the FK divergence. → session 3 (curve eval).
//
// Every omitted fixture defaults to the strict 1e-4 tolerance. `measured` is
// the max observed at 40 Hz ; `bound` sits above it with margin so a real
// regression still reds. Nothing is hidden — the CLI/test always name the
// worst bone + measured value even when the relaxed assertion passes.
// -------------------------------------------------------------------------

/** Strict skinning tolerance — every fixture not in {@link SKINNING_BOUNDS}. */
export const DEFAULT_SKINNING_BOUND = 1e-4;

/**
 * Per-fixture RELAXED skinning bounds (divergence 1 above).
 * @type {{ [fixture: string]: { measured: number, bound: number, note: string } }}
 */
export const SKINNING_BOUNDS = {
    '1_attack': { measured: 3.58e-4, bound: 6e-4, note: 'FK depth divergence; session 3' },
    '2_damage': { measured: 5.84e-4, bound: 9e-4, note: 'FK depth divergence; session 3' },
    '7_attack': { measured: 4.55e-3, bound: 7e-3, note: 'FK depth divergence (+ curve-eval, see local); session 3' },
    '7_damage': { measured: 6.48e-4, bound: 1e-3, note: 'FK depth divergence; session 3' },
    '7_dead': { measured: 4.02e-4, bound: 7e-4, note: 'FK depth divergence; session 3' },
    '8_attack': { measured: 1.50e-3, bound: 2.5e-3, note: 'FK depth divergence; session 3' },
    '8_dead': { measured: 1.45e-1, bound: 2e-1, note: 'GROSS — curve-eval orientation error cascades through FK; session 3 priority' },
    '9_attack': { measured: 4.76e-3, bound: 7e-3, note: 'FK depth divergence (+ curve-eval, see local); session 3' },
    '9_damage': { measured: 1.75e-4, bound: 3e-4, note: 'FK depth divergence; session 3' },
    '9_dead': { measured: 3.06e-4, bound: 5e-4, note: 'FK depth divergence; session 3' },
};

/** The skinning tolerance for a fixture (relaxed if listed, else strict). */
export function skinningBoundFor(name) {
    return SKINNING_BOUNDS[name]?.bound ?? DEFAULT_SKINNING_BOUND;
}

/** Strict local-pose orientation tolerance — every fixture not in
 * {@link LOCAL_ORIENT_BOUNDS}. Position + scaleShear are ALWAYS strict 1e-4. */
export const DEFAULT_LOCAL_ORIENT_BOUND = 1e-4;

/**
 * Per-fixture RELAXED local-pose ORIENTATION bounds (divergence 2 above) — the
 * curve evaluator's quaternion output vs the DLL's. Position/scaleShear are not
 * listed because they never diverge (fence stays strict on them).
 * @type {{ [fixture: string]: { measured: number, bound: number, note: string } }}
 */
export const LOCAL_ORIENT_BOUNDS = {
    '7_attack': { measured: 1.13e-4, bound: 2e-4, note: 'curve-eval quaternion, marginal; session 3' },
    '9_attack': { measured: 1.13e-4, bound: 2e-4, note: 'curve-eval quaternion, marginal; session 3' },
    '8_dead': { measured: 3.22e-3, bound: 5e-3, note: 'curve-eval quaternion, GROSS (Bip01 L Forearm w); session 3 priority' },
};

/** The local-pose orientation tolerance for a fixture (relaxed if listed). */
export function localOrientBoundFor(name) {
    return LOCAL_ORIENT_BOUNDS[name]?.bound ?? DEFAULT_LOCAL_ORIENT_BOUND;
}

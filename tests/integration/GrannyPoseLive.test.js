// Integration test : JS Granny.poseAt() world + skinning matrix
// composition vs an independent Python pose composer
// (`scripts/python-pose-oracle.py`), per-bone, elementwise.
//
// Mirrors GrannyModelLive.test.js : env-gated by GRANNY_LIVE_ORACLE=1,
// skips if Python or blendergranny isn't importable, batches all model
// × animation pairings through one Python subprocess for sub-second
// wall-clock. JS-vs-Python matrices must agree to 1e-4 elementwise (the
// S8 plan's matrix-multiply cascade tolerance).

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { parseModel, parseAnimated, poseAt } from '../../src/Granny.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '../..');
const ORACLE_SCRIPT = resolve(PKG_ROOT, 'scripts/python-pose-oracle.py');
const FIXTURE_DIR = resolve(PKG_ROOT, 'tests/fixtures/source');

const liveMode = process.env.GRANNY_LIVE_ORACLE === '1';
const haveOracle = existsSync(ORACLE_SCRIPT);

// Model fixtures (column 0) paired with their matching animation fixtures
// by mob ID prefix (column 1). Animations are sampled at duration/2 ;
// the JS test reads `animation.duration` from a sibling parseAnimated
// call to pick the same `t` as the Python oracle.
const PAIRINGS = [
    { model: 'treasurebox_2.gr2', animations: ['2_damage.gr2', '2_dead.gr2'] },
    { model: 'guildflag90_1.gr2', animations: ['1_attack.gr2'] },
    { model: 'aguardian90_8.gr2', animations: ['8_attack.gr2', '8_damage.gr2', '8_dead.gr2', '8_move.gr2'] },
    { model: 'kguardian90_7.gr2', animations: ['7_attack.gr2', '7_damage.gr2', '7_dead.gr2', '7_move.gr2'] },
    { model: 'sguardian90_9.gr2', animations: ['9_attack.gr2', '9_damage.gr2', '9_dead.gr2', '9_move.gr2'] },
    { model: 'empelium90_0.gr2', animations: [] },  // No animations in the corpus.
];

/** Probe whether the Python oracle is runnable. Degrade-to-skip when not. */
function probeOracle() {
    if (!haveOracle) return { ok: false, reason: 'oracle script missing' };
    const proc = spawnSync('python3', [
        '-c',
        'import sys; import os; sys.path.insert(0, os.environ.get("BLENDERGRANNY_PATH") or os.path.expanduser("~/.cache/granny-ro-js/blendergranny")); from io_scene_gr2.gr2.skeleton import extract_skeletons; from io_scene_gr2.gr2.animation import extract_animation_set',
    ], { encoding: 'utf8' });
    if (proc.status !== 0) {
        return { ok: false, reason: `blendergranny import failed : ${(proc.stderr || '').trim()}` };
    }
    return { ok: true };
}

const probe = liveMode ? probeOracle() : { ok: false, reason: 'GRANNY_LIVE_ORACLE not set' };

/** Read an animation file once to grab `animation.duration` ; sample at
 *  duration/2 (mid-anim — most likely to be far from rest pose). */
function pickSampleTime(animationPath) {
    const buf = readFileSync(animationPath);
    const { animations } = parseAnimated(buf);
    if (!animations || animations.length === 0) return 0;
    const duration = animations[0].duration;
    return duration > 0 ? duration * 0.5 : 0;
}

function buildCases() {
    const cases = [];
    for (const pairing of PAIRINGS) {
        const modelPath = resolve(FIXTURE_DIR, pairing.model);
        if (!existsSync(modelPath)) continue;
        // Bind-pose case : every model gets one bind-pose snapshot
        // (animation = `-`) to cover the rest-pose math path even when
        // no animation pairing exists (empelium).
        cases.push({
            label: `${pairing.model} @ bind`,
            model: pairing.model,
            animation: null,
            t: 0,
        });
        for (const animName of pairing.animations) {
            const animPath = resolve(FIXTURE_DIR, animName);
            if (!existsSync(animPath)) continue;
            const t = pickSampleTime(animPath);
            cases.push({
                label: `${pairing.model} @ ${animName} t=${t.toFixed(4)}`,
                model: pairing.model,
                animation: animName,
                t,
            });
        }
    }
    return cases;
}

const cases = liveMode ? buildCases() : [];

/** Spawn python3 once for all cases ; parse JSON-Lines. */
function runOracle(triples) {
    const proc = spawnSync('python3', [ORACLE_SCRIPT, FIXTURE_DIR, ...triples], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
    });
    if (proc.status !== 0) {
        return { ok: false, error: proc.stderr || proc.stdout, snapshots: null };
    }
    const lines = proc.stdout.split('\n').filter((l) => l.trim().length > 0);
    const snapshots = lines.map((line) => JSON.parse(line));
    return { ok: true, error: null, snapshots };
}

/** Build the JS-side pose snapshot in the same shape as the Python
 *  oracle for a single (model, animation, t) case. */
function jsSnapshot(modelName, animationName, t) {
    const modelBuf = readFileSync(resolve(FIXTURE_DIR, modelName));
    /** @type {any} */
    const parsed = parseModel(modelBuf);
    if (animationName) {
        const animBuf = readFileSync(resolve(FIXTURE_DIR, animationName));
        const animated = parseAnimated(animBuf);
        parsed.animations = animated.animations;
    } else {
        parsed.animations = [];
    }
    const pose = poseAt(parsed, 0, t);
    const skeleton = parsed.skeletons[0];
    return skeleton.bones.map((bone, i) => ({
        name: bone.name,
        parent_index: bone.parentIndex,
        world_matrix: Array.from(pose.worldMatrices[i]),
        skinning_matrix: Array.from(pose.skinningMatrices[i]),
    }));
}

/** Compare two flat 16-float matrices elementwise to a tolerance ; on
 *  the first violation, throw with the bone name + numerical context. */
function expectMatrixCloseTo(label, kind, actual, expected, tolerance) {
    for (let i = 0; i < expected.length; i++) {
        const diff = Math.abs(actual[i] - expected[i]);
        if (!Number.isFinite(diff) || diff > tolerance) {
            throw new Error(
                `${label} → ${kind} mismatch at index ${i}: js=${actual[i]} py=${expected[i]} ` +
                `(diff ${diff} > ${tolerance})`
            );
        }
    }
}

describe.skipIf(!liveMode || !probe.ok)(
    `Granny.poseAt — Python oracle parity (${liveMode ? probe.reason ?? 'enabled' : probe.reason})`,
    () => {
        /** @type {Map<string, any>} */
        let snapshotsByLabel;
        // 60-second hook : pure-Python blendergranny + 4×4 matmul for ~20
        // cases × ~40 bones runs in ~12 s on a warm devcontainer ; the
        // ceiling is generous to absorb cold-cache startup.
        beforeAll(() => {
            if (cases.length === 0) {
                snapshotsByLabel = new Map();
                return;
            }
            const triples = cases.map((c) => `${c.model}:${c.animation ?? '-'}:${c.t}`);
            const result = runOracle(triples);
            if (!result.ok) {
                throw new Error(`Python oracle failed : ${result.error}`);
            }
            snapshotsByLabel = new Map();
            for (let i = 0; i < cases.length; i++) {
                snapshotsByLabel.set(cases[i].label, result.snapshots[i]);
            }
        }, 60_000);

        for (const testCase of cases) {
            it(`${testCase.label} — every bone matches Python within 1e-4`, () => {
                const pySnap = snapshotsByLabel.get(testCase.label);
                expect(pySnap, `oracle snapshot missing for ${testCase.label}`).toBeDefined();
                const jsBones = jsSnapshot(testCase.model, testCase.animation, testCase.t);
                expect(jsBones.length).toBe(pySnap.bones.length);
                for (let i = 0; i < jsBones.length; i++) {
                    const jsBone = jsBones[i];
                    const pyBone = pySnap.bones[i];
                    expect(jsBone.name).toBe(pyBone.name);
                    expect(jsBone.parent_index).toBe(pyBone.parent_index);
                    expectMatrixCloseTo(
                        `${testCase.label} bone ${i} (${jsBone.name})`,
                        'world',
                        jsBone.world_matrix,
                        pyBone.world_matrix,
                        1e-4,
                    );
                    expectMatrixCloseTo(
                        `${testCase.label} bone ${i} (${jsBone.name})`,
                        'skinning',
                        jsBone.skinning_matrix,
                        pyBone.skinning_matrix,
                        1e-4,
                    );
                }
            });
        }
    },
);

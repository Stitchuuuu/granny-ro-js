// Integration test : JS Granny.parseAnimated() animation extraction vs
// Rasetsuu/blendergranny (Python clean-room reference) field-by-field.
//
// Mirrors GrannyModelLive.test.js : env-gated by GRANNY_LIVE_ORACLE=1,
// skips if Python or blendergranny isn't importable, batches all 21
// fixtures through one Python subprocess for sub-second wall-clock.

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { parseAnimated } from '../../src/Granny.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '../..');
const ORACLE_SCRIPT = resolve(PKG_ROOT, 'scripts/python-animation-oracle.py');
const MANIFEST_PATH = resolve(PKG_ROOT, 'tests/fixtures/manifest.json');
const FIXTURE_DIR = resolve(PKG_ROOT, 'tests/fixtures/source');

const liveMode = process.env.GRANNY_LIVE_ORACLE === '1';
const haveManifest = existsSync(MANIFEST_PATH);
const haveOracle = existsSync(ORACLE_SCRIPT);

const manifest = haveManifest
    ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    : { fixtures: [], fixture_count: 0 };

function runOracle(fixturePaths) {
    const proc = spawnSync('python3', [ORACLE_SCRIPT, ...fixturePaths], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
    if (proc.status !== 0) {
        return { ok: false, error: proc.stderr || proc.stdout, snapshots: null };
    }
    const lines = proc.stdout.split('\n').filter((l) => l.trim().length > 0);
    const snapshots = {};
    for (const line of lines) {
        const obj = JSON.parse(line);
        snapshots[obj.file] = obj;
    }
    return { ok: true, error: null, snapshots };
}

function roundFloat(value) {
    if (value === null || value === undefined) return value;
    return Number(value.toFixed(5));
}

function roundArray(values) {
    if (!values) return values;
    return Array.from(values, roundFloat);
}

function jsCurveSnapshot(curve, t) {
    if (!curve) return null;
    return {
        codec: curve.codec,
        format: curve.format,
        degree: curve.degree,
        dimension: curve.dimension,
        knot_control_count: curve.knotControlCount,
        knot_count: curve.knots.length,
        first_knot: curve.knots.length > 0 ? roundFloat(curve.knots[0]) : null,
        last_knot: curve.knots.length > 0 ? roundFloat(curve.knots[curve.knots.length - 1]) : null,
        sample_value: roundArray(curve.sampleValue),
        evaluated: roundArray(evaluateCurveStandalone(curve, t)),
    };
}

// Stand-alone curve evaluator for parity testing : returns a plain
// number[] (matches Python tuple shape). Mirrors evaluateCurve but at
// the per-curve granularity needed for the oracle diff.
function evaluateCurveStandalone(curve, t) {
    if (curve.knots.length === 0 || curve.controls.length === 0) {
        if (curve.sampleValue.length > 0) return Array.from(curve.sampleValue);
        return [];
    }
    // Re-use the public TransformTrack evaluator with a synthetic track
    // (one curve at a time, all 3 set to the same curve for the dim
    // we're sampling — we only read back the dim we care about).
    // Simpler : re-implement the few-line linear B-spline blend here so
    // we exercise the same code path the live-oracle parity needs.
    const knots = curve.knots;
    const controls = curve.controls;
    const dim = curve.dimension;
    let knotIndex = -1;
    for (let i = 0; i < knots.length; i++) {
        if (knots[i] > t) { knotIndex = i; break; }
    }
    if (knotIndex === -1) knotIndex = knots.length - 1;
    const degree = curve.degree | 0;
    if (degree === 0 || knots.length === 1) {
        const idx = knotIndex < (controls.length / dim) ? knotIndex : (controls.length / dim) - 1;
        const out = new Array(dim);
        for (let d = 0; d < dim; d++) out[d] = controls[idx * dim + d];
        return out;
    }
    const window = 2 * degree;
    const base = knotIndex - degree;
    const ti = new Array(window);
    const pi = new Array(window);
    const knotCount = knots.length;
    for (let local = 0; local < window; local++) {
        let source = base + local;
        if (source < 0) source = 0;
        if (source > knotCount - 1) source = knotCount - 1;
        ti[local] = knots[source];
        const ctrlIdx = source;
        const cp = new Array(dim);
        for (let d = 0; d < dim; d++) cp[d] = controls[ctrlIdx * dim + d];
        pi[local] = cp;
    }
    const center = degree;
    let result;
    function safeDiv(n, d) { return Math.abs(d) < 1e-12 ? 0 : n / d; }
    if (degree === 1) {
        const blend = safeDiv(t - ti[center - 1], ti[center] - ti[center - 1]);
        const cPrev = 1 - blend, cCurr = blend;
        result = new Array(dim);
        for (let d = 0; d < dim; d++) result[d] = cPrev * pi[center - 1][d] + cCurr * pi[center][d];
    } else if (degree === 2) {
        const l0 = safeDiv(t - ti[center - 1], ti[center] - ti[center - 1]);
        const l1_1 = safeDiv(t - ti[center - 2], ti[center] - ti[center - 2]);
        const l1_2 = safeDiv(t - ti[center - 1], ti[center + 1] - ti[center - 1]);
        const ci2PlusCi1 = (l1_1 + l0) - l0 * l1_1;
        const ci = l0 * l1_2;
        const ci_1 = ci2PlusCi1 - ci;
        const ci_2 = 1 - ci2PlusCi1;
        result = new Array(dim);
        for (let d = 0; d < dim; d++) {
            result[d] = ci_2 * pi[center - 2][d] + ci_1 * pi[center - 1][d] + ci * pi[center][d];
        }
    } else {
        result = pi[center];
    }
    if (dim === 4) {
        const x = result[0], y = result[1], z = result[2], w = result[3];
        const lengthSq = x * x + y * y + z * z + w * w;
        if (lengthSq > 0) {
            const inv = 1 / Math.sqrt(lengthSq);
            result = [x * inv, y * inv, z * inv, w * inv];
        }
    }
    return result;
}

function jsSnapshot(name, buffer) {
    const { animations } = parseAnimated(buffer);
    // Sample t = duration/2 of the first animation, matching the
    // Python oracle's convention. If there are no animations, t=0.
    const sampleT = animations.length > 0 && animations[0].duration > 0
        ? animations[0].duration * 0.5
        : 0.0;

    // Build a unique TrackGroup list (by index) — the JS API resolves
    // each animation's trackGroups list, possibly duplicating, so we
    // dedupe via the index field to match the python oracle's flat list.
    const groupByIndex = Object.create(null);
    for (const animation of animations) {
        for (const group of animation.trackGroups) {
            if (!(group.index in groupByIndex)) groupByIndex[group.index] = group;
        }
    }
    const trackGroups = Object.keys(groupByIndex)
        .map((k) => Number(k))
        .sort((a, b) => a - b)
        .map((k) => groupByIndex[k]);

    return {
        file: name,
        animations: animations.map((animation) => ({
            name: animation.name,
            duration: roundFloat(animation.duration),
            time_step: roundFloat(animation.timeStep),
            oversampling: roundFloat(animation.oversampling),
            default_loop_count: animation.defaultLoopCount,
            flags: animation.flags,
            track_group_names: [...animation.trackGroupNames],
        })),
        track_groups: trackGroups.map((group) => ({
            name: group.name,
            transform_track_count: group.transformTrackCount,
            text_track_count: group.textTrackCount,
            vector_track_count: group.vectorTrackCount,
            accumulation_flags: group.accumulationFlags,
            loop_translation: roundFloat(group.loopTranslation),
            transform_tracks: group.transformTracks.map((track) => ({
                name: track.name,
                flags: track.flags,
                orientation: jsCurveSnapshot(track.orientationCurve, sampleT),
                position: jsCurveSnapshot(track.positionCurve, sampleT),
                scale_shear: jsCurveSnapshot(track.scaleShearCurve, sampleT),
            })),
        })),
        sample_t: roundFloat(sampleT),
    };
}

function normalizePythonSnapshot(snap) {
    const round = roundFloat;
    function normalizeCurve(curve) {
        if (curve === null || curve === undefined) return null;
        return {
            codec: curve.codec,
            format: curve.format,
            degree: curve.degree,
            dimension: curve.dimension,
            knot_control_count: curve.knot_control_count,
            knot_count: curve.knot_count,
            first_knot: curve.first_knot === null ? null : round(curve.first_knot),
            last_knot: curve.last_knot === null ? null : round(curve.last_knot),
            sample_value: roundArray(curve.sample_value),
            evaluated: roundArray(curve.evaluated),
        };
    }
    return {
        file: snap.file,
        animations: snap.animations.map((animation) => ({
            name: animation.name,
            duration: round(animation.duration),
            time_step: round(animation.time_step),
            oversampling: round(animation.oversampling),
            default_loop_count: animation.default_loop_count,
            flags: animation.flags,
            track_group_names: animation.track_group_names,
        })),
        track_groups: snap.track_groups.map((group) => ({
            name: group.name,
            transform_track_count: group.transform_track_count,
            text_track_count: group.text_track_count,
            vector_track_count: group.vector_track_count,
            accumulation_flags: group.accumulation_flags,
            loop_translation: round(group.loop_translation),
            transform_tracks: group.transform_tracks.map((track) => ({
                name: track.name,
                flags: track.flags,
                orientation: normalizeCurve(track.orientation),
                position: normalizeCurve(track.position),
                scale_shear: normalizeCurve(track.scale_shear),
            })),
        })),
        sample_t: round(snap.sample_t),
    };
}

function probeOracle() {
    if (!haveOracle) return { ok: false, reason: 'oracle script missing' };
    const proc = spawnSync('python3', [
        '-c',
        'import sys; sys.path.insert(0, "/tmp/granny-audit/blendergranny"); from io_scene_gr2.gr2.animation import extract_animation_set, _evaluate_curve',
    ], { encoding: 'utf8' });
    if (proc.status !== 0) {
        return { ok: false, reason: `blendergranny import failed : ${(proc.stderr || '').trim()}` };
    }
    return { ok: true };
}

const probe = liveMode && haveManifest ? probeOracle() : { ok: false, reason: 'live mode disabled' };

describe.skipIf(!liveMode || !haveManifest || !probe.ok)(
    `Granny.parseAnimated — Python blendergranny oracle parity (${liveMode ? probe.reason ?? 'enabled' : 'GRANNY_LIVE_ORACLE not set'})`,
    () => {
        /** @type {Record<string, any>} */
        let pyByName;
        beforeAll(() => {
            const paths = manifest.fixtures.map((f) => resolve(FIXTURE_DIR, f.name));
            const result = runOracle(paths);
            if (!result.ok) {
                throw new Error(`Python oracle failed : ${result.error}`);
            }
            pyByName = result.snapshots;
        });

        for (const fixture of manifest.fixtures) {
            it(`${fixture.name} — JS vs Python field-by-field`, () => {
                const pyRaw = pyByName[fixture.name];
                expect(pyRaw, `oracle missing snapshot for ${fixture.name}`).toBeDefined();
                const buf = readFileSync(resolve(FIXTURE_DIR, fixture.name));
                const js = jsSnapshot(fixture.name, buf);
                const py = normalizePythonSnapshot(pyRaw);
                expect(js).toEqual(py);
            });
        }
    },
);

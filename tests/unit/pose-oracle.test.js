/**
 * tests/unit/pose-oracle.test.js — wine-free unit tests for the oracle lib
 * (scripts/lib/pose-oracle.mjs). Exercises the pure comparison/grid logic on
 * hand-built inputs, so it runs everywhere (no wine, no fixtures, CI-safe).
 *
 * The wine-gated numeric assertions against the real granny2.dll live in
 * tests/integration/worldpose-oracle.test.js.
 */

import { describe, it, expect } from 'vitest';
import {
    frameGrid,
    groupByT,
    maxDiff,
    quatDiff,
    depthOf,
    compareLocalPose,
    compareSkinning,
    skinningBoundFor,
    localOrientBoundFor,
    DEFAULT_SKINNING_BOUND,
    DEFAULT_LOCAL_ORIENT_BOUND,
} from '../../scripts/lib/pose-oracle.mjs';

describe('frameGrid', () => {
    it('1 s @ 40 Hz → 41 samples, endpoints exact', () => {
        const { samples, times } = frameGrid(1, 40);
        expect(samples).toBe(41);
        expect(times).toHaveLength(41);
        expect(times[0]).toBe(0);
        expect(times[40]).toBe(1); // endpoint pinned to exactly duration
    });

    it('stays within [0, duration] and is strictly monotonic', () => {
        const { times } = frameGrid(2.5, 40);
        for (let i = 0; i < times.length; i++) {
            expect(times[i]).toBeGreaterThanOrEqual(0);
            expect(times[i]).toBeLessThanOrEqual(2.5);
            if (i > 0) expect(times[i]).toBeGreaterThan(times[i - 1]);
        }
        expect(times[times.length - 1]).toBe(2.5);
    });

    it('zero / negative duration collapses to a single t=0 sample', () => {
        expect(frameGrid(0)).toEqual({ samples: 1, times: [0] });
        expect(frameGrid(-1)).toEqual({ samples: 1, times: [0] });
    });

    it('honours a non-default hz', () => {
        const { samples } = frameGrid(1, 30);
        expect(samples).toBe(31); // round(1*30)+1
    });
});

describe('maxDiff', () => {
    it('is the max absolute elementwise difference', () => {
        expect(maxDiff([1, 2, 3], [1, 2, 3])).toBe(0);
        expect(maxDiff([1, 2, 3], [1.5, 2, 0])).toBeCloseTo(3, 10);
    });
});

describe('quatDiff (sign-agnostic)', () => {
    it('treats q and −q as identical (double cover)', () => {
        expect(quatDiff([0, 0, 0, 1], [0, 0, 0, -1])).toBe(0);
        expect(quatDiff([0.1, 0.2, 0.3, 0.9], [-0.1, -0.2, -0.3, -0.9])).toBeCloseTo(0, 12);
    });
    it('is positive for genuinely different orientations', () => {
        expect(quatDiff([1, 0, 0, 0], [0, 1, 0, 0])).toBeGreaterThan(0);
    });
    it('reduces to the plain diff when the direct sign is closer', () => {
        // a small real delta on an otherwise-aligned quat → same sign wins
        expect(quatDiff([0, 0, 0, 1], [0, 0, 0, 1.0003])).toBeCloseTo(3e-4, 9);
    });
});

describe('groupByT', () => {
    it('groups rows by tKey preserving emission order', () => {
        const rows = [
            { tKey: '0', v: 'a' },
            { tKey: '0', v: 'b' },
            { tKey: '0.025', v: 'c' },
        ];
        const g = groupByT(rows);
        expect(Object.keys(g)).toEqual(['0', '0.025']);
        expect(g['0']).toHaveLength(2);
        expect(g['0.025']).toHaveLength(1);
    });
});

describe('depthOf', () => {
    const skeleton = {
        bones: [
            { name: 'root', parentIndex: -1 },
            { name: 'spine', parentIndex: 0 },
            { name: 'arm', parentIndex: 1 },
            { name: 'hand', parentIndex: 2 },
        ],
    };
    it('counts hierarchy depth (root = 0)', () => {
        expect(depthOf(skeleton, 0)).toBe(0);
        expect(depthOf(skeleton, 1)).toBe(1);
        expect(depthOf(skeleton, 3)).toBe(3);
    });
});

/** Build a minimal PoseSnapshot with one bone's local transform. */
function snapWith(local, skin) {
    return {
        localTransforms: [local],
        worldMatrices: [],
        skinningMatrices: [skin ?? new Float32Array(16)],
    };
}
const IDENT_LOCAL = {
    position: [0, 0, 0],
    orientation: [0, 0, 0, 1],
    scaleShear: [1, 0, 0, 0, 1, 0, 0, 0, 1],
};
function localLine(over = {}) {
    return {
        t: 0, tKey: '0', bone: 0, flags: 0,
        position: [0, 0, 0],
        orientation: [0, 0, 0, 1],
        scaleShear: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        ...over,
    };
}

describe('compareLocalPose', () => {
    it('exact match → all maxes 0, worst null', () => {
        const r = compareLocalPose(snapWith(IDENT_LOCAL), [localLine()]);
        expect(r.posMax).toBe(0);
        expect(r.orientMax).toBe(0);
        expect(r.scaleMax).toBe(0);
        expect(r.max).toBe(0);
        expect(r.worst).toBeNull();
    });

    it('quaternion sign-flip is absorbed (orientMax ≈ 0)', () => {
        const r = compareLocalPose(snapWith(IDENT_LOCAL), [localLine({ orientation: [0, 0, 0, -1] })]);
        expect(r.orientMax).toBeCloseTo(0, 12);
    });

    it('a real position delta is the worst channel with correct index/js/dll', () => {
        const js = { ...IDENT_LOCAL, position: [0, 0, 5e-4] };
        const r = compareLocalPose(snapWith(js), [localLine()], {
            bones: [{ name: 'b0', parentIndex: -1 }],
        });
        expect(r.posMax).toBeCloseTo(5e-4, 9);
        expect(r.worst).not.toBeNull();
        expect(r.worst.channel).toBe('position');
        expect(r.worst.index).toBe(2);
        expect(r.worst.js).toBeCloseTo(5e-4, 9);
        expect(r.worst.dll).toBe(0);
        expect(r.worst.name).toBe('b0');
        expect(r.worst.depth).toBe(0);
    });
});

describe('compareSkinning', () => {
    it('surfaces the single worst matrix element', () => {
        const js = new Float32Array(16);
        js[12] = 2e-3; // one translation element off by 2e-3
        const snap = snapWith(IDENT_LOCAL, js);
        const dll = { t: 0, tKey: '0', bone: 0, m: new Array(16).fill(0) };
        const r = compareSkinning(snap, [dll]);
        expect(r.max).toBeCloseTo(2e-3, 9);
        expect(r.worst.index).toBe(12);
        expect(r.worst.diff).toBeCloseTo(2e-3, 9);
    });
});

describe('skinningBoundFor', () => {
    it('is strict for shallow fixtures, relaxed for the divergent ones', () => {
        expect(skinningBoundFor('guildflag90_1')).toBe(DEFAULT_SKINNING_BOUND);
        expect(skinningBoundFor('7_attack')).toBeGreaterThan(DEFAULT_SKINNING_BOUND);
        expect(skinningBoundFor('8_dead')).toBeGreaterThan(DEFAULT_SKINNING_BOUND);
    });
});

describe('localOrientBoundFor', () => {
    it('is strict except for the curve-eval quaternion outliers', () => {
        expect(localOrientBoundFor('guildflag90_1')).toBe(DEFAULT_LOCAL_ORIENT_BOUND);
        expect(localOrientBoundFor('2_dead')).toBe(DEFAULT_LOCAL_ORIENT_BOUND);
        expect(localOrientBoundFor('8_dead')).toBeGreaterThan(DEFAULT_LOCAL_ORIENT_BOUND);
        expect(localOrientBoundFor('7_attack')).toBeGreaterThan(DEFAULT_LOCAL_ORIENT_BOUND);
    });
});

#!/usr/bin/env node
/**
 * setup-blendergranny.mjs — idempotent clone of Rasetsuu/blendergranny,
 * the clean-room Python decoder we use as a third validation oracle in
 * the live-test path (`npm run test:live`).
 *
 * Reads BLENDERGRANNY_PATH from env. If the path doesn't exist OR the
 * importable `io_scene_gr2/gr2/skeleton.py` module is missing, performs
 * a shallow git clone. Otherwise no-ops.
 *
 * Called as a sub-task by `bake-all.mjs`'s `ensureBlendergranny()` and
 * directly by `npm run setup:oracle`. Inside Docker, the image already
 * ships a pinned blendergranny clone at the configured path, so this
 * script is effectively a no-op there.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const BLENDERGRANNY_PATH = process.env.BLENDERGRANNY_PATH;
const BLENDERGRANNY_REPO = 'https://github.com/Rasetsuu/blendergranny';
const PROBE = 'io_scene_gr2/gr2/skeleton.py';

if (!BLENDERGRANNY_PATH) {
    console.error(
        '[setup:oracle] missing BLENDERGRANNY_PATH env var. ' +
        'Set it in .env (or your shell) to the local checkout target. ' +
        'See .env.example for the contract.'
    );
    process.exit(1);
}

if (existsSync(`${BLENDERGRANNY_PATH}/${PROBE}`)) {
    console.error('[setup:oracle] blendergranny already present at', BLENDERGRANNY_PATH);
    process.exit(0);
}

console.error('[setup:oracle] cloning', BLENDERGRANNY_REPO, '→', BLENDERGRANNY_PATH);
mkdirSync(dirname(BLENDERGRANNY_PATH), { recursive: true });
execFileSync(
    'git',
    ['clone', '--depth=1', '--branch=main', BLENDERGRANNY_REPO, BLENDERGRANNY_PATH],
    { stdio: 'inherit' },
);
console.error('[setup:oracle] done');

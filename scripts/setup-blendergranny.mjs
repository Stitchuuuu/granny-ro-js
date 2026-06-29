#!/usr/bin/env node
/**
 * setup-blendergranny.mjs — idempotent clone of Rasetsuu/blendergranny,
 * the clean-room Python decoder we use as a third validation oracle in
 * the live-test path (`npm run test:live`).
 *
 * Reads BLENDERGRANNY_PATH from env, or falls back to
 * `~/.cache/granny-ro-js/blendergranny` (per-user cache, survives repo
 * cleanup, doesn't pollute the working tree). If the path doesn't exist
 * OR the importable `io_scene_gr2/gr2/skeleton.py` module is missing,
 * performs a shallow git clone. Otherwise no-ops.
 *
 * Inside Docker, the image already ships a pinned blendergranny clone
 * and sets BLENDERGRANNY_PATH=/blendergranny via the Dockerfile ENV, so
 * this script no-ops there.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_BLENDERGRANNY_PATH = join(
    homedir(),
    '.cache',
    'granny-ro-js',
    'blendergranny',
);

const BLENDERGRANNY_PATH = process.env.BLENDERGRANNY_PATH || DEFAULT_BLENDERGRANNY_PATH;
const BLENDERGRANNY_REPO = 'https://github.com/Rasetsuu/blendergranny';
const PROBE = 'io_scene_gr2/gr2/skeleton.py';

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

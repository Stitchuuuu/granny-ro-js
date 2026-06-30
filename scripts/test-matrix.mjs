#!/usr/bin/env node
/**
 * test-matrix.mjs — content-addressed parity matrix orchestrator.
 *
 * Runs the available checks for the current host and prints a per-target
 * green / red / skipped table. The JS-only contract is always run first
 * (it gates `1.0.0` ship) ; per-target rebake artifacts are verified
 * when present in `tests/fixtures/rebake-fresh/<target>/`.
 *
 * Layout :
 *   1. JS port vs committed manifest      (always, no wine)
 *   2. Rebake-fresh/container/manifest    (if present)
 *   3. Rebake-fresh/macos-host/manifest   (if present)
 *   4. Rebake-fresh/windows-host/manifest (if present)
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const REBAKE_ROOT = resolve(PKG_ROOT, 'tests/fixtures/rebake-fresh');
const TARGETS = ['container', 'macos-host', 'windows-host'];

/**
 * Run a child node script + return `{ status, stdout, stderr }`.
 *
 * @param {string} script absolute path to the script
 * @param {string[]} args CLI args to forward
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function run(script, args) {
    const r = spawnSync('node', [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    return {
        status: r.status ?? 1,
        stdout: r.stdout?.toString() ?? '',
        stderr: r.stderr?.toString() ?? '',
    };
}

function main() {
    const rows = [];

    // 1. JS-only contract.
    const js = run(resolve(__dirname, 'test-js.mjs'), ['--quiet']);
    rows.push({ name: 'test:js (committed manifest)', status: js.status });
    if (js.status !== 0) {
        process.stderr.write(js.stderr);
    }

    // 2–4. Per-target rebake verification.
    for (const target of TARGETS) {
        const artifact = join(REBAKE_ROOT, target, 'manifest.json');
        if (!existsSync(artifact)) {
            rows.push({ name: `rebake:${target}`, status: 'skipped' });
            continue;
        }
        const v = run(resolve(__dirname, 'verify-rebake.mjs'), ['--target', target]);
        rows.push({ name: `rebake:${target}`, status: v.status });
        if (v.status !== 0) {
            process.stderr.write(v.stderr);
        }
    }

    let anyFail = false;
    console.log();
    console.log('Target                              Status');
    console.log('─────────────────────────────────── ──────');
    for (const row of rows) {
        const symbol = row.status === 0 ? '✓ pass'
                     : row.status === 'skipped' ? '⊘ skip'
                     : '✗ FAIL';
        if (row.status !== 0 && row.status !== 'skipped') anyFail = true;
        console.log(row.name.padEnd(35), symbol);
    }
    console.log();
    process.exit(anyFail ? 1 : 0);
}

main();

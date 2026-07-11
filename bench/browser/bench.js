// bench.js — real-browser full-load bench for granny-ro-js.
//
// Times the whole consumer flow a web caller pays — `parseTextured` (parse +
// skeleton + mesh + decode every IGC texture) — over a real `.gr2` corpus
// (staged by `npm run bench:browser` from GR2_FOLDER), cold + warm, in a real
// browser (Node V8 ≠ browser : instantiation, GC, main-thread limits only
// show up here). Methodology mirrors scripts/perf-load.mjs : 1 cold call
// (recorded on its own) + N warm → mean / p50 / p95 / best.
//
// Two axes, apples-to-apples on the SAME single-file build :
//   · main   — decode on the main thread (what blocks the render loop)
//   · worker — decode in a module Worker (like roBrowser), main thread free
// The Worker isn't a faster kernel (same JIT) ; its value is that the main
// thread stays responsive during decode — quantified by the frame-gap
// "max main-thread stall" metric (the hitch a user would feel).
//
// The WASM-port rollout appends wasm axes (`./granny-ro.wasm.esm.js`, main +
// worker) ; the per-axis loop renders them with zero refactor, and the
// `await mod.Granny.ready()` instantiation cost (≈ 0 for pure JS) is timed
// separately so the WASM row's real cost is isolated.

const BUILD_URL = './granny-ro.esm.js';
const WASM_URL = './granny-ro.wasm.esm.js';
const AXES = [
    { label: 'js-esm · main', url: BUILD_URL, mode: 'main' },
    { label: 'js-esm · worker', url: BUILD_URL, mode: 'worker' },
    // WASM build : `await Granny.ready()` instantiation cost is timed
    // separately (readyMs). Session 1 runs only yuvToRGB in WASM (arith / iDWT
    // still JS + a boundary copy per decode) — a machinery smoke, not the perf
    // verdict ; that lands when the whole pipeline is WASM.
    { label: 'wasm-esm · main', url: WASM_URL, mode: 'main' },
    { label: 'wasm-esm · worker', url: WASM_URL, mode: 'worker' },
];

// Warm iterations per fixture. Override with ?warm=N for a quicker pass.
const WARM_ITERS = Math.max(1, parseInt(new URLSearchParams(location.search).get('warm') ?? '20', 10));

// ---- stats (nearest-rank, identical to perf-load.mjs:81-87) --------------
function stats(samples) {
    const sorted = [...samples].sort((a, b) => a - b);
    const n = sorted.length;
    const mean = samples.reduce((s, x) => s + x, 0) / n;
    const rank = (p) => sorted[Math.min(n - 1, Math.ceil((p / 100) * n) - 1)];
    return { mean, p50: rank(50), p95: rank(95), best: sorted[0] };
}
const throughput = (bytes, ms) => (bytes / (1024 * 1024) / (ms / 1000)).toFixed(1);
const kb = (b) => (b / 1024).toFixed(1);
const ms = (v) => v.toFixed(2);

// ---- frame-gap monitor : longest main-thread stall = the render hitch -----
// rAF callbacks don't fire while the main thread is busy ; the biggest gap
// between frames during an axis is the worst hitch a user would feel. A
// main-thread decode loop stalls for the whole decode ; a Worker axis lets
// rAF keep ticking (~16 ms).
class StallMonitor {
    constructor() {
        this.max = 0;
        this.last = performance.now();
        this.running = false;
        this._tick = this._tick.bind(this);
    }
    start() {
        this.running = true;
        this.last = performance.now();
        requestAnimationFrame(this._tick);
    }
    stop() {
        this.running = false;
    }
    reset() {
        this.max = 0;
        this.last = performance.now();
    }
    _tick(now) {
        const gap = now - this.last;
        if (gap > this.max) this.max = gap;
        this.last = now;
        if (this.running) requestAnimationFrame(this._tick);
    }
}
const stall = new StallMonitor();

const yieldToLoop = () => new Promise((r) => setTimeout(r, 0));

// ---- DOM helpers ---------------------------------------------------------
const $status = () => document.getElementById('status');
const $results = () => document.getElementById('results');
const setStatus = (text) => ($status().textContent = text);

function renderAxisTable(axis, readyMs, stallMs, rows) {
    const section = document.createElement('section');
    const h = document.createElement('h2');
    h.textContent = `${axis.label} — ready() ${ms(readyMs)} ms · max main-thread stall ${ms(stallMs)} ms · ${WARM_ITERS} warm iters`;
    section.appendChild(h);

    const table = document.createElement('table');
    const headers = ['fixture', 'kind', 'in KB', 'cold ms', 'warm mean', 'warm p50', 'warm p95', 'warm best', 'MB/s'];
    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    for (const label of headers) {
        const th = document.createElement('th');
        th.textContent = label;
        htr.appendChild(th);
    }
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const addRow = (cells, cls) => {
        const tr = document.createElement('tr');
        if (cls) tr.className = cls;
        cells.forEach((c, i) => {
            const td = document.createElement('td');
            td.textContent = c;
            if (i >= 2) td.className = 'num';
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    };

    const ok = rows.filter((r) => !r.error);
    for (const r of rows) {
        if (r.error) {
            addRow([r.path, 'ERR', kb(r.bytes), r.error, '', '', '', '', ''], 'err');
        } else {
            addRow([r.path, r.kind, kb(r.bytes), ms(r.cold), ms(r.mean), ms(r.p50), ms(r.p95), ms(r.best), throughput(r.bytes, r.best)]);
        }
    }
    const totBytes = ok.reduce((s, r) => s + r.bytes, 0);
    const totCold = ok.reduce((s, r) => s + r.cold, 0);
    const totMean = ok.reduce((s, r) => s + r.mean, 0);
    const totBest = ok.reduce((s, r) => s + r.best, 0);
    addRow(['TOTAL', `${ok.length}/${rows.length}`, kb(totBytes), ms(totCold), ms(totMean), '—', '—', ms(totBest), throughput(totBytes, totBest)], 'total');

    table.appendChild(tbody);
    section.appendChild(table);
    $results().appendChild(section);

    console.log(`\n=== ${axis.label} — ready() ${ms(readyMs)} ms · max stall ${ms(stallMs)} ms ===`);
    console.table(
        ok.map((r) => ({
            fixture: r.path,
            kind: r.kind,
            'in KB': +kb(r.bytes),
            'cold ms': +ms(r.cold),
            'warm mean': +ms(r.mean),
            'warm p50': +ms(r.p50),
            'warm p95': +ms(r.p95),
            'warm best': +ms(r.best),
            'MB/s': +throughput(r.bytes, r.best),
        })),
    );
    // Same rows shape as perf-load.mjs's archive JSON (target `browser:<axis>`)
    // so a run can be pasted into docs/perf-profile/full-load/runs/ to diff.
    console.log(
        `[bench:browser] archive JSON (${axis.label}) :\n` +
            JSON.stringify({ target: `browser:${axis.mode}`, readyMs, stallMs, warmIters: WARM_ITERS, fixtures: rows }, null, 2),
    );
}

// ---- main-thread axis -----------------------------------------------------
async function runMainAxis(axis, corpus) {
    setStatus(`${axis.label}: importing…`);
    const mod = await import(axis.url);
    const t0 = performance.now();
    await mod.Granny.ready();
    const readyMs = performance.now() - t0;
    if (typeof mod.loadTextureCodec === 'function') await mod.loadTextureCodec();

    const rows = [];
    stall.reset();
    for (const { path, bytes } of corpus) {
        setStatus(`${axis.label}: ${path} (${rows.length + 1}/${corpus.length})…`);
        try {
            const op = () => mod.parseTextured(bytes);
            const c0 = performance.now();
            const res = op();
            const cold = performance.now() - c0;
            if (!res || !Array.isArray(res.textures)) throw new Error('empty/invalid output');
            const warm = [];
            for (let i = 0; i < WARM_ITERS; i++) {
                const s = performance.now();
                op();
                warm.push(performance.now() - s);
            }
            rows.push({ path, bytes: bytes.length, kind: res.textures.length > 0 ? 'textured' : '—', cold, ...stats(warm) });
        } catch (err) {
            rows.push({ path, bytes: bytes.length, error: err.message });
        }
        await yieldToLoop(); // let the status line + rAF monitor paint between fixtures
    }
    return { readyMs, stallMs: stall.max, rows };
}

// ---- worker axis (off-thread decode) --------------------------------------
function once(worker) {
    return new Promise((resolve) => {
        worker.onmessage = (e) => resolve(e.data);
    });
}

async function runWorkerAxis(axis, corpus) {
    setStatus(`${axis.label}: spawning worker…`);
    const worker = new Worker('./decode-worker.js', { type: 'module' });
    const t0 = performance.now();
    worker.postMessage({ type: 'init', url: axis.url });
    const init = await once(worker);
    const readyMs = performance.now() - t0;
    if (init.type === 'error') {
        worker.terminate();
        throw new Error(`worker init: ${init.error}`);
    }

    const rows = [];
    stall.reset();
    for (const { path, bytes } of corpus) {
        setStatus(`${axis.label}: ${path} (${rows.length + 1}/${corpus.length})…`);
        const buf = bytes.slice().buffer; // own copy so the corpus survives the transfer
        const reply = once(worker);
        worker.postMessage({ type: 'decode', path, buffer: buf, warmIters: WARM_ITERS }, [buf]);
        const r = await reply;
        if (r.type === 'error') rows.push({ path, bytes: bytes.length, error: r.error });
        else rows.push({ path, bytes: r.bytes, kind: r.kind, cold: r.cold, mean: r.mean, p50: r.p50, p95: r.p95, best: r.best });
        await yieldToLoop();
    }
    worker.terminate();
    return { readyMs, stallMs: stall.max, rows };
}

// ---- entry ----------------------------------------------------------------
async function run() {
    document.getElementById('run').disabled = true;
    $results().replaceChildren();
    try {
        setStatus('loading corpus…');
        const index = await (await fetch('./fixtures.json')).json();
        const corpus = [];
        for (const { path } of index) {
            const buf = await (await fetch(`./fixtures/${path}`)).arrayBuffer();
            corpus.push({ path, bytes: new Uint8Array(buf) });
        }
        for (const axis of AXES) {
            const r = axis.mode === 'worker' ? await runWorkerAxis(axis, corpus) : await runMainAxis(axis, corpus);
            renderAxisTable(axis, r.readyMs, r.stallMs, r.rows);
        }
        setStatus(`done — ${AXES.length} axes, ${corpus.length} fixtures, ${WARM_ITERS} warm iters. See tables + console.`);
    } catch (err) {
        setStatus(`ERROR — ${err.message}`);
        console.error(err);
    } finally {
        document.getElementById('run').disabled = false;
    }
}

stall.start();
document.getElementById('run').addEventListener('click', run);
run(); // auto-run on load

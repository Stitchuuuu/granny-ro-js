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
    // separately (readyMs). The whole IGC decode now runs as one fused WASM
    // entry (planeDecode + 4× iDWT2D + yuvToRGB, planes resident) — a single
    // JS→WASM crossing per texture. These two axes are the perf verdict.
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

// ---- entity grouping : a "real" load = one model + its animation banks -----
// The engine never loads a single `.gr2` in isolation — it joins a model
// (mesh + skeleton + texture) with N animation banks by a shared asset id.
// The corpus encodes that id in the filename : a model ends in `_<id>.gr2`,
// its anims start with `<id>_`. We derive groups purely from that convention
// (no asset names baked in) so the group rows describe an entity by its
// *shape* — "1 model · 4 anim" — never by what it actually is.
function groupKey(path) {
    const anim = path.match(/^(\d+)_/);
    if (anim) return { id: anim[1], role: 'anim' };
    const model = path.match(/_(\d+)\.gr2$/i);
    if (model) return { id: model[1], role: 'model' };
    return { id: path, role: 'model' }; // no id convention → own singleton group
}

// Name-free category from the entity's shape alone.
function classify(hasModel, animCount) {
    if (!hasModel) return 'animation-only bank';
    if (animCount === 0) return 'static textured model';
    if (animCount <= 2) return 'textured model · light animation';
    return 'textured model · full animation set';
}

// Roll the per-file rows up into groups. Decodes are independent pure calls on
// separate buffers, so an entity's load cost is the sum over its members — the
// same way renderAxisTable's TOTAL row sums per-file bests.
function deriveGroups(rows) {
    const byId = {};
    for (const r of rows) {
        const key = groupKey(r.path);
        const g = (byId[key.id] ??= { id: key.id, model: null, anims: [] });
        if (key.role === 'anim') g.anims.push(r);
        else g.model = r;
    }
    const out = [];
    for (const id in byId) {
        const g = byId[id];
        const members = [g.model, ...g.anims].filter((m) => m && !m.error);
        if (!members.length) continue;
        const animCount = g.anims.length;
        const bytes = members.reduce((s, m) => s + m.bytes, 0);
        out.push({
            shape: `${g.model ? '1 model' : '0 model'} · ${animCount} anim`,
            category: classify(!!g.model, animCount),
            memberCount: members.length,
            bytes,
            cold: members.reduce((s, m) => s + m.cold, 0),
            mean: members.reduce((s, m) => s + m.mean, 0),
            best: members.reduce((s, m) => s + m.best, 0),
        });
    }
    out.sort((a, b) => a.bytes - b.bytes); // size order — stable, name-free
    return out;
}

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

// Version stamp of the staged bundle (written by bench-browser-prep → meta.json)
// + the last fresh run's payload, so a dropped batch can be diffed against it.
let pageVersion = null;
let lastPayload = null;
// Human label for a payload's version : label|sha(-dirty) · warmIters.
const verLabel = (p) => {
    const v = p?.version;
    const id = v ? `${v.label ? `${v.label} · ` : ''}${v.sha ?? '?'}${v.dirty ? '-dirty' : ''}` : (p?.generatedAt ?? 'unknown');
    return `${id} · warm ${p?.warmIters ?? '?'}`;
};

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

// ---- entity-group table : the "real load" view, anonymized by shape -------
// One row per entity (model + its anim banks). Columns mirror the per-file
// table but every number is the group sum. The label is the shape/category,
// never the asset name — this is the table meant to be published.
function renderGroupTable(axis, groups) {
    const section = document.createElement('section');
    const h = document.createElement('h2');
    h.textContent = `${axis.label} — entity groups (model + its animation banks) · ${WARM_ITERS} warm iters`;
    section.appendChild(h);

    const table = document.createElement('table');
    const headers = ['entity (by shape)', 'category', 'files', 'total KB', 'cold ms', 'warm mean', 'warm best', 'MB/s'];
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

    for (const g of groups) {
        addRow([g.shape, g.category, g.memberCount, kb(g.bytes), ms(g.cold), ms(g.mean), ms(g.best), throughput(g.bytes, g.best)]);
    }
    const totBytes = groups.reduce((s, g) => s + g.bytes, 0);
    const totCold = groups.reduce((s, g) => s + g.cold, 0);
    const totMean = groups.reduce((s, g) => s + g.mean, 0);
    const totBest = groups.reduce((s, g) => s + g.best, 0);
    addRow([`${groups.length} entities`, '—', '', kb(totBytes), ms(totCold), ms(totMean), ms(totBest), throughput(totBytes, totBest)], 'total');

    table.appendChild(tbody);
    section.appendChild(table);
    $results().appendChild(section);

    console.log(`\n=== ${axis.label} — entity groups ===`);
    console.table(
        groups.map((g) => ({
            entity: g.shape,
            category: g.category,
            files: g.memberCount,
            'total KB': +kb(g.bytes),
            'cold ms': +ms(g.cold),
            'warm best': +ms(g.best),
            'MB/s': +throughput(g.bytes, g.best),
        })),
    );
}

// ---- results export : summary + Download / Copy + auto-POST capture -------
// Renders a headline summary (per-axis total warm-best + WASM-vs-JS ratio),
// wires a Download-JSON + Copy button, and best-effort POSTs the JSON to
// `/results` so a capturing dev server can persist it (no-op if the static
// server doesn't accept POST). All client-side ; safe for standalone use.
function exportResults(fixtureCount, axes) {
    const totalBest = (a) => a.fixtures.filter((r) => !r.error).reduce((s, r) => s + r.best, 0);
    const bestOf = (label) => {
        const a = axes.find((x) => x.axis === label);
        return a ? totalBest(a) : null;
    };
    const jsMain = bestOf('js-esm · main');
    const wasmMain = bestOf('wasm-esm · main');
    const jsWork = bestOf('js-esm · worker');
    const wasmWork = bestOf('wasm-esm · worker');
    const ratio = (js, w) => (js && w ? (js / w).toFixed(2) + '×' : '—');

    const payload = {
        generatedAt: new Date().toISOString(),
        version: pageVersion, // { label, sha, dirty, builtAt, … } — which code version this measured
        warmIters: WARM_ITERS,
        fixtureCount,
        userAgent: navigator.userAgent,
        summary: {
            totalWarmBestMs: {
                'js·main': jsMain,
                'js·worker': jsWork,
                'wasm·main': wasmMain,
                'wasm·worker': wasmWork,
            },
            wasmVsJs: { main: ratio(jsMain, wasmMain), worker: ratio(jsWork, wasmWork) },
        },
        axes,
    };
    const json = JSON.stringify(payload, null, 2);
    lastPayload = payload; // let a 1-file drop diff against this fresh run
    const verSlug = (pageVersion?.label || pageVersion?.sha || 'run').replace(/[^A-Za-z0-9._-]/g, '-');

    // Summary card + toolbar, injected above the per-axis tables.
    const bar = document.createElement('section');
    bar.className = 'summary';
    const h = document.createElement('h2');
    h.textContent = 'verdict — total warm-best (lower = faster)';
    bar.appendChild(h);
    const p = document.createElement('p');
    p.textContent =
        `js·main ${jsMain?.toFixed(1) ?? '—'} ms · wasm·main ${wasmMain?.toFixed(1) ?? '—'} ms ` +
        `(WASM ${ratio(jsMain, wasmMain)}) — js·worker ${jsWork?.toFixed(1) ?? '—'} ms · ` +
        `wasm·worker ${wasmWork?.toFixed(1) ?? '—'} ms (WASM ${ratio(jsWork, wasmWork)})`;
    bar.appendChild(p);

    const dl = document.createElement('button');
    dl.textContent = '⬇ Download JSON';
    dl.onclick = () => {
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `granny-bench-${verSlug}-${payload.generatedAt.replace(/[:.]/g, '-')}.json`;
        a.click();
        URL.revokeObjectURL(url);
    };
    const cp = document.createElement('button');
    cp.textContent = '📋 Copy JSON';
    cp.onclick = async () => {
        try {
            await navigator.clipboard.writeText(json);
            cp.textContent = '✓ Copied';
            setTimeout(() => (cp.textContent = '📋 Copy JSON'), 1500);
        } catch {
            cp.textContent = '✗ clipboard blocked — use Download';
        }
    };
    bar.appendChild(dl);
    bar.appendChild(cp);
    $results().prepend(bar);

    // Best-effort auto-capture : a dev server may persist this ; harmless if not.
    fetch('/results', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json }).catch(() => {});

    console.log('[bench:browser] full results JSON :\n' + json);
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
        try {
            pageVersion = await (await fetch('./meta.json')).json();
        } catch {
            pageVersion = null; // meta.json absent (older staging) — non-fatal
        }
        const index = await (await fetch('./fixtures.json')).json();
        const corpus = [];
        for (const { path } of index) {
            const buf = await (await fetch(`./fixtures/${path}`)).arrayBuffer();
            corpus.push({ path, bytes: new Uint8Array(buf) });
        }
        const collected = [];
        for (const axis of AXES) {
            const r = axis.mode === 'worker' ? await runWorkerAxis(axis, corpus) : await runMainAxis(axis, corpus);
            const groups = deriveGroups(r.rows);
            renderGroupTable(axis, groups);
            renderAxisTable(axis, r.readyMs, r.stallMs, r.rows);
            collected.push({ axis: axis.label, mode: axis.mode, url: axis.url, readyMs: r.readyMs, stallMs: r.stallMs, groups, fixtures: r.rows });
        }
        exportResults(corpus.length, collected);
        setStatus(`done — ${AXES.length} axes, ${corpus.length} fixtures, ${WARM_ITERS} warm iters. See summary + Download/Copy above the tables.`);
    } catch (err) {
        setStatus(`ERROR — ${err.message}`);
        console.error(err);
    } finally {
        document.getElementById('run').disabled = false;
    }
}

// ---- drag-&-drop batch compare (Δ%) --------------------------------------
// Drop 1-2 downloaded batch JSONs. Two → diff them (file0 baseline → file1
// current). One → diff it (baseline) against this page's fresh run. All the
// numbers are the same warm-best totals the tables above export.
const $compare = () => document.getElementById('compare');
const pct = (b, c) => (b && c != null ? ((c - b) / b) * 100 : null);
const fmtPct = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
const pctCls = (v) => (v == null ? '' : v > 0.05 ? 'up' : v < -0.05 ? 'down' : '');
const axisFixtures = (p, label) => p?.axes?.find((a) => a.axis === label)?.fixtures ?? [];

function readJson(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => {
            try {
                resolve(JSON.parse(r.result));
            } catch (e) {
                reject(new Error(`${file.name}: ${e.message}`));
            }
        };
        r.onerror = () => reject(new Error(`${file.name}: read error`));
        r.readAsText(file);
    });
}

function compareTable(title, headers, rows) {
    const section = document.createElement('section');
    const h = document.createElement('h2');
    h.textContent = title;
    section.appendChild(h);
    const table = document.createElement('table');
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
    for (const { cells, delta } of rows) {
        const tr = document.createElement('tr');
        cells.forEach((c, i) => {
            const td = document.createElement('td');
            td.textContent = c;
            if (i >= 1) td.className = 'num';
            if (i === cells.length - 1) td.classList.add(pctCls(delta));
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    section.appendChild(table);
    return section;
}

function renderCompare(baseline, current) {
    const root = $compare();
    root.replaceChildren();
    if (!baseline) return;
    if (!current) {
        const p = document.createElement('p');
        p.className = 'hint';
        p.textContent = 'Dropped 1 file but no fresh run to compare against yet — run the bench, or drop a second file.';
        root.appendChild(p);
        return;
    }

    const head = document.createElement('p');
    head.className = 'hint';
    head.textContent = `baseline: ${verLabel(baseline)}   →   current: ${verLabel(current)}   (Δ% = current vs baseline; − = faster)`;
    root.appendChild(head);

    // Per-axis total warm-best.
    const bT = baseline.summary?.totalWarmBestMs ?? {};
    const cT = current.summary?.totalWarmBestMs ?? {};
    const axisKeys = [...new Set([...Object.keys(bT), ...Object.keys(cT)])];
    root.appendChild(
        compareTable(
            'total warm-best per axis (ms, lower = faster)',
            ['axis', 'baseline', 'current', 'Δ%'],
            axisKeys.map((k) => {
                const b = bT[k];
                const c = cT[k];
                const d = pct(b, c);
                return { cells: [k, b?.toFixed(1) ?? '—', c?.toFixed(1) ?? '—', fmtPct(d)], delta: d };
            }),
        ),
    );

    // Per-fixture, js-esm · main axis (the pure-JS main-thread cost).
    const bF = axisFixtures(baseline, 'js-esm · main');
    const cF = axisFixtures(current, 'js-esm · main');
    if (bF.length && cF.length) {
        const cByPath = Object.fromEntries(cF.map((r) => [r.path, r]));
        const rows = bF
            .filter((r) => !r.error && cByPath[r.path] && !cByPath[r.path].error)
            .map((r) => {
                const b = r.best;
                const c = cByPath[r.path].best;
                const d = pct(b, c);
                return { cells: [r.path, b.toFixed(2), c.toFixed(2), fmtPct(d)], delta: d };
            });
        root.appendChild(compareTable('per-fixture warm-best — js-esm · main (ms)', ['fixture', 'baseline', 'current', 'Δ%'], rows));
    }
}

const dz = document.getElementById('dropzone');
dz.addEventListener('dragover', (e) => {
    e.preventDefault();
    dz.classList.add('over');
});
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', async (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    const files = [...e.dataTransfer.files].filter((f) => f.name.endsWith('.json'));
    if (!files.length) {
        setStatus('drop: no .json files');
        return;
    }
    try {
        const payloads = await Promise.all(files.map(readJson));
        if (payloads.length >= 2) renderCompare(payloads[0], payloads[1]);
        else renderCompare(payloads[0], lastPayload);
        $compare().scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
        setStatus(`drop compare failed — ${err.message}`);
    }
});

stall.start();
document.getElementById('run').addEventListener('click', run);
run(); // auto-run on load

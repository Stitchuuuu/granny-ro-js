# S4 « after » profile — post-optimization hot-spot landscape

CPU profile captured **after** the S4 optimizations landed (binary-search
`_findPos`, inlined u32/u16/u31 wrappers, dropped packed-u32 dance in
`_incrementTotals` / `_decrementCounts`). Same reproducer as `../before/`.

## Reproduce

```
cd <granny-ro-js repo root>
node --prof scripts/perf-profile.mjs 30
node --prof-process isolate-*.log > docs/perf-profile/after/cpu.txt
rm isolate-*.log
```

- Total samples : **1814 ticks**, 94% JS, 1% GC.
- Wall : 30 iter × 21 fixtures = 48 MB decoded in ~3.4 s (vs ~4.5 s
  before, matches the headline 1.4× speedup).

## Top JS functions (ticks)

| Ticks | % total | Function | vs « before » |
|------:|--------:|----------|--------------:|
| 847   | 46.7%   | `ArithModel.decompress` | 46.1% → 46.7% (still hot) |
| 570   | 31.4%   | `ArithBits.remove`      | 33.5% → 31.4% (slight relative drop) |
| 119   |  6.6%   | `decodeBlock`           | 4.5% → 6.6% (higher relative share, same absolute cost) |
|  33   |  1.8%   | `bitReverse`            | 0.8% → 1.8% (relative-only ; no algo change) |
|  18   |  1.0%   | `VarBits.get`           | 1.3% → 1.0% |
|  14   |  0.8%   | `u32lePadded`           | 0.8% → 0.8% |

Disappeared from the top (folded into callers by V8) :
- `u32` / `u16` wrappers (3.0% combined → 0%) — **inlined out of existence** by S4 opt #3.
- `_incrementTotals` (0.6% → < 0.1%) — **inlined + simpler** after S4 opt #4.
- `_quickIncrement` (0.6% → 0%) — same.
- `_findPos` (now 0.05%, was hidden in `decompress`) — **binary search** is so cheap V8 inlines it cleanly.

## Diagnosis

`decompress` + `remove` now account for 78% of CPU time, both heavily
inlined by V8 with no further structural simplifications obvious. The
remaining wins would need either :
- WASM port (out of S4 scope),
- A different algorithm (out of S4 scope ; we're preserving the RAD
  Oodle0 bitstream contract exactly).

S4 closed the most reachable wins ; pure-JS headroom from here would
require diminishing-returns micro-tuning or a representation change
(e.g. `Uint32Array` for `totals` / `counts` — tried-and-skipped in S4
as the gut-feel improvement didn't survive contact with profiler
re-ranking).

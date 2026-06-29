# S4 « before » profile — pre-optimization hot-spot evidence

CPU profile captured **before** any S4 optimization, used to re-rank
the candidate list in [`docs/perf-baseline.md`](../../perf-baseline.md).

## How to reproduce

```
cd <granny-ro-js repo root>
node --prof scripts/perf-profile.mjs 30
node --prof-process isolate-*.log > docs/perf-profile/before/cpu.txt
rm isolate-*.log
```

- `scripts/perf-profile.mjs` — JS-only driver (no Python subprocess) ;
  30 iterations × 21 fixtures = 48 MB of decoded data, ~4.5 s wall.
- Total samples : **2382 ticks**, of which 91% JS, 1.4% GC.
- Toolchain : Node v24.18.0 aarch64, devcontainer Apple Silicon.

## Top JS functions (ticks)

| Ticks | % total | Function | Source |
|------:|--------:|----------|--------|
| 1097  | 46.1%   | `ArithModel.decompress` | [`GrannyOodle0.js:408`](../../../src/GrannyOodle0.js#L408) |
|  799  | 33.5%   | `ArithBits.remove`      | [`GrannyOodle0.js:287`](../../../src/GrannyOodle0.js#L287) |
|  107  |  4.5%   | `decodeBlock`           | [`GrannyOodle0.js:657`](../../../src/GrannyOodle0.js#L657) |
|   57  |  2.4%   | `u32` wrapper           | [`GrannyOodle0.js:50`](../../../src/GrannyOodle0.js#L50)   |
|   31  |  1.3%   | `VarBits.get`           | [`GrannyOodle0.js:207`](../../../src/GrannyOodle0.js#L207) |
|   20  |  0.8%   | `u32lePadded`           | [`GrannyOodle0.js:155`](../../../src/GrannyOodle0.js#L155) |
|   19  |  0.8%   | `bitReverse`            | [`GrannyOodle0.js:181`](../../../src/GrannyOodle0.js#L181) |
|   15  |  0.6%   | `u16` wrapper           | [`GrannyOodle0.js:52`](../../../src/GrannyOodle0.js#L52)   |
|   14  |  0.6%   | `_quickIncrement`       | [`GrannyOodle0.js:447`](../../../src/GrannyOodle0.js#L447) |

Note : `_findPos`, `_incrementTotals`, `_addTotalPairU32` show ≤ 1
tick each — V8 has inlined them into `decompress`. Their cost is
folded into the 46.1% on `decompress`.

## Re-ranked S4 candidates (vs the prompt's gut-feel list)

| Rank | Candidate | Estimated win | Rationale |
|-----:|-----------|--------------:|-----------|
| 1 | `_findPos` linear → binary search over `totals[]` | **~10-20%** | Inside `decompress` (46% of time). The `bestShift` bucket layout was designed for exactly this. |
| 2 | `bitReverse` byte LUT inside `remove`'s 8-bit loop | **~5-10%** | Inside `remove` (33.5%). Byte LUT folds two `bitReverse(nibble, 4)` calls into one table lookup. |
| 3 | Inline `u32` / `u16` / `u31` wrappers (replace with `>>> 0` / `& 0xFFFF` / `& MASK31`) | **~3%** | 72+ ticks visible just for the call overhead ; should be free with V8 inlining but isn't. |
| 4 | Simplify `_addTotalPairU32` packed update | **~1-2%** | Two u16 adds without the packed-u32 dance. Inside `_incrementTotals` (folded into 46%). |
| 5 | `Uint32Array` for `totals` / `counts` | **uncertain** | Memory locality + faster `& 0xFFFF` ops, but JIT may already pack via hidden-class optimization. |
| 6 | `Oodle0LZHeader` accessor cache | **< 1%** | Prompt-suspected near-zero. Skip unless re-profile after #1-#3 shows it. |

## What the profile rules out (vs the prompt's guesses)

- `u32lePadded` zero-pad path : 20 ticks (0.8%). Not a hot spot.
  Confirmed by prompt's own footnote « should never trigger in the inner loop ».
- `Oodle0LZHeader.length_unique(i)` getter : not visible in profile
  (called 65× at block init, not per-symbol). Skip.

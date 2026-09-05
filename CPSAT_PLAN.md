# Replacing the placement search with CP-SAT

Investigation + implementation plan for making the market/building optimizer scale
past ~5 cities. Written 2026-09-04.

---

## 1. Baseline: what actually breaks

I instrumented a copy of `marketcalc.cc` (leaf counter + grid-copy counter), built it
with `emcc` and ran it under node on a dense synthetic map (5 rows, cities spaced 3
apart on row 2, every other tile a RESOURCE, **all cities border-grown**):

| cities | grid | wall clock | leaves evaluated | full-grid copies | best (mkt, bld) |
|---|---|---|---|---|---|
| 2 | 5×8  | 6.7 ms      | 14,624      | 24,825      | (11, 7)  |
| 3 | 5×11 | 380 ms      | 1,326,634   | 2,256,663   | (17, 10) |
| 4 | 5×14 | 37,689 ms   | 120,430,443 | 204,931,133 | (22, 14) |
| 5 | 5×17 | >10 min (killed) | — | — | — |

**Growth factor is ~90× per additional city.** Extrapolating: 5 cities ≈ 1 hour,
6 cities ≈ 4 days. Real maps have obstacles and unowned tiles so they land better than
this worst case, but the shape is fixed. This is not a constant-factor problem.

Two separate causes:

**(a) The search is fully exhaustive.** `backtrackPlacements` has no pruning and no
memoisation. It enumerates every combination of (building tile or none) × (market tile
or none) per city — `∏(|T_i|+1)²` — and evaluates *every* leaf. The Pareto accumulator
consumes every leaf under the current design, so even adding a bound on `marketTotal`
alone would not be sound without also bounding `buildingTotal`.

**(b) Every node copies the whole grid.** `state.bestLayoutReturn = state.map`,
`tempLayout = state.bestLayoutReturn`, and `state.bestLayoutReturn = tempLayout` each
copy a `vector<vector<TileState>>` — nested heap allocations, one per row. At 4 cities
that is 205M grid copies, ~1.7 per leaf. Measured cost is ~313 ns/leaf, essentially all
of it copying.

Fixing (b) alone buys roughly one extra city. Fixing (a) is the actual answer.

---

## 2. Why CP-SAT is a good fit

The problem is small and local once ownership is fixed:

- **Every tile has exactly one owner.** `computeOwnership` assigns `owner` once and
  cities only place on their own tiles, so there is no cross-city contention for a tile.
  That means we don't need per-city-per-tile variables — one pair of booleans per
  *placeable tile* is enough.
- **All interactions are within 8-adjacency.** Building level depends on adjacent
  resource tiles; market level depends on adjacent building levels. Nothing is global.
- **The model is tiny.** A 6-city all-border-grown map has ~126 placeable tiles →
  ~250 booleans, ~250 bounded integers, ~700 constraints. CP-SAT should solve this in
  single-digit milliseconds, and 12 cities should still be trivial.

The two `min(·, 8)` caps map directly onto `AddMinEquality`, which is exactly the kind
of constraint a MIP has to linearise awkwardly and CP-SAT propagates natively. That is
the main reason to prefer CP-SAT over a plain LP/MIP solver here.

---

## 3. The model

Derived from `canPlaceBuilding`, `canPlaceMarket` and `calculateMarketTotal`.

### Sets

- `Owned(i)` — tiles with `owner == i`.
- `Placeable(i)` = `{ p in Owned(i) : type(p) in {EMPTY, RESOURCE} }`
  (CITY tiles and USED_RESOURCE tiles cannot be built on; OBSTACLE is never owned).
- `Placeable` = union over i of `Placeable(i)`.
- `Res` = `{ p : owner(p) != -1 and type(p) in {RESOURCE, USED_RESOURCE} }`
  — resource tiles that count toward a building's level. **Unowned resources do not
  count** (`calculateMarketTotal` checks `owner != -1`).
- `N(p)` — the 8 in-bounds neighbours of `p`.

### Variables

| var | domain | meaning |
|---|---|---|
| `x[p]` | {0,1} | building on tile `p`, for `p` in `Placeable` |
| `y[p]` | {0,1} | market on tile `p`, for `p` in `Placeable` |
| `B[p]` | [0, 8] | building level of tile `p` (0 if no building) |
| `M[p]` | [0, 8] | market level of tile `p` (0 if no market) |

### Constraints

```
C1  x[p] + y[p] <= 1                                   for p in Placeable
C2  sum(x[p] for p in Placeable(i)) <= 1               for each city i
C3  sum(y[p] for p in Placeable(i)) <= 1               for each city i

    free[r] = 1 - x[r] - y[r]   if r in Res and r in Placeable   (RESOURCE)
    free[r] = 1                 if r in Res, not Placeable       (USED_RESOURCE,
                                                                  never coverable)

C4  B[p] = min( 8 * x[p], sum(free[r] for r in N(p) & Res) )      AddMinEquality
C5  M[p] = min( 8 * y[p], sum(B[q] for q in N(p) & Placeable) )   AddMinEquality
```

Both minima are `<= 8` by construction, so the `[0,8]` domains are safe and the
`MAX_MARKET_LEVEL` cap is enforced by the `8 * y[p]` term.

Use `AddMinEquality`, **not** a pair of `<=` inequalities. Inequalities happen to be
sound here (both objectives are maximised with positive coefficients, so the solver
pushes `B` and `M` up to their bounds) but they let the second sweep solve report slack
values, and they propagate far worse.

### Legality constraints (optional, recommended)

These do not change the optimal totals — a building with no free adjacent resource has
level 0, and a market with no adjacent building has level 0, so neither can help — but
they keep returned layouts game-legal:

```
C6  B[p] >= 1                                   OnlyEnforceIf(x[p])
C7  BoolOr(x[q] for q in N(p) & Placeable)      OnlyEnforceIf(y[p])
```

C6 is *stricter and more correct* than today's `canPlaceBuilding`, whose "adjacent to an
uncovered resource" test depends on placement order — the header comment already
acknowledges this ("we do not care about the case where we place on the last resource
used by another building"). See §7.

### Objectives

```
Mkt = sum(M[p] for p in Placeable)     # == calculateMarketTotal
Bld = sum(B[p] for p in Placeable)     # == sum of buildingLevelsCurrent
```

---

## 4. Reproducing the Pareto frontier

`findParetoFrontier` currently returns the 3 non-dominated points with the highest
market totals, sorted market-desc then building-desc. Reproduce that with an
epsilon-constraint sweep — 6 solves, all on the same model:

```
results = []
bldLB = 0
for k in 1..3:
    # s1: highest market total among points not dominated by results so far
    solve  maximize Mkt  subject to  Bld >= bldLB
    if INFEASIBLE: break
    Mk = objective value

    # s2: pin the market total, push building total up -> the frontier point
    solve  maximize Bld  subject to  Mkt == Mk, Bld >= bldLB
    Bk = objective value; layout = decode(x, y)

    results.append((Mk, Bk, layout))
    bldLB = Bk + 1
```

Point 1 is the lexicographic optimum (max market, then max building). Point 2 is the
best-market point that point 1 does not dominate, which is exactly the constraint
`Bld >= B1 + 1`. And so on.

**Keep `calculateMarketTotal` as a verifier.** After decoding each layout, run it
through the existing C++ scorer and assert it returns `Mk` (and that the building levels
sum to `Bk`). This catches model bugs immediately and costs microseconds.

---

## 5. Which solver, and how it ships

"CP-SAT" is a *technique* — **lazy clause generation** (LCG): constraint propagation
plus SAT-style clause learning. Google's OR-Tools CP-SAT is the best-known
implementation, but it is not the only one, and for a static browser app it is the worst
one to ship. Chuffed and Pumpkin are the same algorithmic family and both medal at the
MiniZinc Challenge.

The app is a static, offline, client-side page shipping a 1.06 MB `.wasm`, so payload
size decides this.

### The key structural insight: skip the modelling compiler

Once `computeOwnership` has run, the model in §3 is **completely flat** — a fixed list of
variables and constraints with no loops, generators or sets left to expand. That is
exactly what **FlatZinc** is: the low-level format MiniZinc compiles *down to*, and the
input format every solver below already accepts.

So you do not need a modelling layer at runtime. Emit FlatZinc text directly (~200–300
lines of string building) and hand it to a solver-only wasm binary. Everything the model
needs is a standard FlatZinc builtin:

| model piece | FlatZinc builtin |
|---|---|
| `x[p] + y[p] <= 1`, city-level `sum(...) <= 1` | `int_lin_le` |
| `t[p] = 8 * x[p]` | `int_lin_eq` |
| `B[p] = min(t[p], rawB[p])` | `int_min` |
| `BoolOr(x[q] ...)` enforced-if `y[p]` | `array_bool_or` / `bool_clause` |
| objective | `solve maximize` |

This also gives a clean validation story: write the model **twice** — once as a readable
`.mzn`, once as your runtime FlatZinc emitter — then diff `minizinc --output-fzn`
against your emitter's output. Any divergence is a bug in the emitter, caught before it
reaches the solver.

### Candidates (all measured)

| option | license | payload | new toolchain? | notes |
|---|---|---|---|---|
| **Chuffed** built with your emsdk | MIT | est. 1–3 MB wasm | no | C++11, CMake, no deps; `emcmake cmake` |
| `minizinc` npm 4.5.2 | MPL-2.0 | **18.85 MB** wasm + 0.53 MB data | no | compiler + Gecode/CBC/Chuffed/HiGHS in one blob; on jsDelivr |
| Pumpkin | MIT/Apache-2.0 | est. 1–3 MB wasm | Rust | pure Rust, FlatZinc, MiniZinc Challenge medals 2025 & 2026 |
| `highs` npm 1.15.2 | MIT | 3.5 MB unpacked | no | MIP not LCG; weak LP relaxation here, see below |
| `z3-solver` npm 5.2.0 | MIT | 35.8 MB unpacked | no | has native `opt.priority=pareto`, but a general SMT optimiser will lose badly to an LCG solver on this |
| `or-tools-wasm` 0.9.1 | Apache-2.0 | **332 MB** unpacked | no | needs COOP/COEP; **rejected**, see below |

None of Chuffed / MiniZinc / Pumpkin require cross-origin isolation. `or-tools-wasm`
does (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy:
require-corp`), which would also force the `gtag.js` tag and any cross-origin asset to be
CORP/CORS-clean or stop loading. Combined with the 332 MB package, that rules it out.

### Recommendation

**Ship Chuffed.** It is MIT, C++11, CMake, dependency-free, reads FlatZinc, and already
builds under emscripten — the MiniZinc project builds it for `wasm32-emscripten` as part
of their own wasm pipeline, so the path is known-good. You already have emsdk wired up at
`C:\Git\emsdk` and an `emcc` build in the Makefile, so this adds no new toolchain.

**Prototype with `minizinc` npm.** Pull it from jsDelivr, write the model as readable
`.mzn`, solve with `--solver chuffed`. This gets you a working end-to-end answer in an
afternoon with zero build work, and doubles as the oracle for the FlatZinc emitter. If
18.85 MB (≈5 MB gzipped) turns out to be acceptable for your users, you can just ship it
and skip the custom build entirely.

**Fall back to Pumpkin** if the Chuffed emscripten build fights you. Pure Rust usually
targets wasm cleanly, though watch for `std::time` use in restart/timeout logic —
`wasm32-wasi` handles that better than `wasm32-unknown-unknown`.

### Non-LCG fallbacks, if all of the above disappoint

- **HiGHS (`highs` npm, 3.5 MB, MIT).** Requires linearising `int_min` back into `<=`
  pairs (sound here — both objectives are maximised with positive coefficients) plus
  helper cuts, because the LP relaxation is weak: spreading `x` at `1/|T_i|` across a
  city's tiles gives an LP bound of `8 * numCities` — 32 for the 4-city benchmark whose
  true optimum is 22, a ~45% gap. Add at minimum `M[p] <= 8 * sum(x[q] for q in N(p) &
  Placeable)` and `sum(M[p] for p in Placeable(i)) <= 8` per city.
- **Hand-rolled branch & bound in the existing C++.** No dependency, wasm stays ~1 MB.
  Do (b) from §1 first (leaf = `(buildingCoord[], marketCoord[])`, reconstruct grids only
  for the 3 winners; ~10–30× on its own). Then bound: with cities `0..d-1` fixed, the
  remaining market total is at most `8 × (cities with no market yet)`, tightened per city
  by the best level reachable from its free tiles — and you need a matching bound on
  `Bld` (max 8 per remaining city), since the Pareto sweep consumes both objectives.
  Also decompose: two cities cannot interact if no tile of one is within Chebyshev
  distance 2 of a tile of the other. Realistic ceiling 8–10 cities, and it is exactly the
  kind of code that produced the two-hour `bestLayoutCurrent` aliasing bug in the README.
- **Server-side solver.** Easiest and fastest, but ends the app's static/offline
  property and adds hosting. Only if everything else fails.

---

## 6. Staged plan

Each stage ends with something checkable.

### Stage 0 — measurement harness (~half a day)

- Promote the throwaway `driver.cc` from this investigation into `tools/bench.cc`:
  generates parameterised maps, prints time / leaves / totals, builds via
  `emcc ... -s ENVIRONMENT=node` and runs under node (there is no native C++ compiler on
  this machine — only emsdk at `C:\Git\emsdk`).
- Add a `tools/dump_case.cc` that emits `{grid, cityCenters, actionOrder}` as JSON, and
  capture the existing gtest scenarios plus 3–5 real maps from the UI into
  `tests/corpus/`.
- **Done when:** `make bench` reproduces the table in §1, and the corpus round-trips.

### Stage 1 — model in MiniZinc, validate it (~1 day) — GO / NO-GO

- `npm i minizinc` (or pull `https://cdn.jsdelivr.net/npm/minizinc/dist/minizinc.js`).
  Write `tools/market.mzn` implementing §3, and a small JS driver that reads a corpus
  case, replicates `computeOwnership` (~40 lines, port it directly), feeds the data, and
  runs the §4 sweep with `--solver chuffed`.
- Differential test against the existing C++ brute force on randomly generated small maps
  (2–3 cities, mixed obstacles/resources, with and without border growth). The *totals*
  must match exactly; layouts may differ (see §7).
- Measure solve time at 6, 8, 10 and 12 cities on dense all-border-grown maps. Report
  MiniZinc's flatten time and Chuffed's solve time separately — the flatten time is what
  Stage 2 deletes.
- **Done when:** 500 random cases match on `(marketTotal, buildingTotal)` for all three
  frontier points, and the 12-city dense case solves in under a second.
- **If solve times are not comfortably sub-second, stop and reconsider** — everything
  downstream assumes an LCG solver makes this problem cheap.

### Stage 2 — shrink the payload (~1–2 days)

Only needed if 18.85 MB of `minizinc.wasm` is too much to ship. Decide with a real
number: gzip it and look at the load time on a phone.

- Build Chuffed alone: clone `chuffed/chuffed`, `emcmake cmake` + `emmake make` with the
  emsdk at `C:\Git\emsdk`, target `fzn-chuffed`. Measure the resulting `.wasm`.
- Write `tools/fzn_emit` — the FlatZinc emitter from §5 — in whichever language ends up
  driving the solve (C++ if you keep `marketcalc.wasm`, JS if you drop it).
- **Validate the emitter by diffing against MiniZinc:** run
  `minizinc --solver chuffed --output-fzn` on `tools/market.mzn` for every corpus case
  and compare, modulo variable naming, against the emitter's output. Then check that
  both FlatZinc files produce identical totals.
- If the Chuffed emscripten build fights you, switch to Pumpkin (§5) rather than
  hand-rolling — the FlatZinc emitter is unchanged either way.
- **Done when:** solver payload is under ~3 MB gzipped, and emitted FlatZinc matches the
  MiniZinc-generated FlatZinc on the whole corpus.

### Stage 3 — integrate (~1–2 days)

- Replace the body of `findParetoFrontier`'s search. Keep `computeOwnership` and
  `calculateMarketTotal` untouched — they are the input builder and the verifier.
- `computeOwnership` is ~40 lines of trivial logic; if the solve moves to JS, port it too
  and drop `marketcalc.wasm` from the browser bundle entirely. Keep the C++ under `tests/`
  as the brute-force oracle.
- Keep the existing exhaustive search behind a flag as a correctness oracle, and keep the
  gtest suite green — `full_tests.cc` asserts exact totals (16 for `TwoCitiesMaxMarkets`,
  >26 for `Scenario1_BeatsHuman`) which the new path must reproduce.
- Add the §4 verifier assertion on every returned layout.
- Load the solver wasm lazily, on first Calculate rather than on page load, so the
  page still opens instantly.
- **Done when:** all existing tests pass, and a 6-city border-grown map returns in under
  a second in the browser.

### Stage 4 — what this unlocks

With a per-solve cost in milliseconds, the README's "**Can't (for now): find the best
border growth order**" becomes an outer loop over action orders — each order changes only
the ownership map, and the placement solve is now cheap. Worth scoping separately; the
permutation count still grows factorially, so it will need its own pruning.

---

## 7. Behaviour changes to expect

- **Layouts may differ from today's for identical totals.** The current search returns
  whichever equal-scoring layout it happens to reach first; CP-SAT returns whichever it
  proves first. Any test asserting specific tile positions rather than totals needs
  loosening — `full_tests.cc:TwoCitiesMaxMarkets` asserts `BUILDING` at `[1][2]`/`[1][3]`
  and will need review.
- **Constraint C6 is stricter than `canPlaceBuilding`.** Today a building can be placed
  next to a resource that a later placement then covers, leaving a level-0 building on
  the board. C6 forbids that. Totals are unaffected (level-0 buildings contribute nothing
  to either objective); layouts get cleaner.
- **The frontier may hold more than 3 points.** Already true today; both implementations
  truncate to the top 3 by market total. No change.

## 8. Considered and rejected

- **Profile / broken-profile DP over grid columns.** State would be the placements in the
  trailing two columns (interactions reach Chebyshev distance 2), i.e. `3^(2*rows)`.
  Fine at 5 rows, hopeless at the 10–20 row grids the UI allows.
- **Memoising the existing backtracker.** There is no compact subproblem key — the
  building placed in city `i` affects resource coverage and market levels for every
  neighbouring city, so subtrees are not independent given only `cityIdx`.
- **Pruning the current search without a model.** Sound pruning requires bounding *both*
  objectives simultaneously (the Pareto accumulator consumes every leaf). Doable — it is
  Option C — but it is strictly more work than writing the model, and the model is the
  thing that tells you the bound is right.

# PolyMarketCalc

## How the optimizer works

Placement is solved as a constraint model (MiniZinc + Chuffed, a lazy clause
generation solver) rather than by enumerating every layout. The model lives in
`static/market-solver.mjs`; ownership and scoring rules shared with the verifier
are in `static/market-rules.mjs`; `static/market-calculation.mjs` is the browser
entry point, which loads the MiniZinc WebAssembly build from jsDelivr at a pinned
version (bump the URL there and the `minizinc` devDependency together). Design
notes and the measurements behind this are in `CPSAT_PLAN.md`.

The frontier has three dimensions: market stars, building population, and
border growths used. For one fixed set of border growths, each point is two
solves: the market total is maximised and proven first, then held fixed while
the building total is maximised. On top of that the sweep tries every
combination of extra border growths up to a third of the map's cities (see
`maxExtraBorderGrowths`), one such market/building sweep per combination, and
keeps the points no other point beats on all three at once.

Combinations are tried fewest-growths-first, so the layouts asking least of the
player arrive first, and within a growth count the ones claiming the most new
land go first. The page shows the frontier as it grows and caps the whole
calculation at about two minutes, with any single combination capped at 20 s; a
point marked `*` hit a time limit and is the best found rather than proven
optimal (its market total is still exact). On maps big enough that the budget
runs out — nine cities is 130 combinations, and `npm run bench` puts that at
about two minutes — the sweep returns fewer combinations rather than running
long.

Extra growths are appended after everything the player already did, and within
one combination they go in city id order, so contested tiles fall to the lowest
id; other orderings of the same set are not tried.

The original C++ brute-force search (`marketcalc.cc`) is kept as the reference
oracle: `make wasm` builds it to `tools/oracle/` and `npm test` checks the solver
against it on `tests/corpus/` plus random maps. The border-growth frontier is
checked the same way on the smallest cases, by running the oracle once per
combination and comparing against the non-dominated triples of the union.
`npm run bench` reports solve time by city count, on the hardest clustered maps,
and for the border-growth sweep.



What you can do as a user:

- Calculate the best market spots for either windmills or sawmills, but not both
- See which border growths are worth making, and what they buy you
- Simulate capturing cities, border growths, and placing buildings/resources
- Assumes every unused resource is either used or has a building/market placed on it



Optimizations:
Debug process:

Initially
Requirement to be served through the browser
Found a 3-city solution online that took 30 seconds
Realized native JS would be way too slow, must use lower level
  Settled on C++ compiled to WASM for calculations, basic JS for frontend

First prototype
Vibe coded and iterated through the UI, it just needs to be attached to a serializable format
4 cities took 1 second (so with BG iteration it takes 24 seconds)
Thought it was too slow, looked through profiler and found hashing was expensive

Second prototype
Debugging is a pain

PROBLEM: I tried to save space by having a bestlayoutcurrent and a bestlayoutreturn.
Only those two data structures for storing intermediate layouts during calculation.
However, you need an additional bestlayoutcurrent for every recursion depth because
they will eat into each other, and I failed to consider that and spent 2 hours deb:w
ugging
for this issue.:w



recursive backtracking to find the best possible arrangement of stuff
(best place to place a market in EACH city)
each recursion depth places the market in 1 city
  then calls recursion depth + 1 and finds the best layout for each 
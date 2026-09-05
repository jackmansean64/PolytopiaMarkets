# PolyMarketCalc

## How the optimizer works

Placement is solved as a constraint model (MiniZinc + Chuffed, a lazy clause
generation solver) rather than by enumerating every layout. The model lives in
`static/market-solver.mjs`; ownership and scoring rules shared with the verifier
are in `static/market-rules.mjs`; `static/market-calculation.mjs` is the browser
entry point, which loads the MiniZinc WebAssembly build from jsDelivr at a pinned
version (bump the URL there and the `minizinc` devDependency together). Design
notes and the measurements behind this are in `CPSAT_PLAN.md`.

Each frontier point is two solves: the market total is maximised and proven
first, then held fixed while the building total is maximised. The page shows
each point as it arrives and caps the whole calculation at about a minute; a
point marked `*` hit a time limit and is the best found rather than proven
optimal (its market total is still exact).

The original C++ brute-force search (`marketcalc.cc`) is kept as the reference
oracle: `make wasm` builds it to `tools/oracle/` and `npm test` checks the solver
against it on `tests/corpus/` plus random maps. `npm run bench` reports solve
time by city count and on the hardest clustered maps.



What you can do as a user:

- Calculate the best market spots for either windmills or sawmills, but not both
  - Tell you which BGs are best?
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
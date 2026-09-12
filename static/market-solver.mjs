/**
 * Finds the Pareto frontier of market/building layouts by solving a constraint
 * model (MiniZinc + Chuffed) instead of enumerating every placement.
 *
 * The model is built from the ownership map: one building flag and one market
 * flag per placeable tile, with building and market levels derived from
 * 8-adjacency exactly as calculateMarketTotal scores them. The frontier is
 * swept with an epsilon constraint on the building total, and every returned
 * layout is re-scored by scoreLayout so a modelling bug cannot go unnoticed.
 *
 * The MiniZinc namespace is injected so the same code runs against the
 * WebAssembly build in the browser and a native MiniZinc in node.
 */
import {
  TILE,
  UNOWNED,
  MAX_BUILDING_LEVEL,
  MAX_MARKET_LEVEL,
  computeOwnership,
  scoreLayout,
  forEachAdjacentTile,
} from './market-rules.mjs';

/** How many frontier points to return, matching the C++ search. */
export const DEFAULT_MAX_CONFIGS = 3;

/** Lazy-clause-generation solver bundled with the MiniZinc wasm build. */
export const DEFAULT_SOLVER = 'chuffed';

/**
 * Time limits suited to an interactive caller. The market-total solve is cheap
 * to prove, so its cap only guards against a pathological map; proving the
 * building tiebreak is what gets slow on dense clustered maps, so it is capped
 * short and degrades to best-found. The sweep budget stops alternatives from
 * keeping the user waiting once the best layout is already on screen.
 *
 * The border-growth sweep runs one market/building sweep per growth plan, so it
 * gets a longer overall budget and a per-plan cap that keeps one slow plan from
 * eating it. Plans are tried fewest-growths-first, so a sweep that runs out of
 * budget has still covered the layouts asking least of the user.
 */
export const INTERACTIVE_SOLVE_LIMITS = Object.freeze({
  marketTimeLimitMs: 60000,
  tiebreakTimeLimitMs: 15000,
  sweepTimeBudgetMs: 120000,
  planTimeBudgetMs: 20000,
});

/** Tile types the solver may place a building or market on. */
const PLACEABLE_TYPES = new Set([TILE.EMPTY, TILE.RESOURCE, TILE.BUILDING, TILE.MARKET]);

/** Value of `marketTotalPinned` meaning "not pinned". */
const NOT_PINNED = -1;

/**
 * The placement model. Tiles are indexed 1..tileCount over the placeable tiles
 * only; see buildPlacementModelData for the data it expects.
 *
 * Levels are constrained from above only (`<=`) rather than with `min`. Both
 * objectives are maximised with positive weight, so the solver drives every
 * level that matters up to its true value, and the solver proves optimality
 * about 3x faster this way on dense maps. Reported levels may sit below their
 * true value for placements that do not affect the objective, which is why
 * callers re-score layouts with scoreLayout rather than trusting them.
 */
export const MARKET_MODEL = `
int: tileCount;
int: cityCount;
int: maxBuildingLevel;
int: maxMarketLevel;
set of int: TILE = 1..tileCount;
set of int: CITY = 1..cityCount;

% Owning city of each placeable tile.
array[TILE] of CITY: cityOf;
% Placeable tiles 8-adjacent to each tile (where a neighbouring building may sit).
array[TILE] of set of TILE: adjacentTiles;
% Adjacent RESOURCE tiles that stop counting once something is built on them.
array[TILE] of set of TILE: coverableResourceTiles;
% Adjacent resources that can never be built on (USED_RESOURCE), always counted.
array[TILE] of int: fixedResourceCount;
% Buildings and markets already on the map; the solver keeps them.
set of TILE: preplacedBuildings;
set of TILE: preplacedMarkets;

% Sweep controls: which objective to maximise, an optional exact market total
% to hold while maximising buildings, and the epsilon floor on buildings.
bool: isMaximizingMarket;
int: marketTotalPinned;
int: buildingTotalMin;

array[TILE] of var bool: hasBuilding;
array[TILE] of var bool: hasMarket;
array[TILE] of var 0..maxBuildingLevel: buildingLevel;
array[TILE] of var 0..maxMarketLevel: marketLevel;

constraint forall(p in preplacedBuildings)(hasBuilding[p]);
constraint forall(p in preplacedMarkets)(hasMarket[p]);
constraint forall(p in TILE)(not (hasBuilding[p] /\\ hasMarket[p]));
constraint forall(c in CITY)(sum(p in TILE where cityOf[p] = c)(bool2int(hasBuilding[p])) <= 1);
constraint forall(c in CITY)(sum(p in TILE where cityOf[p] = c)(bool2int(hasMarket[p])) <= 1);

% A building's level counts adjacent resources not covered by anything.
constraint forall(p in TILE)(
  buildingLevel[p] <= maxBuildingLevel * bool2int(hasBuilding[p])
);
constraint forall(p in TILE)(
  buildingLevel[p] <= fixedResourceCount[p]
    + sum(r in coverableResourceTiles[p])(1 - bool2int(hasBuilding[r]) - bool2int(hasMarket[r]))
);

% A market's level sums the adjacent building levels.
constraint forall(p in TILE)(
  marketLevel[p] <= maxMarketLevel * bool2int(hasMarket[p])
);
constraint forall(p in TILE)(
  marketLevel[p] <= sum(q in adjacentTiles[p])(buildingLevel[q])
);

% Game legality for placements the solver chooses: a building needs an
% uncovered adjacent resource, a market needs an adjacent building.
constraint forall(p in TILE where not (p in preplacedBuildings))(
  hasBuilding[p] -> buildingLevel[p] >= 1
);
constraint forall(p in TILE where not (p in preplacedMarkets))(
  hasMarket[p] -> exists(q in adjacentTiles[p])(hasBuilding[q])
);

% Totals are summed per city first. Each city has at most one building and one
% market, so these bound each city's contribution by a single level cap, which
% keeps the objective's domain tight enough for the solver to prove optimality
% quickly (summing tile levels directly is ~250x slower on dense maps).
array[CITY] of var 0..maxMarketLevel: cityMarketLevel;
array[CITY] of var 0..maxBuildingLevel: cityBuildingLevel;
constraint forall(c in CITY)(
  cityMarketLevel[c] = sum(p in TILE where cityOf[p] = c)(marketLevel[p])
);
constraint forall(c in CITY)(
  cityBuildingLevel[c] = sum(p in TILE where cityOf[p] = c)(buildingLevel[p])
);

var int: marketTotal = sum(cityMarketLevel);
var int: buildingTotal = sum(cityBuildingLevel);
constraint buildingTotal >= buildingTotalMin;
constraint if marketTotalPinned >= 0 then marketTotal = marketTotalPinned endif;

solve maximize if isMaximizingMarket then marketTotal else buildingTotal endif;
`;

/**
 * Builds the model's data from a map and its ownership.
 *
 * @param {number[][]} grid - Tile types per cell.
 * @param {number[][]} owner - Owner per cell from computeOwnership.
 * @param {number} cityCount - Number of cities.
 * @returns {{tiles: {row: number, col: number}[], data: object}} The placeable
 *   tiles in model index order (index i is tile i+1) and the MiniZinc JSON data.
 * @throws {Error} If a city already has two buildings or two markets.
 */
export function buildPlacementModelData(grid, owner, cityCount) {
  const rowCount = grid.length;
  const colCount = grid[0].length;

  const tiles = [];
  const tileIndex = grid.map((row) => row.map(() => 0));
  for (let row = 0; row < rowCount; row++) {
    for (let col = 0; col < colCount; col++) {
      if (owner[row][col] !== UNOWNED && PLACEABLE_TYPES.has(grid[row][col])) {
        tiles.push({ row, col });
        tileIndex[row][col] = tiles.length;
      }
    }
  }

  const adjacentPlaceableIndices = (tile, isWanted) => {
    const indices = [];
    forEachAdjacentTile(rowCount, colCount, tile.row, tile.col, (row, col) => {
      if (tileIndex[row][col] !== 0 && isWanted(row, col)) indices.push(tileIndex[row][col]);
    });
    return { set: indices };
  };

  const preplacedBuildings = [];
  const preplacedMarkets = [];
  const buildingCountByCity = new Array(cityCount).fill(0);
  const marketCountByCity = new Array(cityCount).fill(0);
  tiles.forEach((tile, index) => {
    const type = grid[tile.row][tile.col];
    const cityId = owner[tile.row][tile.col];
    if (type === TILE.BUILDING) {
      preplacedBuildings.push(index + 1);
      if (++buildingCountByCity[cityId] > 1) throw new Error(`Multiple buildings in city ${cityId}`);
    } else if (type === TILE.MARKET) {
      preplacedMarkets.push(index + 1);
      if (++marketCountByCity[cityId] > 1) throw new Error(`Multiple markets in city ${cityId}`);
    }
  });

  const data = {
    tileCount: tiles.length,
    cityCount,
    maxBuildingLevel: MAX_BUILDING_LEVEL,
    maxMarketLevel: MAX_MARKET_LEVEL,
    cityOf: tiles.map((tile) => owner[tile.row][tile.col] + 1),
    adjacentTiles: tiles.map((tile) => adjacentPlaceableIndices(tile, () => true)),
    coverableResourceTiles: tiles.map((tile) =>
      adjacentPlaceableIndices(tile, (row, col) => grid[row][col] === TILE.RESOURCE)),
    fixedResourceCount: tiles.map((tile) => {
      let count = 0;
      forEachAdjacentTile(rowCount, colCount, tile.row, tile.col, (row, col) => {
        if (grid[row][col] === TILE.USED_RESOURCE && owner[row][col] !== UNOWNED) count++;
      });
      return count;
    }),
    preplacedBuildings: { set: preplacedBuildings },
    preplacedMarkets: { set: preplacedMarkets },
  };
  return { tiles, data };
}

/**
 * Overlays a solution's buildings and markets onto a copy of the grid.
 *
 * @param {number[][]} grid - Original tile types.
 * @param {{row: number, col: number}[]} tiles - Placeable tiles in model order.
 * @param {boolean[]} hasBuilding - Solver value per placeable tile.
 * @param {boolean[]} hasMarket - Solver value per placeable tile.
 * @returns {number[][]} The layout with BUILDING/MARKET placed.
 */
function applyPlacements(grid, tiles, hasBuilding, hasMarket) {
  const layout = grid.map((row) => row.slice());
  tiles.forEach((tile, index) => {
    if (hasBuilding[index]) layout[tile.row][tile.col] = TILE.BUILDING;
    else if (hasMarket[index]) layout[tile.row][tile.col] = TILE.MARKET;
  });
  return layout;
}

/**
 * Runs one solve of the model with the given sweep controls.
 *
 * @param {object} MiniZinc - The `minizinc` namespace.
 * @param {object} modelData - Static data from buildPlacementModelData.
 * @param {{isMaximizingMarket: boolean, marketTotalPinned: number, buildingTotalMin: number}} sweep
 * @param {string} solver - MiniZinc solver tag.
 * @param {number|undefined} timeLimitMs - Cap on this solve; undefined means none.
 * @returns {Promise<{hasBuilding: boolean[], hasMarket: boolean[], isProvenOptimal: boolean, statistics: object} | {isTimedOut: true} | null>}
 *   The best placements found; null if no layout satisfies the controls; or
 *   `{isTimedOut: true}` if the time limit expired before any layout was
 *   found. When the limit stops the search after a layout was found, the
 *   placements are the best so far and `isProvenOptimal` is false.
 * @throws {Error} If MiniZinc reports an error, or if the search ends without
 *   proving optimality when no time limit was set.
 */
async function solvePlacements(MiniZinc, modelData, sweep, solver, timeLimitMs) {
  const model = new MiniZinc.Model();
  model.addFile('market.mzn', MARKET_MODEL);
  model.addJson({ ...modelData, ...sweep });

  const errors = [];
  const options = { solver, statistics: true };
  if (timeLimitMs) options['time-limit'] = timeLimitMs;
  const solve = model.solve({ options });
  solve.on('error', (event) => errors.push(event.message));
  const result = await solve;

  if (errors.length > 0) throw new Error(`MiniZinc error: ${errors.join('; ')}`);
  if (result.status === 'UNSATISFIABLE') return null;
  const isProvenOptimal = result.status === 'OPTIMAL_SOLUTION';
  const isBestEffort = Boolean(timeLimitMs) && result.status === 'SATISFIED' && Boolean(result.solution);
  if (!isProvenOptimal && !isBestEffort) {
    if (timeLimitMs && !result.solution) return { isTimedOut: true };
    throw new Error(`Solver finished with status ${result.status} instead of an optimal solution`);
  }
  const values = result.solution.output.json;
  return {
    hasBuilding: values.hasBuilding,
    hasMarket: values.hasMarket,
    isProvenOptimal,
    statistics: result.statistics,
  };
}

/**
 * @typedef {object} FrontierConfig
 * @property {number} marketTotal
 * @property {number} buildingTotal
 * @property {number[][]} layout - Tile types with BUILDING/MARKET placed.
 * @property {number[][]} owner - Owner per cell the layout was scored against.
 * @property {boolean} isProvenOptimal - False when a time limit cut a search
 *   short, in which case this is the best layout found rather than the best.
 * @property {object[]} solveStatistics - MiniZinc/solver statistics for each
 *   solve behind this point (market total first, then the building tiebreak).
 */

/**
 * Sweeps the market/building frontier for one fixed ownership map.
 *
 * Each frontier point takes two solves under a floor on the building total:
 * maximise the market total, then hold that total and maximise the building
 * total. Splitting them keeps the market total exact even when the tiebreak
 * is capped, because proving the tiebreak is what gets expensive on dense
 * maps. Raising the floor above each point's building total yields the
 * frontier in descending market order exactly as the C++ search does.
 *
 * @param {object} MiniZinc - The `minizinc` package namespace (wasm or native).
 * @param {number[][]} grid - Tile types per cell.
 * @param {number[][]} owner - Owner per cell from computeOwnership.
 * @param {number} cityCount - Number of cities.
 * @param {object} options
 * @param {number} [options.maxConfigs] - Frontier points to return.
 * @param {string} [options.solver] - MiniZinc solver tag.
 * @param {number} [options.marketTimeLimitMs] - Cap on each market-total solve.
 * @param {number} [options.tiebreakTimeLimitMs] - Cap on each building-total solve.
 * @param {() => number} options.budgetLeftMs - Milliseconds left for this sweep;
 *   per-solve caps shrink to it and no new point is started once it is spent.
 * @param {boolean} [options.throwIfEmptyOnTimeout] - Throw rather than return
 *   nothing when the budget runs out before any layout is found. Defaults to true.
 * @param {(config: FrontierConfig) => void} [options.onConfig] - Called with each
 *   point as soon as it is found, before the sweep continues.
 * @returns {Promise<FrontierConfig[]>}
 * @throws {Error} If the solver fails, or if a returned layout does not score
 *   what the model claimed (a modelling bug).
 */
async function sweepFrontier(MiniZinc, grid, owner, cityCount, options) {
  const maxConfigs = options.maxConfigs ?? DEFAULT_MAX_CONFIGS;
  const solver = options.solver ?? DEFAULT_SOLVER;
  const { budgetLeftMs } = options;

  const { tiles, data } = buildPlacementModelData(grid, owner, cityCount);
  const scoredLayout = (solution) => {
    const layout = applyPlacements(grid, tiles, solution.hasBuilding, solution.hasMarket);
    return { layout, ...scoreLayout(layout, owner) };
  };
  const solveLimit = (perSolveLimitMs) => {
    const limit = Math.min(perSolveLimitMs ?? Infinity, budgetLeftMs());
    return Number.isFinite(limit) ? Math.max(1, Math.round(limit)) : undefined;
  };

  const configs = [];
  let buildingTotalMin = 0;
  while (configs.length < maxConfigs) {
    if (configs.length > 0 && budgetLeftMs() === 0) break;

    const marketSolution = await solvePlacements(
      MiniZinc, data,
      { isMaximizingMarket: true, marketTotalPinned: NOT_PINNED, buildingTotalMin },
      solver, solveLimit(options.marketTimeLimitMs),
    );
    if (marketSolution === null) break;
    if (marketSolution.isTimedOut) {
      if (configs.length > 0) break;
      if (options.throwIfEmptyOnTimeout ?? true) throw new Error('No layout found within the time limit');
      break;
    }
    const marketBest = scoredLayout(marketSolution);

    const tiebreakSolution = budgetLeftMs() === 0 ? { isTimedOut: true } : await solvePlacements(
      MiniZinc, data,
      { isMaximizingMarket: false, marketTotalPinned: marketBest.marketTotal, buildingTotalMin },
      solver, solveLimit(options.tiebreakTimeLimitMs),
    );
    if (tiebreakSolution === null) {
      throw new Error(`Tiebreak found no layout with market total ${marketBest.marketTotal}, which the market solve just produced`);
    }
    const isTiebreakUsable = !tiebreakSolution.isTimedOut;
    const best = isTiebreakUsable ? scoredLayout(tiebreakSolution) : marketBest;
    if (best.marketTotal !== marketBest.marketTotal || best.buildingTotal < buildingTotalMin) {
      throw new Error(`Solver layout scores (${best.marketTotal}, ${best.buildingTotal}) but the sweep required market ${marketBest.marketTotal} and buildings >= ${buildingTotalMin}`);
    }

    const config = {
      marketTotal: best.marketTotal,
      buildingTotal: best.buildingTotal,
      layout: best.layout,
      owner,
      isProvenOptimal: marketSolution.isProvenOptimal && isTiebreakUsable && tiebreakSolution.isProvenOptimal,
      solveStatistics: [marketSolution.statistics, isTiebreakUsable ? tiebreakSolution.statistics : null].filter(Boolean),
    };
    configs.push(config);
    if (options.onConfig) options.onConfig(config);
    buildingTotalMin = best.buildingTotal + 1;
  }
  return configs;
}

/**
 * Finds up to `maxConfigs` Pareto-optimal layouts for one capture/growth order,
 * highest market total first.
 *
 * This is the two-dimensional sweep the C++ brute force is compared against:
 * the border growths are exactly the ones in `actionOrder`. Use
 * solveBorderGrowthFrontier to search over border growths as well.
 *
 * @param {object} MiniZinc - The `minizinc` package namespace (wasm or native).
 * @param {number[][]} grid - Tile types per cell.
 * @param {{row: number, col: number}[]} cityCenters - City centre per city id.
 * @param {number[]} actionOrder - City ids in capture/growth order.
 * @param {object} [options] - As sweepFrontier, plus:
 * @param {number} [options.sweepTimeBudgetMs] - Rough cap on the whole sweep.
 * @returns {Promise<FrontierConfig[]>}
 */
export async function solveParetoFrontier(MiniZinc, grid, cityCenters, actionOrder, options = {}) {
  const owner = computeOwnership(grid, cityCenters, actionOrder);
  const startedAt = performance.now();
  const budgetLeftMs = () => (options.sweepTimeBudgetMs
    ? Math.max(0, options.sweepTimeBudgetMs - (performance.now() - startedAt))
    : Infinity);
  return sweepFrontier(MiniZinc, grid, owner, cityCenters.length, { ...options, budgetLeftMs });
}

/**
 * How many extra border growths the sweep tries at once, as a fraction of the
 * map's cities. Every combination up to that many is tried, so this fraction
 * is the exponent on the search: the plan count is sum(C(cities, 0..depth)).
 */
export const BORDER_GROWTH_DEPTH_FRACTION = 1 / 3;

/**
 * Ceiling on generated growth plans, so a map with many cities cannot lock the
 * tab up building plans it would never have time to solve. Plans are generated
 * fewest-growths-first, so the cap drops the deepest ones.
 */
const MAX_GROWTH_COMBINATIONS = 2000;

/**
 * The deepest combination of extra border growths worth trying on a map.
 *
 * @param {number} cityCount - Number of cities on the map.
 * @returns {number} At least one growth, and at most a third of the cities.
 */
export function maxExtraBorderGrowths(cityCount) {
  return Math.max(1, Math.floor(cityCount * BORDER_GROWTH_DEPTH_FRACTION));
}

/**
 * Yields every combination of `size` of `items`, in index order.
 *
 * @param {number[]} items - Items to choose from.
 * @param {number} size - How many to choose.
 * @yields {number[]} One combination, in the order the items appear.
 */
function* combinationsOfSize(items, size) {
  const chosen = [];
  function* walk(start) {
    if (chosen.length === size) {
      yield chosen.slice();
      return;
    }
    for (let index = start; index <= items.length - (size - chosen.length); index++) {
      chosen.push(items[index]);
      yield* walk(index + 1);
      chosen.pop();
    }
  }
  yield* walk(0);
}

/**
 * Counts the tiles some city owns.
 *
 * @param {number[][]} owner - Owner per cell from computeOwnership.
 * @returns {number} Cells whose owner is not UNOWNED.
 */
function ownedTileCount(owner) {
  return owner.reduce(
    (total, row) => total + row.reduce((count, cell) => count + (cell === UNOWNED ? 0 : 1), 0), 0);
}

/**
 * @typedef {object} GrowthPlan
 * @property {number[]} growthCities - City ids to border-grow, ascending.
 * @property {number[][]} owner - Ownership after those growths.
 * @property {number} newTileCount - Tiles the growths claim over the base map.
 */

/**
 * Builds the growth plans to try, fewest growths first and, within a growth
 * count, the ones claiming the most new land first — so a sweep cut short by
 * its time budget has spent it on the plans most likely to pay.
 *
 * Extra growths are appended after everything the user already did, which is
 * the question the page is asking: these cities are captured, which should now
 * grow? Growths within one plan go in city id order, so contested tiles fall to
 * the lowest id; other orders of the same set are not tried.
 *
 * Cities that already grew are left alone, as are ones whose growth would claim
 * nothing (their ring is all obstacle, off-map or already owned) — appending
 * actions never takes a tile away, so such a city claims nothing in any plan.
 * Plans that come out with identical ownership are collapsed to one.
 *
 * @param {number[][]} grid - Tile types per cell.
 * @param {{row: number, col: number}[]} cityCenters - City centre per city id.
 * @param {number[]} actionOrder - City ids in capture/growth order.
 * @param {number} maxExtraGrowths - Most growths any one plan may add.
 * @returns {{plans: GrowthPlan[], existingBorderGrowthCount: number}} The plans
 *   in the order to try them, and how many growths `actionOrder` already has.
 */
export function planBorderGrowths(grid, cityCenters, actionOrder, maxExtraGrowths) {
  const actionCountByCity = cityCenters.map((_, cityId) =>
    actionOrder.reduce((count, id) => count + (id === cityId ? 1 : 0), 0));
  const existingBorderGrowthCount = actionCountByCity.filter((count) => count >= 2).length;

  const baseOwner = computeOwnership(grid, cityCenters, actionOrder);
  const baseOwnedCount = ownedTileCount(baseOwner);
  const growableCities = cityCenters
    .map((_, cityId) => cityId)
    .filter((cityId) => actionCountByCity[cityId] === 1)
    .filter((cityId) => ownedTileCount(
      computeOwnership(grid, cityCenters, actionOrder.concat([cityId]))) > baseOwnedCount);

  const plans = [];
  const seenOwnerships = new Set();
  const growthDepth = Math.min(maxExtraGrowths, growableCities.length);
  for (let size = 0; size <= growthDepth && plans.length < MAX_GROWTH_COMBINATIONS; size++) {
    for (const growthCities of combinationsOfSize(growableCities, size)) {
      if (plans.length >= MAX_GROWTH_COMBINATIONS) break;
      const owner = computeOwnership(grid, cityCenters, actionOrder.concat(growthCities));
      const signature = owner.map((row) => row.join(',')).join(';');
      if (seenOwnerships.has(signature)) continue;
      seenOwnerships.add(signature);
      plans.push({ growthCities, owner, newTileCount: ownedTileCount(owner) - baseOwnedCount });
    }
  }
  plans.sort((a, b) => a.growthCities.length - b.growthCities.length || b.newTileCount - a.newTileCount);
  return { plans, existingBorderGrowthCount };
}

/**
 * @typedef {FrontierConfig} GrowthFrontierConfig
 * @property {number} borderGrowthCount - Border growths this layout needs in
 *   total, counting the ones already in `actionOrder`.
 * @property {number[]} extraBorderGrowthCities - City ids to grow on top of
 *   `actionOrder` to reach this layout.
 */

/**
 * Whether `a` is at least as good as `b` on all three objectives and strictly
 * better on one: more market, more buildings, fewer border growths.
 *
 * @param {GrowthFrontierConfig} a - The point that might dominate.
 * @param {GrowthFrontierConfig} b - The point that might be dominated.
 * @returns {boolean}
 */
function dominates(a, b) {
  return a.borderGrowthCount <= b.borderGrowthCount
    && a.marketTotal >= b.marketTotal
    && a.buildingTotal >= b.buildingTotal
    && (a.borderGrowthCount < b.borderGrowthCount
      || a.marketTotal > b.marketTotal
      || a.buildingTotal > b.buildingTotal);
}

/**
 * Whether two points score the same on all three objectives.
 *
 * @param {GrowthFrontierConfig} a - One point.
 * @param {GrowthFrontierConfig} b - The other.
 * @returns {boolean}
 */
function hasSameScores(a, b) {
  return a.borderGrowthCount === b.borderGrowthCount
    && a.marketTotal === b.marketTotal
    && a.buildingTotal === b.buildingTotal;
}

/**
 * Adds a point to a frontier, dropping whatever it dominates. A point that ties
 * one already there is dropped, so the first plan to reach a score keeps it —
 * and since plans are tried fewest-growths-first, that is the cheapest one.
 *
 * @param {GrowthFrontierConfig[]} frontier - Mutated in place.
 * @param {GrowthFrontierConfig} candidate - The point to add.
 * @returns {boolean} Whether the frontier changed.
 */
function addToFrontier(frontier, candidate) {
  if (frontier.some((point) => hasSameScores(point, candidate) || dominates(point, candidate))) return false;
  for (let index = frontier.length - 1; index >= 0; index--) {
    if (dominates(candidate, frontier[index])) frontier.splice(index, 1);
  }
  frontier.push(candidate);
  return true;
}

/**
 * Orders a frontier for display: fewest growths first, best market first.
 *
 * @param {GrowthFrontierConfig[]} frontier - Points in any order.
 * @returns {GrowthFrontierConfig[]} A sorted copy.
 */
function sortedFrontier(frontier) {
  return frontier.slice().sort((a, b) =>
    a.borderGrowthCount - b.borderGrowthCount
    || b.marketTotal - a.marketTotal
    || b.buildingTotal - a.buildingTotal);
}

/**
 * Finds the Pareto frontier over market total, building total and border
 * growths used.
 *
 * Every combination of extra border growths up to maxExtraBorderGrowths() is
 * tried; each gets its own two-dimensional market/building sweep, and the
 * points are merged into one three-dimensional frontier. Plans are tried
 * fewest-growths-first, so the layouts asking least of the user arrive first
 * and a run cut short by its budget has still covered them.
 *
 * A point already on the frontier can be dropped later by a plan with the same
 * growth count that beats it, so callers are handed the whole frontier through
 * `onFrontier` rather than one point at a time.
 *
 * @param {object} MiniZinc - The `minizinc` package namespace (wasm or native).
 * @param {number[][]} grid - Tile types per cell.
 * @param {{row: number, col: number}[]} cityCenters - City centre per city id.
 * @param {number[]} actionOrder - City ids in capture/growth order.
 * @param {object} [options] - As sweepFrontier, plus:
 * @param {number} [options.maxExtraBorderGrowths] - Growth depth to search.
 * @param {number} [options.sweepTimeBudgetMs] - Rough cap on the whole sweep.
 *   No new plan is started once it is spent.
 * @param {number} [options.planTimeBudgetMs] - Rough cap on any single plan, so
 *   one slow plan cannot spend the whole sweep's budget.
 * @param {(frontier: GrowthFrontierConfig[]) => void} [options.onFrontier] -
 *   Called with the whole frontier, in display order, whenever it changes.
 * @returns {Promise<GrowthFrontierConfig[]>} The frontier in display order.
 * @throws {Error} If the solver fails, if no layout at all is found within the
 *   time limits, or if a returned layout does not score what the model claimed.
 */
export async function solveBorderGrowthFrontier(MiniZinc, grid, cityCenters, actionOrder, options = {}) {
  const startedAt = performance.now();
  const budgetLeftMs = () => (options.sweepTimeBudgetMs
    ? Math.max(0, options.sweepTimeBudgetMs - (performance.now() - startedAt))
    : Infinity);

  const maxExtraGrowths = options.maxExtraBorderGrowths ?? maxExtraBorderGrowths(cityCenters.length);
  const { plans, existingBorderGrowthCount } =
    planBorderGrowths(grid, cityCenters, actionOrder, maxExtraGrowths);

  const frontier = [];
  for (const plan of plans) {
    if (frontier.length > 0 && budgetLeftMs() === 0) break;
    const planStartedAt = performance.now();
    const planBudgetLeftMs = () => Math.min(budgetLeftMs(), options.planTimeBudgetMs
      ? Math.max(0, options.planTimeBudgetMs - (performance.now() - planStartedAt))
      : Infinity);

    await sweepFrontier(MiniZinc, grid, plan.owner, cityCenters.length, {
      ...options,
      budgetLeftMs: planBudgetLeftMs,
      throwIfEmptyOnTimeout: frontier.length === 0,
      onConfig: (config) => {
        const hasChanged = addToFrontier(frontier, {
          ...config,
          borderGrowthCount: existingBorderGrowthCount + plan.growthCities.length,
          extraBorderGrowthCities: plan.growthCities.slice(),
        });
        if (hasChanged && options.onFrontier) options.onFrontier(sortedFrontier(frontier));
      },
    });
  }
  return sortedFrontier(frontier);
}

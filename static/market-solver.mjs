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
 */
export const INTERACTIVE_SOLVE_LIMITS = Object.freeze({
  marketTimeLimitMs: 60000,
  tiebreakTimeLimitMs: 15000,
  sweepTimeBudgetMs: 60000,
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
 * @property {boolean} isProvenOptimal - False when a time limit cut a search
 *   short, in which case this is the best layout found rather than the best.
 * @property {object[]} solveStatistics - MiniZinc/solver statistics for each
 *   solve behind this point (market total first, then the building tiebreak).
 */

/**
 * Finds up to `maxConfigs` Pareto-optimal layouts, highest market total first.
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
 * @param {{row: number, col: number}[]} cityCenters - City centre per city id.
 * @param {number[]} actionOrder - City ids in capture/growth order.
 * @param {object} [options]
 * @param {number} [options.maxConfigs] - Frontier points to return.
 * @param {string} [options.solver] - MiniZinc solver tag.
 * @param {number} [options.marketTimeLimitMs] - Cap on each market-total solve.
 *   Unset means solve to proven optimality however long it takes.
 * @param {number} [options.tiebreakTimeLimitMs] - Cap on each building-total
 *   solve. Past it the best building total found is used and the point is
 *   flagged as not proven optimal; the market total stays exact.
 * @param {number} [options.sweepTimeBudgetMs] - Rough cap on the whole sweep.
 *   Per-solve caps shrink to what is left of it, and no new point is started
 *   once it is spent, so the sweep ends with fewer points rather than late.
 * @param {(config: FrontierConfig) => void} [options.onConfig] - Called with
 *   each frontier point as soon as it is found, before the sweep continues.
 * @returns {Promise<FrontierConfig[]>}
 * @throws {Error} If the solver fails, if no layout at all is found within the
 *   time limits, or if a returned layout does not score what the model
 *   claimed (a modelling bug).
 */
export async function solveParetoFrontier(MiniZinc, grid, cityCenters, actionOrder, options = {}) {
  const maxConfigs = options.maxConfigs ?? DEFAULT_MAX_CONFIGS;
  const solver = options.solver ?? DEFAULT_SOLVER;

  const owner = computeOwnership(grid, cityCenters, actionOrder);
  const { tiles, data } = buildPlacementModelData(grid, owner, cityCenters.length);
  const scoredLayout = (solution) => {
    const layout = applyPlacements(grid, tiles, solution.hasBuilding, solution.hasMarket);
    return { layout, ...scoreLayout(layout, owner) };
  };

  const startedAt = performance.now();
  const budgetLeftMs = () => (options.sweepTimeBudgetMs
    ? Math.max(0, options.sweepTimeBudgetMs - (performance.now() - startedAt))
    : Infinity);
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
      throw new Error('No layout found within the time limit');
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
      isProvenOptimal: marketSolution.isProvenOptimal && isTiebreakUsable && tiebreakSolution.isProvenOptimal,
      solveStatistics: [marketSolution.statistics, isTiebreakUsable ? tiebreakSolution.statistics : null].filter(Boolean),
    };
    configs.push(config);
    if (options.onConfig) options.onConfig(config);
    buildingTotalMin = best.buildingTotal + 1;
  }
  return configs;
}

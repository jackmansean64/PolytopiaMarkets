/**
 * Benchmark: how solve time scales with city count, how the solver copes with
 * the hard case of tightly clustered cities on an all-resource map, and what
 * searching over border growths costs on top.
 *
 * The scaling map is 5 rows tall with cities 3 columns apart along the middle
 * row and every other tile a resource, all border-grown; the C++ brute force
 * is run alongside it while it is still feasible. The clustered maps and the
 * border-growth sweep use the same time limits as the page, so the timings
 * show what a user would see. MiniZinc's flatten time is reported separately
 * from Chuffed's solve time, since the flatten step is what emitting FlatZinc
 * directly would remove.
 *
 * Usage: node tools/bench.mjs [maxCities] [maxOracleCities]
 */
import { pathToFileURL } from 'node:url';
import { loadMiniZincWasm } from './minizinc-node.mjs';
import { bruteForceParetoFrontier } from './oracle.mjs';
import {
  solveParetoFrontier,
  solveBorderGrowthFrontier,
  planBorderGrowths,
  maxExtraBorderGrowths,
  INTERACTIVE_SOLVE_LIMITS,
} from '../static/market-solver.mjs';
import { TILE } from '../static/market-rules.mjs';

const DEFAULT_MAX_CITIES = 12;
/** The brute force takes ~40 s at 4 cities and ~90x longer per extra city. */
const DEFAULT_MAX_ORACLE_CITIES = 3;
/** The growth sweep runs a whole frontier per plan, and plans grow combinatorially. */
const MAX_GROWTH_BENCH_CITIES = 7;
const ROW_COUNT = 5;
const CITY_ROW = 2;
const CITY_SPACING = 3;

/**
 * Builds the row map with every city captured, and by default border-grown too.
 *
 * @param {number} cityCount - Cities along the middle row.
 * @param {{isBorderGrown?: boolean}} [options] - Pass isBorderGrown false to
 *   leave the growths for the border-growth sweep to find.
 * @returns {{grid: number[][], cityCenters: {row: number, col: number}[], actionOrder: number[]}}
 */
export function denseMap(cityCount, options = {}) {
  const colCount = CITY_SPACING * cityCount + 2;
  const grid = Array.from({ length: ROW_COUNT }, (_, row) =>
    Array.from({ length: colCount }, (_, col) => ((row + col) % 2 === 0 ? TILE.RESOURCE : TILE.EMPTY)));
  const cityCenters = [];
  for (let cityId = 0; cityId < cityCount; cityId++) {
    const col = 2 + CITY_SPACING * cityId;
    grid[CITY_ROW][col] = TILE.CITY;
    cityCenters.push({ row: CITY_ROW, col });
  }
  const captures = cityCenters.map((_, cityId) => cityId);
  const isBorderGrown = options.isBorderGrown ?? true;
  return { grid, cityCenters, actionOrder: isBorderGrown ? captures.concat(captures) : captures };
}

/**
 * Builds a block of cities 3 apart, all border-grown, on a map where every
 * tile is a resource. This is the worst case seen so far: every building can
 * reach level 8 and every city's borders touch several neighbours', so proving
 * optimality takes real search.
 *
 * @param {number} cityRows - Cities down.
 * @param {number} cityCols - Cities across.
 * @returns {{grid: number[][], cityCenters: {row: number, col: number}[], actionOrder: number[]}}
 */
export function clusteredMap(cityRows, cityCols) {
  const rowCount = CITY_SPACING * cityRows + 2;
  const colCount = CITY_SPACING * cityCols + 2;
  const grid = Array.from({ length: rowCount }, () => Array.from({ length: colCount }, () => TILE.RESOURCE));
  const cityCenters = [];
  for (let i = 0; i < cityRows; i++) {
    for (let j = 0; j < cityCols; j++) {
      const row = 2 + CITY_SPACING * i;
      const col = 2 + CITY_SPACING * j;
      grid[row][col] = TILE.CITY;
      cityCenters.push({ row, col });
    }
  }
  const captures = cityCenters.map((_, cityId) => cityId);
  return { grid, cityCenters, actionOrder: captures.concat(captures) };
}

function formatMs(ms) {
  return `${ms.toFixed(0).padStart(7)} ms`;
}

function formatFrontier(configs) {
  return configs.map((c) => `(${c.marketTotal},${c.buildingTotal})${c.isProvenOptimal === false ? '*' : ''}`).join(' ');
}

async function benchScaling(MiniZinc, maxCities, maxOracleCities) {
  console.log('Scaling: cities in a row, all border-grown, every other tile a resource, no time limits');
  console.log('cities  solver total   flatten (sum)   chuffed (sum)   points   frontier            | brute force');
  for (let cityCount = 2; cityCount <= maxCities; cityCount++) {
    const { grid, cityCenters, actionOrder } = denseMap(cityCount);

    const solverStart = performance.now();
    const configs = await solveParetoFrontier(MiniZinc, grid, cityCenters, actionOrder);
    const solverMs = performance.now() - solverStart;
    const allStatistics = configs.flatMap((c) => c.solveStatistics);
    const flattenMs = allStatistics.reduce((sum, s) => sum + (s.flatTime ?? 0) * 1000, 0);
    const chuffedMs = allStatistics.reduce((sum, s) => sum + (s.solveTime ?? 0) * 1000, 0);
    const frontier = formatFrontier(configs);

    let oracleColumn = 'skipped';
    if (cityCount <= maxOracleCities) {
      const oracleStart = performance.now();
      const oracle = await bruteForceParetoFrontier(grid, cityCenters, actionOrder);
      const oracleMs = performance.now() - oracleStart;
      const oracleFrontier = oracle.map((c) => `(${c.marketTotal},${c.buildingTotal})`).join(' ');
      oracleColumn = `${formatMs(oracleMs)} ${oracleFrontier === frontier ? 'same frontier' : 'MISMATCH ' + oracleFrontier}`;
    }

    console.log(
      `${String(cityCount).padStart(6)}  ${formatMs(solverMs)}   ${formatMs(flattenMs)}      ${formatMs(chuffedMs)}      ${String(configs.length).padStart(3)}      ${frontier.padEnd(20)}| ${oracleColumn}`,
    );
  }
}

async function benchClustered(MiniZinc) {
  console.log("\nHard case: clustered cities, every tile a resource, one fixed set of border growths");
  console.log('(* = best found within the limit, not proven optimal)');
  for (const [cityRows, cityCols] of [[2, 3], [3, 3]]) {
    const { grid, cityCenters, actionOrder } = clusteredMap(cityRows, cityCols);
    const start = performance.now();
    const arrivals = [];
    const configs = await solveParetoFrontier(MiniZinc, grid, cityCenters, actionOrder, {
      ...INTERACTIVE_SOLVE_LIMITS,
      onConfig: (config) => arrivals.push(`${formatFrontier([config])} at ${((performance.now() - start) / 1000).toFixed(1)}s`),
    });
    const totalMs = performance.now() - start;
    console.log(`${cityRows}x${cityCols} cities: ${formatMs(totalMs)} total; ${configs.length} points: ${arrivals.join(', ')}`);
  }
}

async function benchBorderGrowth(MiniZinc, maxCities) {
  console.log("\nBorder-growth sweep: cities in a row, none grown yet, with the page's time limits");
  console.log('(depth is cities/3, rounded down and at least 1; * = a point that is not proven optimal)');
  console.log('cities  depth   plans      total   points   frontier (market,buildings,growths)');
  for (let cityCount = 2; cityCount <= maxCities; cityCount++) {
    const { grid, cityCenters, actionOrder } = denseMap(cityCount, { isBorderGrown: false });
    const depth = maxExtraBorderGrowths(cityCount);
    const { plans } = planBorderGrowths(grid, cityCenters, actionOrder, depth);

    const start = performance.now();
    const frontier = await solveBorderGrowthFrontier(
      MiniZinc, grid, cityCenters, actionOrder, INTERACTIVE_SOLVE_LIMITS);
    const totalMs = performance.now() - start;
    const points = frontier.map((c) =>
      `(${c.marketTotal},${c.buildingTotal},${c.borderGrowthCount})${c.isProvenOptimal === false ? '*' : ''}`).join(' ');

    console.log(
      `${String(cityCount).padStart(6)}  ${String(depth).padStart(5)}   ${String(plans.length).padStart(5)}  ${formatMs(totalMs)}   ${String(frontier.length).padStart(6)}   ${points}`,
    );
  }
}

async function main() {
  const maxCities = Number(process.argv[2] ?? DEFAULT_MAX_CITIES);
  const maxOracleCities = Number(process.argv[3] ?? DEFAULT_MAX_ORACLE_CITIES);
  const MiniZinc = await loadMiniZincWasm();
  try {
    await benchScaling(MiniZinc, maxCities, maxOracleCities);
    await benchClustered(MiniZinc);
    await benchBorderGrowth(MiniZinc, Math.min(maxCities, MAX_GROWTH_BENCH_CITIES));
  } finally {
    MiniZinc.shutdown();
  }
}

const isRunDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isRunDirectly) main();

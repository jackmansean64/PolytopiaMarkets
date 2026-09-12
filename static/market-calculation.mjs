/**
 * Browser entry point for the optimiser: loads the MiniZinc WebAssembly build
 * and exposes calculate() over the page's flat Int32Array contract.
 *
 * MiniZinc runs its solver in its own web worker, so the page stays responsive
 * without a worker of our own. The build is loaded from jsDelivr (pinned) rather
 * than vendored: its wasm is 19 MB, which does not belong in the repo, and the
 * CDN serves it brotli-compressed with a one-year immutable cache.
 */
import * as MiniZinc from 'https://cdn.jsdelivr.net/npm/minizinc@4.5.2/dist/minizinc.mjs';
import { solveBorderGrowthFrontier, INTERACTIVE_SOLVE_LIMITS } from './market-solver.mjs';

/** One solver worker is enough: the frontier sweep solves sequentially. */
const SOLVER_WORKER_COUNT = 1;

/**
 * @typedef {object} PageConfig
 * @property {number} marketTotal
 * @property {number} buildingTotal
 * @property {number} borderGrowthCount - Border growths this layout needs in
 *   total, counting the ones the map already has.
 * @property {number[]} extraBorderGrowthCities - City ids the user would have
 *   to border-grow on top of what the map already has.
 * @property {Int32Array} layout - Tile types, row-major.
 * @property {boolean} isProvenOptimal - False if a time limit cut the search short.
 */

/**
 * Starts loading the solver and returns a calculator bound to it.
 *
 * @returns {{
 *   ready: Promise<void>,
 *   calculate: (request: {
 *     rows: number, cols: number, flatGrid: Int32Array, cityFlat: Int32Array, actionOrder: Int32Array,
 *   }, callbacks?: { onFrontier?: (frontier: PageConfig[]) => void }) => Promise<PageConfig[]>,
 * }} `ready` resolves once the solver can be used; `calculate` waits for it and
 *   reports the frontier through `onFrontier` every time it changes, before
 *   resolving with the final one.
 */
export function createMarketCalculator() {
  const ready = MiniZinc.init({ numWorkers: SOLVER_WORKER_COUNT });

  const toPageConfig = (config) => ({
    marketTotal: config.marketTotal,
    buildingTotal: config.buildingTotal,
    borderGrowthCount: config.borderGrowthCount,
    extraBorderGrowthCities: config.extraBorderGrowthCities.slice(),
    layout: Int32Array.from(config.layout.flat()),
    isProvenOptimal: config.isProvenOptimal,
  });

  async function calculate({ rows, cols, flatGrid, cityFlat, actionOrder }, callbacks = {}) {
    await ready;
    const grid = [];
    for (let row = 0; row < rows; row++) {
      grid.push(Array.from(flatGrid.subarray(row * cols, (row + 1) * cols)));
    }
    const cityCenters = [];
    for (let i = 0; i + 1 < cityFlat.length; i += 2) {
      cityCenters.push({ row: cityFlat[i], col: cityFlat[i + 1] });
    }
    const frontier = await solveBorderGrowthFrontier(MiniZinc, grid, cityCenters, Array.from(actionOrder), {
      ...INTERACTIVE_SOLVE_LIMITS,
      onFrontier: callbacks.onFrontier
        ? (configs) => callbacks.onFrontier(configs.map(toPageConfig))
        : undefined,
    });
    return frontier.map(toPageConfig);
  }

  return { ready, calculate };
}

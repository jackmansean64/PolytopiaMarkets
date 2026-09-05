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
import { solveParetoFrontier, INTERACTIVE_SOLVE_LIMITS } from './market-solver.mjs';

/** One solver worker is enough: the frontier sweep solves sequentially. */
const SOLVER_WORKER_COUNT = 1;

/**
 * @typedef {object} PageConfig
 * @property {number} marketTotal
 * @property {number} buildingTotal
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
 *   }, callbacks?: { onConfig?: (config: PageConfig) => void }) => Promise<PageConfig[]>,
 * }} `ready` resolves once the solver can be used; `calculate` waits for it and
 *   reports each frontier point through `onConfig` as it is found, before
 *   resolving with all of them.
 */
export function createMarketCalculator() {
  const ready = MiniZinc.init({ numWorkers: SOLVER_WORKER_COUNT });

  const toPageConfig = ({ marketTotal, buildingTotal, layout, isProvenOptimal }) => ({
    marketTotal,
    buildingTotal,
    layout: Int32Array.from(layout.flat()),
    isProvenOptimal,
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
    const configs = await solveParetoFrontier(MiniZinc, grid, cityCenters, Array.from(actionOrder), {
      ...INTERACTIVE_SOLVE_LIMITS,
      onConfig: callbacks.onConfig ? (config) => callbacks.onConfig(toPageConfig(config)) : undefined,
    });
    return configs.map(toPageConfig);
  }

  return { ready, calculate };
}

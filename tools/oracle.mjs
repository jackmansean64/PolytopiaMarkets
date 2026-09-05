/**
 * Node wrapper around the original C++ brute-force search (tools/oracle/marketcalc.wasm).
 *
 * The exhaustive search visits every layout, so its Pareto frontier is ground
 * truth. It is exponential in city count, so only use it on small maps.
 */
import createModule from './oracle/marketcalc.js';

/** The wasm entry point returns at most this many frontier configs. */
const MAX_CONFIGS = 3;

const BYTES_PER_INT32 = 4;

let wasmModulePromise = null;

function loadWasm() {
  if (!wasmModulePromise) wasmModulePromise = createModule();
  return wasmModulePromise;
}

/**
 * Runs the exhaustive C++ search and returns its Pareto frontier.
 *
 * @param {number[][]} grid - Tile types per cell.
 * @param {{row: number, col: number}[]} cityCenters - City centre per city id.
 * @param {number[]} actionOrder - City ids in capture/growth order.
 * @returns {Promise<{marketTotal: number, buildingTotal: number, layout: number[][]}[]>}
 *   Up to three frontier configs, sorted by market total descending.
 */
export async function bruteForceParetoFrontier(grid, cityCenters, actionOrder) {
  const wasm = await loadWasm();
  const rowCount = grid.length;
  const colCount = grid[0].length;
  const cellCount = rowCount * colCount;
  const cityFlat = cityCenters.flatMap((center) => [center.row, center.col]);

  const mapPtr = wasm._malloc(cellCount * BYTES_PER_INT32);
  const cityPtr = wasm._malloc(Math.max(cityFlat.length, 1) * BYTES_PER_INT32);
  const actionPtr = wasm._malloc(Math.max(actionOrder.length, 1) * BYTES_PER_INT32);
  const marketTotalsPtr = wasm._malloc(MAX_CONFIGS * BYTES_PER_INT32);
  const buildingTotalsPtr = wasm._malloc(MAX_CONFIGS * BYTES_PER_INT32);
  const layoutsPtr = wasm._malloc(MAX_CONFIGS * cellCount * BYTES_PER_INT32);
  try {
    new Int32Array(wasm.HEAP32.buffer, mapPtr, cellCount).set(grid.flat());
    new Int32Array(wasm.HEAP32.buffer, cityPtr, cityFlat.length).set(cityFlat);
    new Int32Array(wasm.HEAP32.buffer, actionPtr, actionOrder.length).set(actionOrder);

    const configCount = wasm._findParetoFrontier_wasm(
      mapPtr, rowCount, colCount,
      cityPtr, cityCenters.length,
      actionPtr, actionOrder.length,
      marketTotalsPtr, buildingTotalsPtr, layoutsPtr,
    );

    const marketTotals = new Int32Array(wasm.HEAP32.buffer, marketTotalsPtr, MAX_CONFIGS);
    const buildingTotals = new Int32Array(wasm.HEAP32.buffer, buildingTotalsPtr, MAX_CONFIGS);
    const configs = [];
    for (let k = 0; k < configCount; k++) {
      const flat = new Int32Array(wasm.HEAP32.buffer, layoutsPtr + k * cellCount * BYTES_PER_INT32, cellCount);
      const layout = [];
      for (let row = 0; row < rowCount; row++) {
        layout.push(Array.from(flat.subarray(row * colCount, (row + 1) * colCount)));
      }
      configs.push({ marketTotal: marketTotals[k], buildingTotal: buildingTotals[k], layout });
    }
    return configs;
  } finally {
    wasm._free(mapPtr);
    wasm._free(cityPtr);
    wasm._free(actionPtr);
    wasm._free(marketTotalsPtr);
    wasm._free(buildingTotalsPtr);
    wasm._free(layoutsPtr);
  }
}

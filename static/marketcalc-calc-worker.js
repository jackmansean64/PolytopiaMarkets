/**
 * Runs findParetoFrontier wasm off the main thread.
 * Protocol: main posts { type: 'calculate', rows, cols, flatGrid, cityFlat, actionOrder, numCities, numActions }
 * Worker replies { type: 'ready' } | { type: 'initError', message } |
 *   { type: 'ok', configs: [{ marketTotal, buildingTotal, layout: Int32Array }] } (layout buffers transferred) |
 *   { type: 'error', message }
 * configs are up to 3 Pareto-optimal arrangements, sorted descending by marketTotal.
 */
import createModule from './marketcalc.js';

const MAX_CONFIGS = 3;

let wasm = null;

createModule()
  .then((m) => {
    wasm = m;
    self.postMessage({ type: 'ready' });
  })
  .catch((e) => {
    self.postMessage({
      type: 'initError',
      message: e && e.message ? e.message : String(e),
    });
  });

self.onmessage = (ev) => {
  const msg = ev.data;
  if (!msg || msg.type !== 'calculate') return;
  if (!wasm) {
    self.postMessage({ type: 'error', message: 'WASM not initialized in worker.' });
    return;
  }

  const { rows, cols, flatGrid, cityFlat, actionOrder, numCities, numActions } = msg;
  const cells = rows * cols;

  try {
    const mapDataPtr = wasm._malloc(cells * 4);
    const ccPtr = wasm._malloc(cityFlat.length * 4);
    const aoPtr = wasm._malloc(numActions * 4);
    const marketTotalsPtr = wasm._malloc(MAX_CONFIGS * 4);
    const buildingTotalsPtr = wasm._malloc(MAX_CONFIGS * 4);
    const layoutsPtr = wasm._malloc(MAX_CONFIGS * cells * 4);
    try {
      new Int32Array(wasm.HEAP32.buffer, mapDataPtr, cells).set(flatGrid);
      new Int32Array(wasm.HEAP32.buffer, ccPtr, cityFlat.length).set(cityFlat);
      new Int32Array(wasm.HEAP32.buffer, aoPtr, numActions).set(actionOrder);

      const count = wasm._findParetoFrontier_wasm(
        mapDataPtr,
        rows,
        cols,
        ccPtr,
        numCities,
        aoPtr,
        numActions,
        marketTotalsPtr,
        buildingTotalsPtr,
        layoutsPtr,
      );

      const marketTotals = new Int32Array(wasm.HEAP32.buffer, marketTotalsPtr, MAX_CONFIGS);
      const buildingTotals = new Int32Array(wasm.HEAP32.buffer, buildingTotalsPtr, MAX_CONFIGS);
      const configs = [];
      const transfer = [];
      for (let k = 0; k < count; k++) {
        const layout = new Int32Array(cells);
        layout.set(new Int32Array(wasm.HEAP32.buffer, layoutsPtr + k * cells * 4, cells));
        configs.push({
          marketTotal: marketTotals[k],
          buildingTotal: buildingTotals[k],
          layout,
        });
        transfer.push(layout.buffer);
      }
      self.postMessage({ type: 'ok', configs }, transfer);
    } finally {
      wasm._free(mapDataPtr);
      wasm._free(ccPtr);
      wasm._free(aoPtr);
      wasm._free(marketTotalsPtr);
      wasm._free(buildingTotalsPtr);
      wasm._free(layoutsPtr);
    }
  } catch (e) {
    self.postMessage({
      type: 'error',
      message: e && e.message ? e.message : String(e),
    });
  }
};

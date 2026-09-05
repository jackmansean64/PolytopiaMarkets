/**
 * Loads the MiniZinc WebAssembly build inside node, so the exact solver path
 * the browser uses can be exercised headlessly by tests and benchmarks without
 * a native MiniZinc install.
 *
 * The package's browser entry expects DOM worker APIs. This shims just enough
 * to run it: a Worker (via web-worker), a data: URL in place of the blob: URL
 * it bootstraps its worker from, and the worker-global location/require/
 * __dirname that the emscripten loader reads when it detects node.
 *
 * Run node with --no-memory-protection-keys (the npm scripts do). MiniZinc
 * recycles its solver worker every ten runs, and tearing a wasm-heavy worker
 * thread down has intermittently tripped a V8 internal check in its PKU-based
 * JIT protection (ThreadIsolation::UnregisterWasmAllocation) on Node 24.
 */
import Worker from 'web-worker';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const distDir = path.dirname(require.resolve('minizinc/minizinc.wasm'));
const workerFileUrl = pathToFileURL(path.join(distDir, 'minizinc-worker.js')).href;

let miniZincPromise = null;

function installBrowserShims() {
  globalThis.Worker = Worker;

  let lastBlobText = '';
  const NativeBlob = globalThis.Blob;
  globalThis.Blob = class extends NativeBlob {
    constructor(parts, options) {
      super(parts, options);
      lastBlobText = parts.join('');
    }
  };

  const workerGlobalsShim =
    `self.location = { href: ${JSON.stringify(workerFileUrl)} };\n` +
    `self.require = (name) => process.getBuiltinModule(name);\n` +
    `self.__dirname = ${JSON.stringify(distDir)};\n`;
  URL.createObjectURL = () => 'data:text/javascript,' + encodeURIComponent(workerGlobalsShim + lastBlobText);
  URL.revokeObjectURL = () => {};
}

/**
 * Returns the initialised `minizinc` namespace backed by its wasm build.
 *
 * Call `shutdown()` on the returned namespace when finished, otherwise the
 * solver worker threads keep the node process alive.
 *
 * @param {{numWorkers?: number}} [options] - Size of the solver worker pool.
 * @returns {Promise<object>} The MiniZinc namespace, ready to solve.
 */
export function loadMiniZincWasm(options = {}) {
  if (!miniZincPromise) {
    miniZincPromise = (async () => {
      installBrowserShims();
      const MiniZinc = await import(pathToFileURL(path.join(distDir, 'minizinc.mjs')).href);
      await MiniZinc.init({
        numWorkers: options.numWorkers ?? 1,
        workerURL: workerFileUrl,
        wasmURL: path.join(distDir, 'minizinc.wasm'),
        dataURL: path.join(distDir, 'minizinc.data'),
      });
      return MiniZinc;
    })();
  }
  return miniZincPromise;
}

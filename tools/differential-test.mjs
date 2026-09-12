/**
 * Differential test: the constraint solver must produce the same Pareto
 * frontier totals as the original C++ brute-force search.
 *
 * Runs every case in tests/corpus, then a batch of random small maps. Layouts
 * are allowed to differ (many layouts share a score); the (marketTotal,
 * buildingTotal) sequence must match exactly. The JS scorer is checked against
 * the C++ scorer along the way by re-scoring the oracle's layouts.
 *
 * The border-growth frontier is checked the same way, by running the oracle
 * once per growth plan and taking the non-dominated triples of the union. That
 * is one oracle run per plan, which the exponential brute force can only afford
 * on the smallest cases, so it is limited to those.
 *
 * Usage: node tools/differential-test.mjs [randomCaseCount] [seed]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadMiniZincWasm } from './minizinc-node.mjs';
import { bruteForceParetoFrontier } from './oracle.mjs';
import { solveParetoFrontier, solveBorderGrowthFrontier, planBorderGrowths } from '../static/market-solver.mjs';
import { TILE, computeOwnership, scoreLayout } from '../static/market-rules.mjs';

const DEFAULT_RANDOM_CASE_COUNT = 200;
const DEFAULT_SEED = 1;
const CORPUS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'corpus');

/** Random maps stay small enough for the exponential oracle to finish quickly. */
const RANDOM_MAP = Object.freeze({
  minRows: 5, maxRows: 7,
  minCols: 5, maxCols: 8,
  minCities: 1, maxCities: 3,
  minCityDistance: 2,
  borderGrowthProbability: 0.6,
  preplacedBuildingProbability: 0.2,
  preplacedMarketProbability: 0.1,
  tileWeights: [
    [TILE.EMPTY, 35], [TILE.RESOURCE, 40], [TILE.OBSTACLE, 12], [TILE.USED_RESOURCE, 13],
  ],
});

/**
 * Which cases get the border-growth check, and how deep. Each growth plan costs
 * another oracle run, and the oracle is exponential in city count: ~0.4 s at
 * three cities and ~38 s at four. Depth 2 is used rather than the app's
 * cities/3, so that plans growing two cities at once -- where the two growths
 * contest tiles -- are covered even on these small maps.
 */
const GROWTH_CHECK = Object.freeze({
  depth: 2,
  alwaysUpToCities: 2,
  sampledAtCities: 3,
  sampleEveryNthCase: 10,
});

/** Small deterministic PRNG (mulberry32) so failures are reproducible by seed. */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(random, min, max) {
  return min + Math.floor(random() * (max - min + 1));
}

function weightedTile(random) {
  const total = RANDOM_MAP.tileWeights.reduce((sum, [, weight]) => sum + weight, 0);
  let pick = random() * total;
  for (const [tile, weight] of RANDOM_MAP.tileWeights) {
    if (pick < weight) return tile;
    pick -= weight;
  }
  return TILE.EMPTY;
}

function shuffled(random, items) {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function chebyshevDistance(a, b) {
  return Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));
}

/**
 * Generates a random map with valid city spacing, a random capture/growth
 * order, and occasionally a preplaced building or market inside a city.
 */
function randomCase(random, caseIndex) {
  const rowCount = randomInt(random, RANDOM_MAP.minRows, RANDOM_MAP.maxRows);
  const colCount = randomInt(random, RANDOM_MAP.minCols, RANDOM_MAP.maxCols);
  const grid = Array.from({ length: rowCount }, () =>
    Array.from({ length: colCount }, () => weightedTile(random)));

  const cityCenters = [];
  const wantedCities = randomInt(random, RANDOM_MAP.minCities, RANDOM_MAP.maxCities);
  for (let attempt = 0; attempt < 50 && cityCenters.length < wantedCities; attempt++) {
    const candidate = { row: randomInt(random, 0, rowCount - 1), col: randomInt(random, 0, colCount - 1) };
    const isFarEnough = cityCenters.every((c) => chebyshevDistance(c, candidate) >= RANDOM_MAP.minCityDistance);
    if (isFarEnough) cityCenters.push(candidate);
  }
  cityCenters.forEach((center) => { grid[center.row][center.col] = TILE.CITY; });

  const actions = cityCenters.map((_, cityId) => cityId);
  cityCenters.forEach((_, cityId) => {
    if (random() < RANDOM_MAP.borderGrowthProbability) actions.push(cityId);
  });
  const actionOrder = shuffled(random, actions);

  const owner = computeOwnership(grid, cityCenters, actionOrder);
  cityCenters.forEach((_, cityId) => {
    const ownedEmpty = [];
    grid.forEach((row, r) => row.forEach((type, c) => {
      if (owner[r][c] === cityId && type === TILE.EMPTY) ownedEmpty.push({ row: r, col: c });
    }));
    if (ownedEmpty.length >= 2 && random() < RANDOM_MAP.preplacedBuildingProbability) {
      const spot = ownedEmpty.splice(Math.floor(random() * ownedEmpty.length), 1)[0];
      grid[spot.row][spot.col] = TILE.BUILDING;
    }
    if (ownedEmpty.length >= 1 && random() < RANDOM_MAP.preplacedMarketProbability) {
      const spot = ownedEmpty.splice(Math.floor(random() * ownedEmpty.length), 1)[0];
      grid[spot.row][spot.col] = TILE.MARKET;
    }
  });

  return { name: `random-${caseIndex}`, grid, cityCenters, actionOrder, expected: {} };
}

function loadCorpus() {
  return fs.readdirSync(CORPUS_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, file), 'utf8')));
}

function formatTotals(configs) {
  return configs.map((c) => `(${c.marketTotal},${c.buildingTotal})`).join(' ');
}

function formatGrowthTotals(points) {
  return points.map((p) => `(${p.marketTotal},${p.buildingTotal},${p.borderGrowthCount})`).join(' ');
}

/** Whether `a` beats `b` on all three objectives, as market-solver.mjs defines it. */
function growthPointDominates(a, b) {
  return a.borderGrowthCount <= b.borderGrowthCount
    && a.marketTotal >= b.marketTotal
    && a.buildingTotal >= b.buildingTotal
    && (a.borderGrowthCount < b.borderGrowthCount
      || a.marketTotal > b.marketTotal
      || a.buildingTotal > b.buildingTotal);
}

/**
 * The non-dominated triples of a bag of points, deduplicated and ordered. The
 * Pareto set of a set of points is unique, so building it here in one pass is
 * an independent check on the sweep's incremental version.
 *
 * @param {{marketTotal: number, buildingTotal: number, borderGrowthCount: number}[]} points
 * @returns {object[]} The non-dominated points, fewest growths first.
 */
function nonDominatedTriples(points) {
  const seen = new Set();
  return points
    .filter((point) => !points.some((other) => growthPointDominates(other, point)))
    .filter((point) => {
      const key = formatGrowthTotals([point]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.borderGrowthCount - b.borderGrowthCount
      || b.marketTotal - a.marketTotal
      || b.buildingTotal - a.buildingTotal);
}

/**
 * How deep to search border growths for a case, or 0 to skip the check.
 *
 * @param {object} testCase - The case about to run.
 * @param {number} index - Its position in the run, used to sample slower cases.
 * @returns {number} A growth depth, or 0.
 */
function growthCheckDepth(testCase, index) {
  const cityCount = testCase.cityCenters.length;
  if (cityCount <= GROWTH_CHECK.alwaysUpToCities) return GROWTH_CHECK.depth;
  const isSampled = cityCount === GROWTH_CHECK.sampledAtCities
    && index % GROWTH_CHECK.sampleEveryNthCase === 0;
  return isSampled ? GROWTH_CHECK.depth : 0;
}

/**
 * Checks the three-dimensional frontier: it must be exactly the non-dominated
 * triples of the oracle frontiers of every growth plan, and every point must
 * re-score to what it reports against its own ownership.
 *
 * @param {object} MiniZinc - The `minizinc` namespace.
 * @param {object} testCase - The map, cities and action order.
 * @param {number} depth - Extra border growths to search.
 * @returns {Promise<string[]>} Discrepancies found.
 */
async function checkGrowthFrontier(MiniZinc, testCase, depth) {
  const { grid, cityCenters, actionOrder } = testCase;
  const problems = [];
  const { plans, existingBorderGrowthCount } = planBorderGrowths(grid, cityCenters, actionOrder, depth);

  const oraclePoints = [];
  for (const plan of plans) {
    const oracle = await bruteForceParetoFrontier(grid, cityCenters, actionOrder.concat(plan.growthCities));
    for (const config of oracle) {
      oraclePoints.push({
        marketTotal: config.marketTotal,
        buildingTotal: config.buildingTotal,
        borderGrowthCount: existingBorderGrowthCount + plan.growthCities.length,
      });
    }
  }

  let solved;
  try {
    solved = await solveBorderGrowthFrontier(MiniZinc, grid, cityCenters, actionOrder,
      { maxExtraBorderGrowths: depth });
  } catch (error) {
    problems.push(`growth sweep threw: ${error.message}`);
    return problems;
  }

  const expected = formatGrowthTotals(nonDominatedTriples(oraclePoints));
  const actual = formatGrowthTotals(nonDominatedTriples(solved));
  if (actual !== formatGrowthTotals(solved)) {
    problems.push(`growth frontier is not Pareto-optimal within itself: ${formatGrowthTotals(solved)}`);
  }
  if (actual !== expected) {
    problems.push(`growth frontier mismatch over ${plans.length} plans: solver ${actual} vs oracle ${expected}`);
  }
  for (const point of solved) {
    if (point.borderGrowthCount !== existingBorderGrowthCount + point.extraBorderGrowthCities.length) {
      problems.push(`a point reports ${point.borderGrowthCount} growths but lists ${point.extraBorderGrowthCities.length} extra on top of the ${existingBorderGrowthCount} already there`);
    }
    const rescored = scoreLayout(point.layout, point.owner);
    if (rescored.marketTotal !== point.marketTotal || rescored.buildingTotal !== point.buildingTotal) {
      problems.push(`a growth point re-scores as (${rescored.marketTotal},${rescored.buildingTotal}) but reports (${point.marketTotal},${point.buildingTotal})`);
    }
  }
  return problems;
}

function describeCase(testCase) {
  return [
    `  grid: ${JSON.stringify(testCase.grid)}`,
    `  cityCenters: ${JSON.stringify(testCase.cityCenters)}`,
    `  actionOrder: ${JSON.stringify(testCase.actionOrder)}`,
  ].join('\n');
}

/**
 * Runs one case through both searches and returns a list of discrepancies.
 */
async function checkCase(MiniZinc, testCase, index) {
  const problems = [];
  const { grid, cityCenters, actionOrder, expected } = testCase;
  const owner = computeOwnership(grid, cityCenters, actionOrder);

  const oracle = await bruteForceParetoFrontier(grid, cityCenters, actionOrder);
  for (const config of oracle) {
    const rescored = scoreLayout(config.layout, owner);
    if (rescored.marketTotal !== config.marketTotal || rescored.buildingTotal !== config.buildingTotal) {
      problems.push(`JS scorer disagrees with C++ scorer on an oracle layout: js=(${rescored.marketTotal},${rescored.buildingTotal}) cpp=(${config.marketTotal},${config.buildingTotal})`);
    }
  }

  let solved;
  try {
    solved = await solveParetoFrontier(MiniZinc, grid, cityCenters, actionOrder);
  } catch (error) {
    problems.push(`solver threw: ${error.message}`);
    return problems;
  }

  if (formatTotals(solved) !== formatTotals(oracle)) {
    problems.push(`frontier mismatch: solver ${formatTotals(solved)} vs oracle ${formatTotals(oracle)}`);
  }
  if (expected.marketTotal !== undefined && solved[0]?.marketTotal !== expected.marketTotal) {
    problems.push(`expected market total ${expected.marketTotal}, solver gave ${solved[0]?.marketTotal}`);
  }
  if (expected.marketTotalAtLeast !== undefined && !(solved[0]?.marketTotal >= expected.marketTotalAtLeast)) {
    problems.push(`expected market total >= ${expected.marketTotalAtLeast}, solver gave ${solved[0]?.marketTotal}`);
  }

  const growthDepth = growthCheckDepth(testCase, index);
  if (growthDepth > 0) problems.push(...await checkGrowthFrontier(MiniZinc, testCase, growthDepth));
  return problems;
}

async function main() {
  const randomCaseCount = Number(process.argv[2] ?? DEFAULT_RANDOM_CASE_COUNT);
  const seed = Number(process.argv[3] ?? DEFAULT_SEED);
  const MiniZinc = await loadMiniZincWasm();

  let failureCount = 0;
  const startedAt = Date.now();
  try {
    const corpus = loadCorpus();
    const random = makeRandom(seed);
    const cases = corpus.concat(
      Array.from({ length: randomCaseCount }, (_, i) => randomCase(random, i)));

    let growthCheckedCount = 0;
    for (const [index, testCase] of cases.entries()) {
      if (growthCheckDepth(testCase, index) > 0) growthCheckedCount++;
      const problems = await checkCase(MiniZinc, testCase, index);
      if (problems.length === 0) {
        if (index < corpus.length || (index - corpus.length + 1) % 25 === 0) {
          console.log(`ok   ${testCase.name}`);
        }
        continue;
      }
      failureCount++;
      console.log(`FAIL ${testCase.name}`);
      for (const problem of problems) console.log(`  ${problem}`);
      console.log(describeCase(testCase));
    }
    const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`\n${cases.length - failureCount}/${cases.length} cases agree with the brute-force oracle (seed ${seed}, ${elapsedSeconds}s)`);
    console.log(`${growthCheckedCount} of them also had their border-growth frontier checked to depth ${GROWTH_CHECK.depth}`);
  } finally {
    MiniZinc.shutdown();
  }
  process.exitCode = failureCount === 0 ? 0 : 1;
}

const isRunDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isRunDirectly) main();

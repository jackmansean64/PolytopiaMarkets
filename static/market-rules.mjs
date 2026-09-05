/**
 * Polytopia market rules shared by the solver and its verifier: tile type
 * constants, city border ownership, and scoring of a finished layout.
 *
 * This is a direct port of computeOwnership and calculateMarketTotal in
 * marketcalc.cc and must stay behaviourally identical to them, since the C++
 * brute-force search remains the reference oracle for the solver.
 */

/** Tile type codes, matching the constants in marketcalc.h. */
export const TILE = Object.freeze({
  EMPTY: 0,
  CITY: 1,
  OBSTACLE: 2,
  RESOURCE: 3,
  BUILDING: 4,
  MARKET: 5,
  USED_RESOURCE: 6,
});

/** Owner value for a tile inside no city's borders. */
export const UNOWNED = -1;

/** A building gains one level per adjacent uncovered resource, up to this cap. */
export const MAX_BUILDING_LEVEL = 8;

/** A market's level is the sum of adjacent building levels, up to this cap. */
export const MAX_MARKET_LEVEL = 8;

/** Chebyshev radius of the tiles a city claims when first captured (3x3). */
const CAPTURE_RADIUS = 1;

/** Chebyshev radius of the tiles a city claims on border growth (5x5). */
const BORDER_GROWTH_RADIUS = 2;

/** Row/column offsets of the eight tiles adjacent to a tile. */
const ADJACENT_OFFSETS = Object.freeze([
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1], [0, 1],
  [1, -1], [1, 0], [1, 1],
]);

/**
 * Whether a tile type counts as a resource for building levels.
 *
 * @param {number} tileType - A TILE code.
 * @returns {boolean} True for RESOURCE and USED_RESOURCE.
 */
export function isResourceTile(tileType) {
  return tileType === TILE.RESOURCE || tileType === TILE.USED_RESOURCE;
}

/**
 * Calls `visit(row, col)` for each in-bounds tile 8-adjacent to (row, col).
 *
 * @param {number} rowCount - Grid height.
 * @param {number} colCount - Grid width.
 * @param {number} row - Row of the centre tile.
 * @param {number} col - Column of the centre tile.
 * @param {(row: number, col: number) => void} visit - Callback per neighbour.
 */
export function forEachAdjacentTile(rowCount, colCount, row, col, visit) {
  for (const [rowOffset, colOffset] of ADJACENT_OFFSETS) {
    const adjacentRow = row + rowOffset;
    const adjacentCol = col + colOffset;
    if (adjacentRow >= 0 && adjacentRow < rowCount && adjacentCol >= 0 && adjacentCol < colCount) {
      visit(adjacentRow, adjacentCol);
    }
  }
}

/**
 * Computes which city owns each tile after a sequence of captures and border
 * growths.
 *
 * The first time a city appears in `actionOrder` it is captured and claims the
 * unowned, non-obstacle tiles in its 3x3; the second time it border-grows and
 * claims the unowned, non-obstacle tiles in its 5x5 ring. Tiles already owned
 * are never reassigned, so earlier actions win contested tiles.
 *
 * @param {number[][]} grid - Tile types per cell.
 * @param {{row: number, col: number}[]} cityCenters - City centre per city id.
 * @param {number[]} actionOrder - City ids in capture/growth order.
 * @returns {number[][]} Owner city id per cell, or UNOWNED.
 * @throws {Error} If a city id appears more than twice in `actionOrder`.
 */
export function computeOwnership(grid, cityCenters, actionOrder) {
  const rowCount = grid.length;
  const colCount = grid[0].length;
  const owner = grid.map((row) => row.map(() => UNOWNED));
  const timesCitySeen = new Map();

  const claimRing = (cityId, radius) => {
    const center = cityCenters[cityId];
    for (let rowOffset = -radius; rowOffset <= radius; rowOffset++) {
      for (let colOffset = -radius; colOffset <= radius; colOffset++) {
        const isOnRing = Math.max(Math.abs(rowOffset), Math.abs(colOffset)) === radius;
        if (!isOnRing) continue;
        const row = center.row + rowOffset;
        const col = center.col + colOffset;
        const isInBounds = row >= 0 && row < rowCount && col >= 0 && col < colCount;
        if (!isInBounds) continue;
        if (grid[row][col] === TILE.OBSTACLE) continue;
        if (owner[row][col] === UNOWNED) owner[row][col] = cityId;
      }
    }
  };

  for (const cityId of actionOrder) {
    const seenCount = timesCitySeen.get(cityId) ?? 0;
    if (seenCount === 0) {
      const center = cityCenters[cityId];
      owner[center.row][center.col] = cityId;
      claimRing(cityId, CAPTURE_RADIUS);
    } else if (seenCount === 1) {
      claimRing(cityId, BORDER_GROWTH_RADIUS);
    } else {
      throw new Error(`City ID ${cityId} appears more than twice in actionOrder`);
    }
    timesCitySeen.set(cityId, seenCount + 1);
  }
  return owner;
}

/**
 * Scores a finished layout: the building level of every building and the
 * market level of every market, plus their totals.
 *
 * A building's level is the number of adjacent owned resource tiles that are
 * not themselves covered by a building or market. A market's level is the sum
 * of adjacent building levels. Both are capped.
 *
 * @param {number[][]} layout - Tile types with BUILDING/MARKET placed.
 * @param {number[][]} owner - Owner per cell from computeOwnership.
 * @returns {{marketTotal: number, buildingTotal: number, buildingLevel: number[][]}}
 *   Totals plus the level of each building tile (0 elsewhere).
 */
export function scoreLayout(layout, owner) {
  const rowCount = layout.length;
  const colCount = layout[0].length;
  const buildingLevel = layout.map((row) => row.map(() => 0));
  let buildingTotal = 0;
  let marketTotal = 0;

  for (let row = 0; row < rowCount; row++) {
    for (let col = 0; col < colCount; col++) {
      if (layout[row][col] !== TILE.BUILDING || owner[row][col] === UNOWNED) continue;
      let uncoveredResourceCount = 0;
      forEachAdjacentTile(rowCount, colCount, row, col, (adjRow, adjCol) => {
        if (isResourceTile(layout[adjRow][adjCol]) && owner[adjRow][adjCol] !== UNOWNED) {
          uncoveredResourceCount++;
        }
      });
      buildingLevel[row][col] = Math.min(uncoveredResourceCount, MAX_BUILDING_LEVEL);
      buildingTotal += buildingLevel[row][col];
    }
  }

  for (let row = 0; row < rowCount; row++) {
    for (let col = 0; col < colCount; col++) {
      if (layout[row][col] !== TILE.MARKET || owner[row][col] === UNOWNED) continue;
      let adjacentBuildingLevels = 0;
      forEachAdjacentTile(rowCount, colCount, row, col, (adjRow, adjCol) => {
        adjacentBuildingLevels += buildingLevel[adjRow][adjCol];
      });
      marketTotal += Math.min(adjacentBuildingLevels, MAX_MARKET_LEVEL);
    }
  }

  return { marketTotal, buildingTotal, buildingLevel };
}

#include "marketcalc.h"


#include <iostream>
#include <vector>
#include <unordered_map>
#include <algorithm>
#include <climits>
#include <cmath>
#include <functional>
#include <utility>
#include <unordered_set>
// only if needed for debug
#include <iomanip>
#include <cstdint>
#include <cstring>


using std::vector;
using std::pair;
using std::unordered_map;
using std::unordered_set;
using std::find;




/*
Helper function
Checks if a coordinate is within the bounds of the map
*/
bool inBounds(const vector<vector<TileState>>& map, Coord coord) {
    int height = map.size();
    int width = map[0].size();
    return coord.row >= 0 && coord.row < height && coord.col >= 0 && coord.col < width;
}

/*
Defined in marketcalc.h
*/
void computeOwnership(vector<vector<TileState>>& map, 
                      const vector<Coord>& cityCenters,
                      const vector<int>& actionOrder) {
    // cityId -> whether captured
    unordered_map<int, int> timesCitySeen;

    // Simulate border growths in order to get proper ownership map
    for (int orderIdx = 0; orderIdx < (int)actionOrder.size(); orderIdx++) {
        int cityId = actionOrder[orderIdx];
        int cx = cityCenters[cityId].col;
        int cy = cityCenters[cityId].row;
        
        // City has not been captured yet
        // Capture it and compute 3x3
        if (timesCitySeen[cityId] == 0) {
            timesCitySeen[cityId] = 1;

          // Assign city tile itself
          map[cy][cx].owner = cityId;
          
          // Assign 3x3 ownership
          for (int i = 0; i < BASE_TILE_COUNT; i++) {
              int nx = cx + dx[i];
              int ny = cy + dy[i];
              Coord coord = {ny, nx};
              if (inBounds(map, coord) && map[ny][nx].type != OBSTACLE) {
                  // Only assign if unowned
                  // Do not overwrite previous border growths
                  if (map[ny][nx].owner == -1) {
                      map[ny][nx].owner = cityId;
                  }
              }
          }
        }

        else if (timesCitySeen[cityId] == 1) {
          timesCitySeen[cityId] = 2;
          // Assign 5x5 ownership
          for (int i = 0; i < EXPANDED_TILE_COUNT; i++) {
              int nx = cx + dx5[i];
              int ny = cy + dy5[i];
              Coord coord = {ny, nx};
              if (inBounds(map, coord) && map[ny][nx].type != OBSTACLE) {
                  // Only assign if unowned
                  // Do not overwrite previous border growths
                  if (map[ny][nx].owner == -1) {
                      map[ny][nx].owner = cityId;
                  }
              }
          }
        }
        
        else {
          throw std::invalid_argument("City ID " + std::to_string(cityId) + " appears more than twice in actionOrder");
        }
    }

}

/*
Defined in marketcalc.h
*/
bool canPlaceMarket(const BacktrackState& state, Coord coord) {
  int row = coord.row;
  int col = coord.col;
  int cityId = state.map[row][col].owner;

  // Can only place within city borders
  if (cityId == -1) {
    // std::cout << "Cannot place building at (" << row << ", " << col << ") because it is not within city borders." << std::endl;
    return false;
  }

  // Can only place on empty or resource tile
  if (state.map[row][col].type != EMPTY && state.map[row][col].type != RESOURCE) {
    // std::cout << "Cannot place building at (" << row << ", " << col << ") because it is not an empty or resource tile." << std::endl;
    return false;
  }

  // Market exists in city already
  if (state.curMarketsInCity[cityId] != Coord{-1, -1}) {
    return false;
  }

  // Building exists on that exact tile already
  if (state.curBuildingsInCity[cityId] == coord) {
    return false;
  }

  // Check adjacency to at least one building tile
  for (int i = 0; i < BASE_TILE_COUNT; i++) {
    int ny = row + dy[i];
    int nx = col + dx[i];
    Coord adjacentCoord = {ny, nx};
    
    if (inBounds(state.map, adjacentCoord)) {
      int adjacentOwner = state.map[ny][nx].owner;
      if (adjacentOwner != -1 &&
        state.curBuildingsInCity[adjacentOwner] == adjacentCoord) {
        return true;
      }
    }
  }
  // fix?
  return false;
}

/*
Defined in marketcalc.h
*/
bool canPlaceBuilding(const BacktrackState& state, Coord coord) {
  int row = coord.row;
  int col = coord.col;
  int cityId = state.map[row][col].owner;

  // Can only place within city borders
  if (cityId == -1) {
    // std::cout << "Cannot place building at (" << row << ", " << col << ") because it is not within city borders." << std::endl;
    return false;
  }

  // Can only place on empty or resource tile
  if (state.map[row][col].type != EMPTY && state.map[row][col].type != RESOURCE) {
    // std::cout << "Cannot place building at (" << row << ", " << col << ") because it is not an empty or resource tile." << std::endl;
    return false;
  }

  // Building exists in city already
  if (state.curBuildingsInCity[cityId] != Coord{-1, -1}) {
    return false;
  }

  // Market exists on that exact tile already
  if (state.curMarketsInCity[cityId] == coord) {
    return false;
  }

  // Check adjacency to at least one resource tile
  // which is not covered and owned
  for (int i = 0; i < BASE_TILE_COUNT; i++) {
    int nx = col + dx[i];
    int ny = row + dy[i];
    Coord adjacentCoord = {ny, nx};
    if (inBounds(state.map, adjacentCoord)) {
      int adjacentOwner = state.map[ny][nx].owner;
      if (adjacentOwner != -1 &&
        (state.map[ny][nx].type == RESOURCE || 
        state.map[ny][nx].type == USED_RESOURCE) && 
        find(state.curBuildingsInCity.begin(), state.curBuildingsInCity.end(), adjacentCoord) == state.curBuildingsInCity.end() && 
        find(state.curMarketsInCity.begin(), state.curMarketsInCity.end(), adjacentCoord) == state.curMarketsInCity.end()) {
        return true;
      }
    }
  }

  // std::cout << "Cannot place building at (" << row << ", " << col << ") because it is not adjacent to any uncovered resource tiles." << std::endl;
  // fix?
  return false;
}

/*
Defined in marketcalc.h
*/
int backtrackPlacements(BacktrackState& state, int cityIdx, bool placingBuilding) {
  // Base case (step 3): cityIdx is at the end and placingBuilding is false, calculate market total
  if (!placingBuilding && cityIdx == (int)state.cityCenters.size()) {
    state.bestLayoutReturn = state.map;
    for (int i = 0; i < (int)state.curBuildingsInCity.size(); i++) {
      Coord c = state.curBuildingsInCity[i];
      if (c != Coord{-1, -1}) {
        state.bestLayoutReturn[c.row][c.col].type = BUILDING;
      }
    }
    for (int i = 0; i < (int)state.curMarketsInCity.size(); i++) {
      Coord c = state.curMarketsInCity[i];
      if (c != Coord{-1, -1}) {
        state.bestLayoutReturn[c.row][c.col].type = MARKET;
      }
    }
    int result = calculateMarketTotal(state);

    // If a Pareto collector is attached, also record this complete layout's
    // building total. calculateMarketTotal just populated buildingLevelsCurrent,
    // so summing it gives the total building level for this arrangement.
    if (state.pareto != nullptr) {
      int buildingTotal = 0;
      for (int lvl : state.buildingLevelsCurrent) {
        buildingTotal += lvl;
      }
      state.pareto->offer(result, buildingTotal, state.bestLayoutReturn);
    }

    return result;
  }

  int bestMarketTotal = 0;
  // Adds cityCenters.size() if not placing buildings (since markets are placed after)
  int recursionDepth = cityIdx + (placingBuilding ? 0 : (int)state.cityCenters.size());
  vector<vector<TileState>>& tempLayout = state.tempLayouts.at(recursionDepth);

  // Recursive case 2 (step 2): PLACE A MARKET 
  // (placingBuilding is false, OR placingBuilding is true AND cityIdx is at the end)
  if (!placingBuilding || cityIdx == (int)state.cityCenters.size()) {
    // we just finished placing all the buildings so we hit the end
    // now we transition to placing markets
    if (placingBuilding && cityIdx == (int)state.cityCenters.size()) {
      cityIdx = 0;
      placingBuilding = false;
    }
    // Guarenteed choice: we may decide not to place a market
    // Set best total and place returned best layout into tempLayout
    bestMarketTotal = backtrackPlacements(state, cityIdx + 1, placingBuilding);
    tempLayout = state.bestLayoutReturn;

    // If no markets exist in this city, we may try placing markets in all valid tiles
    const auto& placeableTiles = state.tilesOwnedByCity.at(cityIdx);
    for (const auto& tile : placeableTiles) {
        if (canPlaceMarket(state, tile)) {
            // Place market
            state.curMarketsInCity.at(cityIdx) = tile;

            // Recurse to next city and placing market
            int result = backtrackPlacements(state, cityIdx + 1, placingBuilding);
            if (result > bestMarketTotal) {
              bestMarketTotal = result;
              // Set our current best layout to the returned layout as it is better
              // Copy bestLayoutReturn to tempLayout
              tempLayout = state.bestLayoutReturn;
            }

            // Backtrack
            state.curMarketsInCity.at(cityIdx) = Coord{-1, -1};
        }
    }
  }

  // Recursive case 1 (step 1): place a building (placingBuilding is true and cityIdx is in bounds)
  else if (placingBuilding && cityIdx >= 0 && cityIdx < (int)state.cityCenters.size()) {
    const auto& placeableTiles = state.tilesOwnedByCity.at(cityIdx);


    // Guarenteed choice: we may decide not to place a building
    bestMarketTotal = backtrackPlacements(state, cityIdx + 1, placingBuilding);
    tempLayout = state.bestLayoutReturn;

    // Attempt to place a building in each tile
    // Update all nearby building and market levels
    // Backtrack from there
    for (const auto& tile : placeableTiles) {
        if (canPlaceBuilding(state, tile)) {
            // Place building
            state.curBuildingsInCity[cityIdx] = tile;

            // Recurse to next city and placing market
            int result = backtrackPlacements(state, cityIdx + 1, placingBuilding);
            if (result > bestMarketTotal) {
              bestMarketTotal = result;
              // Set our current best layout to the returned layout as it is better
              tempLayout = state.bestLayoutReturn;
            }

            // Backtrack
            state.curBuildingsInCity[cityIdx] = Coord{-1, -1};
        }
    }
  }

  else {
    throw std::invalid_argument("Invalid state in backtrackPlacements: placingBuilding is " + std::to_string(placingBuilding) + " and cityIdx is " + std::to_string(cityIdx));
  }
  // Copy tempLayout to bestLayoutReturn
  state.bestLayoutReturn = tempLayout;
  
  return bestMarketTotal;
}

/*
Defined in marketcalc.h
*/
int calculateMarketTotal(const BacktrackState& state) {
  // Calculate all building levels
  
  for (int i = 0; i < (int)state.curBuildingsInCity.size(); i++) {
    Coord buildingCoord = state.curBuildingsInCity[i];

    // No building in city = 0 level
    if (buildingCoord == Coord{-1, -1}) {
      state.buildingLevelsCurrent[i] = 0;
      continue;
    }
    // Go 8 directionally and add up all the uncovered resource tiles
    int buildingLevel = 0;
    for (int j = 0; j < BASE_TILE_COUNT; j++) {
      int ny = buildingCoord.row + dy[j];
      int nx = buildingCoord.col + dx[j];
      Coord adjacentCoord = {ny, nx};
      if (inBounds(state.map, adjacentCoord)) {
        int owner = state.map[ny][nx].owner;
        int type = state.map[ny][nx].type;
        if ((type == RESOURCE || type == USED_RESOURCE) &&
          owner != -1 &&
          state.curBuildingsInCity[owner] != adjacentCoord &&
          state.curMarketsInCity[owner] != adjacentCoord) {
        buildingLevel++;
        }
      }
    }
    state.buildingLevelsCurrent[i] = std::min(buildingLevel, MAX_BUILDING_LEVEL);
  }

  int totalMarketLevel = 0;

  // Next, calculate all market levels
  for (int i = 0; i < (int)state.curMarketsInCity.size(); i++) {
    Coord marketCoord = state.curMarketsInCity[i];

    // No market in city = 0 level
    if (marketCoord == Coord{-1, -1}) {
      continue;
    }
    int marketLevel = 0;
    for (int j = 0; j < BASE_TILE_COUNT; j++) {
      int ny = marketCoord.row + dy[j];
      int nx = marketCoord.col + dx[j];
      Coord adjacentCoord = {ny, nx};
      if (inBounds(state.map, adjacentCoord)) {
        int adjacentCoordOwner = state.map[ny][nx].owner;
        // If adjacent tile is a building, add it

        // Must be in curBulidingInCity
        if (adjacentCoordOwner != -1) {
          if (state.curBuildingsInCity[adjacentCoordOwner] == adjacentCoord) {
            marketLevel += state.buildingLevelsCurrent[adjacentCoordOwner];
          }
        }
      }
    }
    marketLevel = std::min(marketLevel, MAX_MARKET_LEVEL);
    totalMarketLevel += marketLevel;
  }


  return totalMarketLevel;
}

/*
Defined in marketcalc.h
*/
void ParetoAccumulator::offer(int marketTotal, int buildingTotal,
                              const vector<vector<TileState>>& layout) {
  // Dominated by (or equal to) an existing frontier point? Then discard.
  for (const auto& p : frontier) {
    if (p.marketTotal >= marketTotal && p.buildingTotal >= buildingTotal) {
      return;
    }
  }

  // This point is non-dominated. Drop any existing points it dominates, then
  // keep it. The layout copy happens here, only for points worth keeping.
  frontier.erase(
    std::remove_if(frontier.begin(), frontier.end(),
      [&](const ParetoConfig& p) {
        return marketTotal >= p.marketTotal && buildingTotal >= p.buildingTotal;
      }),
    frontier.end());
  frontier.push_back(ParetoConfig{marketTotal, buildingTotal, layout});
}

/*
Defined in marketcalc.h
*/
ParetoResult findParetoFrontier(vector<vector<int>>& map,
                                const vector<Coord>& cityCenters,
                                const vector<int>& actionOrder) {
  // Build the ownership map, gather the tiles owned by each city, and seed any
  // preplaced buildings/markets, then run the backtracking search.
  vector<vector<TileState>> tileMap(map.size(), vector<TileState>(map[0].size()));
  for (int i = 0; i < (int)map.size(); i++) {
    for (int j = 0; j < (int)map[0].size(); j++) {
      tileMap[i][j] = TileState{-1, map[i][j]};
    }
  }

  computeOwnership(tileMap, cityCenters, actionOrder);

  vector<vector<Coord>> tilesOwnedByCity(cityCenters.size());
  for (int row = 0; row < (int)tileMap.size(); row++) {
    for (int col = 0; col < (int)tileMap[0].size(); col++) {
      int cityId = tileMap[row][col].owner;
      if (cityId != -1) {
        tilesOwnedByCity[cityId].push_back(Coord{row, col});
      }
    }
  }

  vector<Coord> curBuildingsInCity(cityCenters.size(), Coord{-1, -1});
  vector<Coord> curMarketsInCity(cityCenters.size(), Coord{-1, -1});
  for (int i = 0; i < (int)tileMap.size(); i++) {
    for (int j = 0; j < (int)tileMap[0].size(); j++) {
      int cityId = tileMap[i][j].owner;
      if (tileMap[i][j].type == BUILDING) {
        if (curBuildingsInCity[cityId] != Coord{-1, -1}) {
          throw std::invalid_argument("Multiple buildings in city " + std::to_string(cityId));
        }
        curBuildingsInCity[cityId] = Coord{i, j};
      }
      else if (tileMap[i][j].type == MARKET) {
        if (curMarketsInCity[cityId] != Coord{-1, -1}) {
          throw std::invalid_argument("Multiple markets in city " + std::to_string(cityId));
        }
        curMarketsInCity[cityId] = Coord{i, j};
      }
    }
  }

  vector<vector<TileState>> bestLayoutReturn = tileMap;
  vector<vector<vector<TileState>>> tempLayouts(2 * cityCenters.size(), tileMap);
  vector<int> buildingLevelsCurrent(cityCenters.size(), 0);

  ParetoAccumulator acc;
  BacktrackState state{
    tileMap,
    cityCenters,
    tilesOwnedByCity,

    curBuildingsInCity,
    curMarketsInCity,
    bestLayoutReturn,
    tempLayouts,
    buildingLevelsCurrent,
    &acc,
  };

  // Visits every leaf; the accumulator records the non-dominated layouts.
  backtrackPlacements(state, 0, true);

  // Surface the frontier points with the highest market totals first.
  std::sort(acc.frontier.begin(), acc.frontier.end(),
    [](const ParetoConfig& a, const ParetoConfig& b) {
      if (a.marketTotal != b.marketTotal) return a.marketTotal > b.marketTotal;
      return a.buildingTotal > b.buildingTotal;
    });

  ParetoResult result;
  for (int i = 0; i < (int)acc.frontier.size() && i < 3; i++) {
    result.configs.push_back(acc.frontier[i]);
  }
  return result;
}


/*
REAL WASM FUNC
*/

extern "C" {
    /*
    Pareto frontier search, called from the worker.

    Inputs:
      mapData, rows, cols: row-major grid of tile-type ints, rows*cols total
      cityCenterData, numCities: 2 ints (row, col) per city, 2*numCities total
      actionOrderData, actionOrderSize: one city ID per action (capture, then growth)

    Outputs (caller-allocated, sized for up to 3 configs):
      outMarketTotals:   int[3], market total for each returned config
      outBuildingTotals: int[3], building total for each returned config
      outLayouts:        int[3 * rows * cols], the layouts back to back; config
                         k occupies [k*rows*cols, (k+1)*rows*cols)

    Returns: the number of configs actually written (1..3).
    */
    int32_t findParetoFrontier_wasm(int32_t* mapData, int32_t rows, int32_t cols,
                                    int32_t* cityCenterData, int32_t numCities,
                                    int32_t* actionOrderData, int32_t actionOrderSize,
                                    int32_t* outMarketTotals,
                                    int32_t* outBuildingTotals,
                                    int32_t* outLayouts) {
        vector<vector<int>> map(rows, vector<int32_t>(cols));
        for (int i = 0; i < rows; i++) {
            for (int j = 0; j < cols; j++) {
                map[i][j] = mapData[i * cols + j];
            }
        }

        vector<Coord> cityCenters(numCities);
        for (int i = 0; i < numCities; i++) {
            cityCenters[i] = Coord{cityCenterData[2 * i], cityCenterData[2 * i + 1]};
        }

        vector<int> actionOrder(actionOrderSize);
        for (int i = 0; i < actionOrderSize; i++) {
            actionOrder[i] = actionOrderData[i];
        }

        ParetoResult result = findParetoFrontier(map, cityCenters, actionOrder);

        int32_t n = (int32_t)result.configs.size();
        if (n > 3) n = 3;
        for (int32_t k = 0; k < n; k++) {
            const ParetoConfig& cfg = result.configs[k];
            outMarketTotals[k] = cfg.marketTotal;
            outBuildingTotals[k] = cfg.buildingTotal;
            int32_t base = k * rows * cols;
            for (int i = 0; i < rows; i++) {
                for (int j = 0; j < cols; j++) {
                    outLayouts[base + i * cols + j] = cfg.layout[i][j].type;
                }
            }
        }
        return n;
    }
}


#ifndef MARKETCALC_H_
#define MARKETCALC_H_

#include <iostream>
#include <vector>
#include <functional>
#include <utility>

using std::pair;
using std::vector;

#define MAX_BUILDING_LEVEL 8
#define MAX_MARKET_LEVEL 8



/*
Future tiles: tiles have 3 separate attributes
1. base tile (field, water, mountain)
2. tile modifier (forest, crop, metal)
3. tile feature (market, building, forge, mine, farm, lumber hut, etc.)
      unused: (fruit, animal, fish, etc.)
*/

// Tile type constants
constexpr int EMPTY = 0;
constexpr int CITY = 1;
constexpr int OBSTACLE = 2;
constexpr int RESOURCE = 3;
constexpr int BUILDING = 4;
constexpr int MARKET = 5;
constexpr int USED_RESOURCE = 6;

struct TileState {
  int owner; // city ID that owns this tile, or -1 if unowned
  int type; // tile type (EMPTY, CITY, OBSTACLE, RESOURCE, BUILDING, MARKET)

  bool operator==(const TileState& other) const {
    return owner == other.owner && type == other.type;
  }

  bool operator!=(const TileState& other) const {
    return !(*this == other);
  }
};

struct Coord {
  int row;
  int col;

  bool operator==(const Coord& other) const {
    return row == other.row && col == other.col;
  }

  bool operator!=(const Coord& other) const {
    return !(*this == other);
  }
};

// One Pareto-optimal configuration: a layout and its two objective totals.
// marketTotal: sum of all market levels.
// buildingTotal: sum of all building levels (each building gains a level per
//   adjacent uncovered resource). A building only feeds a market when adjacent
//   to one, so these two objectives can trade off against each other.
struct ParetoConfig {
  int marketTotal;
  int buildingTotal;
  vector<vector<TileState>> layout;
};

// Result of the Pareto frontier search: up to 3 non-dominated configurations.
struct ParetoResult {
  vector<ParetoConfig> configs;
};

// Forward declaration; full definition follows BacktrackState since it only
// needs to be pointed at from there.
struct ParetoAccumulator;

// State structure
struct BacktrackState {
    // EVERYTHING MUST BE CONSISTENT WITH EACH OTHER

    // Ownership and tile map
    const vector<vector<TileState>>& map; 

    // cityCenters[i] corresponds to city ID i
    const vector<Coord>& cityCenters; 

    // tilesOwnedByCity[cityId] gives list of coordinates
    const vector<vector<Coord>>& tilesOwnedByCity;

    // Requires: quick access to buildings/markets per city for at most 1 checks
    //           quick access to buildings/markets per tile for adjacency checks
    // List of building/market coordinates for each city
    // curBuildingsInCity[i] corresponds to city ID i
    // Coord will be invalid (-1, -1) if not placed

    vector<Coord>& curBuildingsInCity;
    vector<Coord>& curMarketsInCity;


    // Returns through this
    vector<vector<TileState>>& bestLayoutReturn;

    // Temp layouts that each recursion depth will use
    // Invariant: Recursion depth i only uses layouts[i]
    vector<vector<vector<TileState>>>& tempLayouts;

    // Temp data structure for building levels
    // Cleared upon start of calculateMarketTotal and is only used there
    vector<int>& buildingLevelsCurrent;

    // Optional Pareto frontier collector. When non-null, backtrackPlacements
    // submits every complete layout's (marketTotal, buildingTotal) pair here.
    // When null (the default), the search behaves exactly as the single-best
    // market search and this field is ignored.
    ParetoAccumulator* pareto = nullptr;
};

// Collects the non-dominated set of (marketTotal, buildingTotal) layouts seen
// during backtracking. Both objectives are maximized: a point dominates another
// when it is greater-or-equal on both totals.
struct ParetoAccumulator {
  vector<ParetoConfig> frontier;

  // Offer a complete layout. It is kept only if no existing point dominates it;
  // any existing points it dominates are removed first. Exact duplicates are
  // ignored. The layout is copied only when the point is actually kept.
  void offer(int marketTotal, int buildingTotal,
             const vector<vector<TileState>>& layout);
};

inline void prettyPrint(const vector<vector<TileState>>& map) {
  for (const auto& row : map) {
    for (const auto& tile : row) {
      char c;
      switch (tile.type ) {
        case EMPTY: c = '.'; break;
        case CITY: c = 'C'; break;
        case OBSTACLE: c = 'X'; break;
        case RESOURCE: c = 'R'; break;
        case BUILDING: c = 'B'; break;
        case MARKET: c = 'M'; break;
        case USED_RESOURCE: c = 'R'; break;
        default: c = '?';
      }
      std::cout << c << " ";
    }
    std::cout << std::endl;
  }
}

// Direction offsets for 8-neighbor adjacency
constexpr int dx[] = {-1, -1, -1, 0, 0, 1, 1, 1};
constexpr int dy[] = {-1, 0, 1, -1, 1, -1, 0, 1};
constexpr int BASE_TILE_COUNT = 8;

// Direction offsets for extra 5x5 tiles
constexpr int dx5[] = {-2, -1, 0, 1, 2,
                      -2,            2,
                      -2,            2,
                      -2,            2,
                      -2, -1, 0, 1, 2};
constexpr int dy5[] = {-2, -2, -2, -2, -2,
                      -1,              -1,
                       0,               0,
                       1,               1,
                       2,  2,  2,  2,  2};
constexpr int EXPANDED_TILE_COUNT = 16;

/*
Compute ownership map based on city centers, capture order, and growth order.
Rules:
  - The map is a grid of tiles containing city centers (row, col).
      Cities are guarenteed to be at least 2 tiles away from each other both orthogonally and diagonally.
      This prevents cities from owning other city centers.
  - Two actions may be done: city capture and border growth.
  - Each city always owns its own tile. 
  - When captured, each city tries to claim each tile in the 3x3 area centered on itself,
    unless a tile is already claimed by another city (tilestate.owner != -1) or is an obstacle.
  - When border growthed, each city tries to claim each tile in the 5x5 area centered on itself,
    unless a tile is already claimed by another city (tilestate.owner != -1) or is an obstacle.
  - Consequently, if multiple cities are competing for ownership of the same tile,
    the first city which captures/grows into that tile will claim it.

NOTE: for simplicity, mountains are treated as obstacles.
      Forge markets cannot be calculated here, different logic.

Arguments:
map: 2D grid of TileStates
      tilestate.type can be EMPTY, CITY, OBSTACLE, RESOURCE, BUILDING, MARKET
      tilestate.owner should all be unowned (-1) at the start
cityCenters: list of (row, col) coordinates for city centers which are claimed
      cityCenters[i] corresponds to city ID i
actionOrder: order in which each city is captured and border growths  
      The first occurence of a city ID captures the city
      The second occurence of a city ID border growths
      All city IDs in cityCenters must appear in the map (but not necessarily the other way around).
      All city IDs in actionOrder must be in cityCenters.
      All city IDs in cityCenters must appear at least once in actionOrder, but at most twice.
    
Modifies:
Input map - marks each tile's owner field with the city ID that owns it, or -1 if unowned

*/
void computeOwnership(vector<vector<TileState>>& map, 
                      const vector<Coord>& cityCenters,
                      const vector<int>& actionOrder);

/*
Checks if a market is allowed to be placed on a tile, based off a BacktrackState
which contains ownership, current building placements and market placements

Rules:
- Market must be placed within city-owned tiles
- A city may only own up to 1 market
- Markets must be 8-direction adjacent to at least 1 building tile
    NOTE: We do not care about the case where we place on the last resource 
          used by another building, even though that is technically invalid
          in-game, as we will never want to do that in an optimal solution. 
          This simplifies our backtracking logic significantly.
- Can only be placed on empty or UNUSED resource tile
- Cannot be placed on a tile already occupied by another building or market

Arguments:
state: current backtracking state
coord: coordinates of the tile to check

Returns: 
true if we can place a market, false otherwise
*/
bool canPlaceMarket(const BacktrackState& state, Coord coord);

/*
Checks if a building is allowed to be placed on a tile, based off a BacktrackState
which contains ownership, current building placements and market placements

Rules:
- Building must be placed within city-owned tiles
- A city may only own up to 1 building
- Building must be 8-direction adjacent to at least 1 resource tile
    which does not have a building or market on it already
    NOTE: We do not care about the case where we place on the last resource 
          used by another building, even though that is technically invalid
          in-game, as we will never want to do that in an optimal solution. 
          This simplifies our backtracking logic significantly.
- Can only be placed on empty or UNUSED resource tile
- Cannot be placed on a tile already occupied by another building or market

Arguments:
state: current backtracking state
coord: coordinates of the tile to check

Returns: 
true if we can place a building, false otherwise
*/
bool canPlaceBuilding(const BacktrackState& state, Coord coord);

/*
Given an existing state, recursively place buildings and markets
in all possible configurations, then return the best one found.
Only places buildings and markets, does not modify border growths or captures.
NOTE: "Best" is typically defined as highest market total
  However, changing the comparison operator in BacktrackState allows us
  to break ties or have a different criteria

Try placing a building at cityIdx (or no place), then recurse to cityIdx + 1
  till it hits the last city.
Then try placing a market (or no place) at cityIdx, then recurse to cityIdx + 1
  till it hits the last city.
At the end, calculate market total and update best layout if needed.

Args:
state: current backtracking state
      which should have consistent ownership, building placements, and market placements

      Data in the following fields will be destroyed and they will be used
      tempLayouts has length of max recursion depth (2 * cityCenters.size())
        each item has same dimensions as map
        Recursion depth i (cityIdx + -placingBuilding * cityCenters.size()) only uses tempLayouts[i]
      bestLayoutReturn must have same dimensions as map
      buildingLevelsCurrent must have same size as cityCenters
cityIdx: which city we are currently trying to place a building/market for, corresponds to city ID
placingBuilding: true if placing building, false if placing market

Returns: best market total found
  Best layout is stored in state.bestLayoutReturn
*/
int backtrackPlacements(BacktrackState& state, int cityIdx, bool placingBuilding);



/*
Given a state, calculate total market level.
Rules:
- Building level is determined by adjacency to UNCOVERED resource tiles, up to MAX_BUILDING_LEVEL
- Market level is determined by sum of adjaicent building levels (up to MAX_MARKET_LEVEL)
- Total market level is the sum of all individual market levels.

Args:
state: current backtracking state
  curBuidingsInCity and curMarketsInCity should be a superset of
  all buildings and markets in the map
  Use that to calculate

Returns: total market level
*/
int calculateMarketTotal(const BacktrackState& state);


/*
Given a map and a capture/growth order, find the best market layouts by
optimizing two objectives at once: total market level AND total building level
(each building gains a level per adjacent uncovered resource). Returns up to 3
Pareto-optimal configurations (arrangements where you cannot improve one
objective without sacrificing the other), chosen as the frontier points with the
highest market totals and sorted descending by market total.

Throws if invalid input is given (e.g. cities too close, too many
buildings/markets placed, invalid city IDs, cityCenters does not match the map).

Args:
map: 2D grid of ints representing tile types (EMPTY, CITY, OBSTACLE, RESOURCE)
cityCenters: list of (row, col) coordinates for city centers which are claimed
      cityCenters[i] corresponds to city ID i
actionOrder: order in which each city is captured and border growths
      (SAME DEF AS COMPUTEOWNERSHIP)
      The first occurence of a city ID captures the city
      The second occurence of a city ID border growths
      All city IDs in actionOrder must be in cityCenters.
      All city IDs in cityCenters must appear at least once in actionOrder, but at most twice.

Return:
ParetoResult: up to 3 ParetoConfigs, each with marketTotal, buildingTotal, and layout
*/
ParetoResult findParetoFrontier(vector<vector<int>>& map,
                                const vector<Coord>& cityCenters,
                                const vector<int>& actionOrder);


#endif // MARKETCALC_H_
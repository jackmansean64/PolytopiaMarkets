#include "marketcalc_test_common.h"

#include <gtest/gtest.h>

/*
More complex tests for backtrack testing
Basically testing everything



2 city best layouts with/without BG

3 city best layouts with/without BG



*/


TEST(full, TwoCitiesMaxMarkets) {
  vector<vector<int>> map = {
    {EMPTY, RESOURCE, RESOURCE, RESOURCE, RESOURCE, EMPTY},
    {EMPTY, CITY, RESOURCE, RESOURCE, CITY, EMPTY},
    {EMPTY, RESOURCE, RESOURCE, RESOURCE, RESOURCE, EMPTY},
  };
  vector<Coord> cityCenters = {Coord{1, 1}, Coord{1, 4}};
  vector<int> actionOrder = {0, 1};

  auto start = std::chrono::high_resolution_clock::now();
  ParetoResult result = findParetoFrontier(map, cityCenters, actionOrder);
  auto end = std::chrono::high_resolution_clock::now();
  auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(end - start);
  std::cout << "Time taken (2 cities): " << duration.count() << " ms" << std::endl;
  // configs[0] is the highest-market frontier point (the old "best market" layout).
  ASSERT_FALSE(result.configs.empty());
  const auto& best = result.configs[0];
  EXPECT_EQ(best.marketTotal, 16);
  // Expect 2 bulidings between the cities
  EXPECT_EQ(best.layout[1][2].type, BUILDING);
  EXPECT_EQ(best.layout[1][3].type, BUILDING);

  // Exactly one of each of these should be a market, as only 1 building per city
  EXPECT_TRUE((best.layout[0][2].type == MARKET) != (best.layout[2][2].type == MARKET));
  EXPECT_TRUE((best.layout[0][3].type == MARKET) != (best.layout[2][3].type == MARKET));
}

TEST(full, Scenario1_BeatsHuman) {
  // See image examples/Scenario1.png for reference
  vector<vector<int>> map = {
    {RESOURCE, OBSTACLE, RESOURCE, RESOURCE, RESOURCE, RESOURCE, RESOURCE},
    {RESOURCE, CITY, RESOURCE, EMPTY, RESOURCE, CITY, OBSTACLE},
    {RESOURCE, EMPTY, RESOURCE, EMPTY, RESOURCE, OBSTACLE, OBSTACLE},
    {EMPTY, OBSTACLE, EMPTY, RESOURCE, EMPTY, OBSTACLE, OBSTACLE},
    {OBSTACLE, RESOURCE, CITY, RESOURCE, RESOURCE, RESOURCE, RESOURCE},
    {EMPTY, RESOURCE, RESOURCE, RESOURCE, RESOURCE, CITY, EMPTY},
    {OBSTACLE, EMPTY, EMPTY, OBSTACLE, RESOURCE, RESOURCE, EMPTY}
  };
  vector<Coord> cityCenters = {Coord{1, 1}, Coord{1, 5}, Coord{4, 2} , Coord{5, 5}};
  // Only one city was border growthed
  vector<int> actionOrder = {0, 1, 2, 3, 1};

  // I could find a layout with 8 + 8 + 6 + 4. Can it do better?
  auto start = std::chrono::high_resolution_clock::now();
  ParetoResult result = findParetoFrontier(map, cityCenters, actionOrder);
  auto end = std::chrono::high_resolution_clock::now();
  auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(end - start);
  ASSERT_FALSE(result.configs.empty());
  const auto& best = result.configs[0];
  EXPECT_GT(best.marketTotal, 26);
  std::cout << "Best market total: " << best.marketTotal << std::endl;
  std::cout << "Time taken (4 cities): " << duration.count() << " ms" << std::endl;
  prettyPrint(best.layout);
}

// Regression: city 2 is a big city border-grown against the bottom edge of the
// grid, so the optimizer places buildings on edge-owned tiles whose 8-tile
// neighbourhood extends past the grid. calculateMarketTotal used to read the
// neighbour tile BEFORE its bounds check, an out-of-bounds access that traps
// with "memory access out of bounds" under WASM. This is the reported map.
TEST(full, EdgeOwnedTilesDoNotReadOutOfBounds) {
  vector<vector<int>> map = {
    {RESOURCE, EMPTY,    EMPTY,    EMPTY,    RESOURCE, EMPTY, RESOURCE},
    {RESOURCE, CITY,     RESOURCE, EMPTY,    RESOURCE, CITY,  RESOURCE},
    {RESOURCE, EMPTY,    RESOURCE, EMPTY,    EMPTY,    EMPTY, EMPTY},
    {EMPTY,    EMPTY,    EMPTY,    EMPTY,    RESOURCE, EMPTY, EMPTY},
    {EMPTY,    RESOURCE, CITY,     RESOURCE, EMPTY,    EMPTY, EMPTY},
    {EMPTY,    RESOURCE, EMPTY,    EMPTY,    EMPTY,    RESOURCE, EMPTY},
  };
  vector<Coord> cityCenters = {Coord{1, 1}, Coord{1, 5}, Coord{4, 2}};
  vector<int> actionOrder = {0, 1, 2, 2};  // city 2 captured, then border-grown

  ParetoResult result = findParetoFrontier(map, cityCenters, actionOrder);

  // Must complete without an out-of-bounds access and yield a valid frontier.
  ASSERT_FALSE(result.configs.empty());
  EXPECT_LE(result.configs.size(), 3u);
  for (size_t k = 0; k < result.configs.size(); k++) {
    EXPECT_GE(result.configs[k].marketTotal, 0);
    EXPECT_GE(result.configs[k].buildingTotal, 0);
    // configs are sorted by market total, descending
    if (k > 0) EXPECT_LE(result.configs[k].marketTotal, result.configs[k - 1].marketTotal);
  }
}
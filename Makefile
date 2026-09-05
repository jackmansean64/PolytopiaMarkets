CXX = g++
GTEST_PREFIX = /opt/homebrew/opt/googletest
GTEST_INC = $(GTEST_PREFIX)/include
GTEST_LIB = $(GTEST_PREFIX)/lib
CXXFLAGS = -std=c++17 -Wall -Wextra -O2 -g -I$(GTEST_INC) -I. -Itests

TARGET = marketcalc_tests
TEST_SRC = $(wildcard tests/*_tests.cc)
SRC = $(TEST_SRC) tests/test_main.cc marketcalc.cc

EMCC ?= emcc
# The C++ search is no longer shipped to the browser; it is built only as the
# brute-force oracle that tools/differential-test.mjs checks the solver against.
WASM_JS = tools/oracle/marketcalc.js
# Sync with extern "C" in marketcalc.cc. Use _main_wasm here only if you define it.
# -g + -gsource-map: .wasm.map for DevTools source-level view (serve beside .wasm).
# --profiling-funcs: wasm "name" section (C++ symbol names) for Firefox Profiler — only in `make dev`.
EMFLAGS_COMMON = -std=c++17 -O2 -g -gsource-map \
	-s MODULARIZE=1 \
	-s EXPORT_NAME=createModule \
	-s EXPORT_ES6=1 \
	-s EXPORTED_FUNCTIONS='["_malloc","_free","_findParetoFrontier_wasm"]' \
	-s EXPORTED_RUNTIME_METHODS='["HEAP32"]'

EMFLAGS = $(EMFLAGS_COMMON)

.PHONY: all test run dev clean wasm wasm-dev solver-test bench

all: $(TARGET)

$(TARGET): $(SRC)
	$(CXX) $(CXXFLAGS) -o $(TARGET) $(SRC) -L$(GTEST_LIB) -lgtest -lgtest_main -pthread

test: $(TARGET)
	./$(TARGET)

$(WASM_JS): marketcalc.cc marketcalc.h
	$(EMCC) marketcalc.cc -o $(WASM_JS) $(EMFLAGS)

wasm: $(WASM_JS)

wasm-dev:
	$(EMCC) marketcalc.cc -o $(WASM_JS) $(EMFLAGS_COMMON) --profiling-funcs

# Check the constraint solver against the brute-force oracle on the corpus plus random maps.
solver-test: wasm
	npm test

bench: wasm
	npm run bench

run:
	node server.js

dev:
	node server.js

clean:
	rm -f $(TARGET) $(WASM_JS) \
		marketcalc.wasm marketcalc.wasm.map \
		marketcalc.profile.js marketcalc.profile.wasm marketcalc.profile.wasm.map
	find . -maxdepth 1 -name '*.dSYM' -type d -exec rm -rf {} +

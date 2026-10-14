#!/bin/sh
# Host tests for the capture log and swing capture: the firmware's store.cpp
# and capture.cpp compiled for the PC against mocks (a simulated NOR flash and
# simulated sensors). Run from anywhere: sh firmware/test/host/run.sh
set -e
here=$(cd "$(dirname "$0")" && pwd)
src="$here/../../src"
out=$(mktemp -d)
flags="-std=c++17 -O1 -I $here/mock -I $src -DFW_MAJOR=0 -DFW_MINOR=2 -DFW_PATCH=0"
g++ $flags "$here/test_store.cpp" "$src/store.cpp" -o "$out/test_store"
g++ $flags "$here/test_capture.cpp" "$src/store.cpp" "$src/capture.cpp" -o "$out/test_capture"
"$out/test_store"
CAPTURE_FIXTURE="${CAPTURE_FIXTURE:-$out/capture-log.bin}" "$out/test_capture"

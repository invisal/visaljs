#!/bin/bash
# Builds the runtime and runs its unit tests in every configuration CI cares about:
# gcc and clang, debug, -O2, ASan+UBSan, GC stress, and both together.
#
#   runtime/tools/matrix.sh [test-filter] [config...]
#
# Build directories go to $JSRT_MATRIX_DIR (default ~/.cache/visaljs/matrix) and are
# reused. Prints one line per configuration: the test summary, or the failures.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIR=${JSRT_MATRIX_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/visaljs/matrix}
declare -A CFG=(
  [gcc]="gcc"
  [clang]="clang"
  [clang-asan]="clang -DJSRT_SANITIZE=ON"
  [gcc-asan]="gcc -DJSRT_SANITIZE=ON"
  [gcc-O2]="gcc -DCMAKE_BUILD_TYPE=Release"
  [clang-O2]="clang -DCMAKE_BUILD_TYPE=Release"
  [gcc-stress]="gcc -DJSRT_GC_STRESS=ON"
  [clang-stress-asan]="clang -DJSRT_GC_STRESS=ON -DJSRT_SANITIZE=ON"
  [gcc-stress-asan]="gcc -DJSRT_GC_STRESS=ON -DJSRT_SANITIZE=ON"
)
ORDER=(gcc clang clang-asan gcc-asan gcc-O2 clang-O2 gcc-stress clang-stress-asan gcc-stress-asan)

filter=${1:-}
shift || true
configs=("$@")
[ ${#configs[@]} -eq 0 ] && configs=("${ORDER[@]}")

status=0
for name in "${configs[@]}"; do
  read -r cc flags <<< "${CFG[$name]} "
  build="$DIR/$name"
  if [ ! -f "$build/CMakeCache.txt" ]; then
    # shellcheck disable=SC2086
    CC=$cc cmake -S "$ROOT" -B "$build" $flags > /dev/null || { echo "$name: configure failed"; status=1; continue; }
  fi
  if ! out=$(cmake --build "$build" -j"$(nproc)" 2>&1); then
    echo "$name: build failed"
    echo "$out" | grep -E 'error|warning' | head -5
    status=1
    continue
  fi
  result=$(timeout 900 "$build/jsrt_tests" $filter 2>&1 | grep -v '^ok' | tr '\n' ' ' | cut -c1-600)
  echo "$name: $result"
  case "$result" in *" 0 failed"*) ;; *) status=1 ;; esac
done
exit $status

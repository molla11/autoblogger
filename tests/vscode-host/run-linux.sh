#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
test_tools=/tmp/autoblogger-vscode-tools
mkdir -p "$test_tools/debs" "$test_tools/xvfb"
if [ ! -f "$test_tools/node_modules/@vscode/test-electron/package.json" ]; then
  npm install --prefix "$test_tools" @vscode/test-electron@2.5.2 --no-audit --no-fund
fi
if [ ! -x "$test_tools/xvfb/usr/bin/Xvfb" ] || [ ! -x "$test_tools/xvfb/usr/bin/xkbcomp" ]; then
  # Refresh a private package index: the machine's apt lists can reference removed builds.
  mkdir -p "$test_tools/apt/lists/partial" "$test_tools/apt/cache/archives/partial"
  apt-get -o "Dir::State::lists=$test_tools/apt/lists" -o "Dir::Cache=$test_tools/apt/cache" update
  (
    cd "$test_tools/debs"
    apt-get -o "Dir::State::lists=$test_tools/apt/lists" -o "Dir::Cache=$test_tools/apt/cache" download xvfb xserver-common libxfont2 xauth libfontenc1 x11-xkb-utils xkb-data
    for package in ./*.deb; do dpkg-deb -x "$package" "$test_tools/xvfb"; done
  )
fi
# Ubuntu Xvfb embeds /usr/bin for xkbcomp. Redirect that exported pointer in this
# temporary process so the extracted packages work without root/system writes.
cat > "$test_tools/xvfb-path.c" <<'C'
#define _GNU_SOURCE
#include <dlfcn.h>
__attribute__((constructor)) static void configure(void) {
    char **directory = (char **) dlsym(RTLD_DEFAULT, "XkbBinDirectory");
    if (directory) *directory = "/tmp/autoblogger-vscode-tools/xvfb/usr/bin";
}
C
cc -shared -fPIC -o "$test_tools/xvfb-path.so" "$test_tools/xvfb-path.c" -ldl
display_number=$((100 + $$ % 500))
while [ -e "/tmp/.X${display_number}-lock" ]; do display_number=$((display_number + 1)); done
LD_PRELOAD="$test_tools/xvfb-path.so" LD_LIBRARY_PATH="$test_tools/xvfb/usr/lib/x86_64-linux-gnu" \
  "$test_tools/xvfb/usr/bin/Xvfb" ":$display_number" -screen 0 1280x900x24 -nolisten tcp -ac \
  -xkbdir "$test_tools/xvfb/usr/share/X11/xkb" >"$test_tools/xvfb-$$.log" 2>&1 &
xvfb_pid=$!
trap 'kill "$xvfb_pid" 2>/dev/null || true' EXIT
for attempt in $(seq 1 100); do
  if [ -e "/tmp/.X${display_number}-lock" ]; then break; fi
  if ! kill -0 "$xvfb_pid" 2>/dev/null; then cat "$test_tools/xvfb-$$.log"; exit 1; fi
  sleep 0.1
done
if [ ! -e "/tmp/.X${display_number}-lock" ]; then echo "Xvfb did not start" >&2; exit 1; fi
cd "$task_root"
pnpm --filter autoblogger-recorder build
DISPLAY=":$display_number" node tests/vscode-host/launch.cjs

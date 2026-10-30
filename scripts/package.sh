#!/usr/bin/env bash
# Packs a release of devdeck for Homebrew: dist/devdeck-<version>-darwin-arm64.tar.gz, with its node modules
# installed for production and node-pty compiled for the Node it's built with (Homebrew's node@24 runs it, so build
# with Node 24 on Apple Silicon: the release Action does).
#   scripts/package.sh <version>
set -euo pipefail
version=${1:?usage: scripts/package.sh <version>}
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
name="devdeck-$version-darwin-arm64"
stage="$root/dist/stage/devdeck"
rm -rf "$root/dist" && mkdir -p "$stage"

cp -R "$root/bin" "$root/src" "$root/public" "$root/tmux.conf" "$root/package.json" "$root/package-lock.json" "$root/LICENSE" "$root/README.md" "$stage/"
# the version comes from the tag, so `devdeck version` and the app's update check agree with the release
node -e 'const f=process.argv[1]; const p=require(f); p.version=process.argv[2]; require("fs").writeFileSync(f, JSON.stringify(p, null, 2) + "\n")' "$stage/package.json" "$version"
(cd "$stage" && npm ci --omit=dev --no-audit --no-fund --foreground-scripts >/dev/null)
# node-pty must have been compiled here: without it no terminal opens
test -f "$stage/node_modules/node-pty/build/Release/pty.node" || { echo "node-pty didn't build" >&2; exit 1; }

tar -C "$root/dist/stage" -czf "$root/dist/$name.tar.gz" devdeck
rm -rf "$root/dist/stage"
shasum -a 256 "$root/dist/$name.tar.gz"

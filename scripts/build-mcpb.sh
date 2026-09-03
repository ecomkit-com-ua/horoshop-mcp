#!/usr/bin/env bash
# Builds the Claude Desktop extension bundle (.mcpb) into build/.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf build/mcpb
mkdir -p build/mcpb/server

npm run build
cp -R dist/. build/mcpb/server/

# Production dependencies only — the bundle ships its own node_modules.
cp package.json build/mcpb/server/package.json
npm install --prefix build/mcpb/server --omit=dev --no-audit --no-fund --ignore-scripts

cp manifest.json build/mcpb/manifest.json
cp README.md    build/mcpb/README.md
cp LICENSE      build/mcpb/LICENSE
cp icon.png     build/mcpb/icon.png

npx --yes @anthropic-ai/mcpb pack build/mcpb build/horoshop-mcp.mcpb

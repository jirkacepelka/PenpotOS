#!/usr/bin/env bash
# Vendors the parts of Penpot's official MCP server (MPL-2.0) that PenpotOS reuses:
# the Plugin-API helper library, instructions for the LLM and the API type docs.
# Usage: scripts/sync-penpot-mcp.sh [penpot-tag]   (default: 2.18.1)
set -euo pipefail
TAG="${1:-2.18.1}"
BASE="https://raw.githubusercontent.com/penpot/penpot/${TAG}/mcp/packages"
DEST="$(cd "$(dirname "$0")/.." && pwd)/vendor/penpot-mcp"
mkdir -p "$DEST/plugin" "$DEST/data" "$DEST/reference"
fetch() { curl -fsSL "$BASE/$1" -o "$2"; echo "  $1"; }
echo "Vendoring penpot/mcp @ ${TAG}"
fetch plugin/src/PenpotUtils.ts        "$DEST/plugin/PenpotUtils.ts"
fetch plugin/src/ErrorUtils.ts         "$DEST/plugin/ErrorUtils.ts"
fetch plugin/src/task-handlers/ExecuteCodeTaskHandler.ts "$DEST/reference/ExecuteCodeTaskHandler.ts"
fetch server/data/initial_instructions.md "$DEST/data/initial_instructions.md"
fetch server/data/base_instructions.md    "$DEST/data/base_instructions.md"
fetch server/data/api_types.yml           "$DEST/data/api_types.yml"
for t in ExecuteCodeTool ExportShapeTool ImportImageTool PenpotApiInfoTool HighLevelOverviewTool; do
  fetch "server/src/tools/${t}.ts" "$DEST/reference/${t}.ts"
done
fetch server/src/ApiDocs.ts "$DEST/reference/ApiDocs.ts"
echo "$TAG" > "$DEST/VERSION"
echo "done"

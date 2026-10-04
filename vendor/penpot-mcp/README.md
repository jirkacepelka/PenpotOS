# Vendored parts of Penpot's official MCP server

Source: https://github.com/penpot/penpot/tree/develop/mcp (version in `VERSION`), licensed under the
Mozilla Public License 2.0, Copyright (c) KALEIDOS SUBSIDIARY SL.

* `plugin/` – helper library (`PenpotUtils`) and error formatting, injected unchanged into the headless
  Penpot workspace by `services/mcp/src/runtime`.
* `data/` – LLM instructions and Plugin API type documentation served by the `high_level_overview`
  and `penpot_api_info` tools.
* `reference/` – the official tool implementations, kept for comparison when updating.

Update with `scripts/sync-penpot-mcp.sh <penpot-tag>` (use the tag matching `PENPOT_VERSION`).

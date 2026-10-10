# AnySearch MCP Integration — Development Document

> Metadata: PR Zoo-Code-Org/Zoo-Code#1955 (issue #1956) · created 2026-10-08 ·
> vendor claims below per AnySearch docs as of 2026-10-08 (https://anysearch.com).

## What this is

This document describes the AnySearch integration shipped with Zoo Code. AnySearch
(https://anysearch.com) is search infrastructure for AI agents: general web search,
vertical domain search, parallel batch search, and web page extraction. It is exposed
to Zoo Code as a **remote MCP server** listed in the built-in MCP Marketplace, so users
can install it in one click and immediately give the agent up-to-date web knowledge
for research, documentation lookup, and fact-checking.

## How it is wired

- **Marketplace entry:** `src/assets/marketplace/mcps.yml`, item id `anysearch`
  (kept first in the file — entries are alphabetical). It declares two install methods:
  1. **Remote Server** — JSON config with `Authorization: Bearer {{ANYSEARCH_API_KEY}}`;
     the installer prompts for the API key at install time (higher rate limits).
  2. **Remote Server (Anonymous)** — same endpoint without the auth header;
     uses AnySearch's anonymous tier (lower rate limits, no key needed).
- **Install flow:** `MarketplaceManager` (default `target="project"`) → `SimpleInstaller`
  substitutes the `{{ANYSEARCH_API_KEY}}` parameter (collected from the user at install
  time; method-level parameters only apply to the selected method) and writes the
  server into the project's `<workspace>/.roo/mcp.json` (or the user's global
  `mcp_settings.json` when installed with the global target).
- **Runtime:** `McpHub` (`src/services/mcp/McpHub.ts`) natively supports the
  `streamable-http` transport type, so no code changes were needed — this integration
  is configuration only.

## Tools exposed by the AnySearch MCP server

Per AnySearch docs as of 2026-10-08 (tools are discovered dynamically at connect time;
this table documents the vendor's offering, not a contract):

| Tool | Purpose | Key parameters |
| ---- | ------- | -------------- |
| `search` | Web search, general or vertical domain | `query` (required), `max_results` (1–10, default 10), `domain` / `sub_domain` / `sub_domain_params` (vertical routing; values must come from `get_sub_domains`) |
| `batch_search` | Parallel batch search (1–5 independent queries; one failure doesn't block others) | `queries` (required, 1–5 query objects with the same fields as `search`) |
| `extract` | Fetch a URL and return its content as markdown | `url` (required) |
| `get_sub_domains` | Discover vertical (domain-specific) search scopes | — |

Anonymous requests work with lower rate limits; an API key raises the limits.
Get a key at https://anysearch.com.

## User flow

1. Open the MCP Marketplace in Zoo Code (MCP Servers → Marketplace).
2. Find **AnySearch**, click Install, choose **Remote Server** (paste the API key when
   prompted) or **Remote Server (Anonymous)**.
3. The agent can now call `search`, `batch_search`, `extract`, and `get_sub_domains`
   via the `use_mcp_tool` mechanism like any other MCP server.

## Maintenance notes

- **If AnySearch changes its endpoint or auth scheme:** edit only the `content`
  blocks of the `anysearch` item in `src/assets/marketplace/mcps.yml`. No TypeScript
  changes are required as long as the transport stays `streamable-http`/`sse`/`stdio`
  (all supported by `McpHub`).
- **If AnySearch adds/removes tools:** nothing to change on our side — tools are
  discovered dynamically from the MCP server at connection time.
- **Validation:** after editing the YAML, confirm it still parses and that item ids
  stay unique and alphabetical. The marketplace zod schema lives in
  `packages/types/src/marketplace.ts` (`mcpMarketplaceItemSchema`); the entry must
  keep satisfying it (`id`, `name`, `description`, `url`, `content`, method-level
  `parameters` where needed).
- **Testing the connection:** install the entry from a dev build of the extension,
  then check MCP Servers view shows AnySearch as connected and try a `search` call.
  This requires a real API key (or the anonymous method); there is no offline stub.

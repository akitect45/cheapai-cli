---
name: mcp-builder
description: Use when creating or reviewing an MCP server (stdio or HTTP) so an agent can call an external API. Covers tool design, auth, errors, and wiring it into CheapAI.
---

# MCP server builder

## Shape the tools for an agent

- Name tools `service_action` (`github_list_issues`), not `handleRequest`
- Prefer real API coverage over a few magic "do everything" tools
- Paginate and filter. Return focused JSON, not entire dumps
- Errors must say what to do next (missing scope, bad id, retry later)
- Mark intent in descriptions: read vs write, destructive vs idempotent

## Implement

Prefer TypeScript + the official MCP SDK for local `stdio` servers. Use streamable HTTP for remote servers.

```text
1. Read the upstream API docs with web_fetch
2. Fetch MCP protocol pages from https://modelcontextprotocol.io (add .md when available)
3. Scaffold the server, auth helper, and one read tool
4. Add write tools only after the read path works
5. npm run build / typecheck
6. Smoke with npx @modelcontextprotocol/inspector when the user has a TTY
```

Do not invent auth. PAT, OAuth, or API keys stay in env or CheapAI MCP config, never in the repo.

## Wire into CheapAI

After the server runs locally:

- `mcp_manage` `action=connect` with `command`+`args` (stdio) or `url` (http)
- `list_mcp_tools` then `call_mcp_tool`

Project `.cheapai/config.json` cannot grant MCP trust by itself. Connection lives in the user's global config.

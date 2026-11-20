# MCP

`mcp.ts` serves the Model Context Protocol at `/mcp`: JSON-RPC 2.0 over
streamable HTTP, speaking the 2026-07-28 revision through `server/discover`
and the legacy `initialize` handshake (2025-11-25 and the other listed
revisions negotiated down on request).

- **Framing**: a request object gets one response; a **batch array gets one
  response per request, in order**, with notifications contributing no
  entry (an all-notification batch is answered 202, like a single
  notification). Malformed JSON is a 400 parse error (`-32700`); a body
  that is not a request is `-32600`; an unknown method is `-32601`; an
  unknown tool or a missing required argument is `-32602`. String request
  ids are echoed verbatim.
- **Tools**: `create_repo`, `get_repo`, `list_repos`, `create_issue`,
  `list_issues`, `get_issue`, `create_pull_request`, `merge_pull_request` —
  each with an object `inputSchema` naming its required arguments.
- **Failures are results, not exceptions**: a tool that cannot complete
  (missing repository, duplicate name, conflicting merge) returns a
  `tools/call` result with `isError: true` and the message as text content,
  per the protocol's tool-error convention. Successful calls return both
  text content (the JSON payload) and `structuredContent`.
- The tools act on the same store as REST, GraphQL and git, so an issue
  created over MCP reads back through REST with the same number and body.

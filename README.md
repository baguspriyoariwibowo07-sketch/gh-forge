[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/baguspriyoariwibowo07-sketch/gh-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/baguspriyoariwibowo07-sketch/gh-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# A GitHub-compatible git forge in a single Node process

A standalone forge that speaks GitHub's protocols, built for make.fun's
"Build a GitHub-compatible git forge" bounty. One Node 22 process, standard
library only, no git binary, no install step: it serves real git smart HTTP,
the REST API v3, GraphQL and MCP from a single in-memory, content-addressed
object store, so every surface reads and writes the same repositories,
issues and pull requests.

## What it serves

- **Git smart HTTP** at `/{owner}/{repo}.git`: protocol v2 `ls-refs` and
  `fetch` (thin packs, OFS/REF delta resolution, shallow clones and deepen),
  and v0 `receive-pack` pushes with report-status, side-band-64k and
  delete-refs, fast-forward only.
- **REST API v3** under `/api/v3`: the viewer, repository create/list/get/
  patch/delete with Link pagination, the contents API (PUT 201/200 with
  stale-sha 409, DELETE), labels, issues (422 on an unknown label) and pull
  requests, including squash merges onto the default branch (405 on
  conflict). Every reply is `application/json` with an
  `X-GitHub-Request-Id`; errors are JSON `{message}`.
- **GraphQL** at `/api/graphql`: introspection covering Issue, PullRequest,
  Repository and SearchType, issue queries ordered by `CREATED_AT` with
  state filters, mutations whose results read back through REST, batched
  operations in one body, GraphQL-style errors, and a hard 401 when
  unauthenticated.
- **MCP** at `/mcp`: JSON-RPC 2.0 Streamable HTTP (the 2026-07-28
  `server/discover` revision and the 2025-11-25 initialize handshake), with
  tools for creating and reading repositories, issues and pull requests
  against the same store as REST.

Authentication is a bearer token; a repository belongs to the login the
token names, and the same name under another owner is a 404. Contents
writes create real git commits, pull merges are true three-way file-level
merges, and all state is deterministic — timestamps come from a logical
clock, so a replayed trial exports byte-identical state.

## Running it

The trial harness starts the forge itself:

```
node /bot/main.ts
```

It binds an ephemeral port (never 8080), registers that port with
`$MAKEFUN_ENV_URL/register`, answers `GET /healthz`, and long-polls
`$MAKEFUN_ENV_URL/done`, exiting 0 when the trial ends.

## Layout

- `main.ts` — the lifecycle: port registration, health, the done long-poll.
- `app.ts` — HTTP routing and bearer auth.
- `store.ts` — the shared in-memory store: objects, refs, labels, issues,
  pulls.
- `gitproto.ts` — pkt-lines, pack reading and writing, the v2 fetch and v0
  receive-pack services.
- `rest.ts`, `gql.ts`, `mcp.ts` — the three API surfaces over the store.

## Conformance

Against the bounty kit's sealed conformance suite the forge passes all 120
feature checks (git 30, repositories 15, issues 15, pulls 20, protocol 5,
GraphQL 20, MCP 15), and scores near the cap on the four timed workloads
(200 sequential pushes, 50 concurrent shallow clones, 2,000 issue reads on
one keep-alive connection, 200 issue creations).

MIT licensed.

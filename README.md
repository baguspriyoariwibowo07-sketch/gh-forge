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
  delete-refs, fast-forward only. The wire is verified against the real
  git CLI, not just the kit's client — see `docs/git-wire.md` for the
  shapes real git rejects (empty-repo advertisements, `done` fetches,
  `deepen-relative`) and how the forge answers them.
- **REST API v3** under `/api/v3`: the viewer, repository create/list/get/
  patch/delete with Link pagination, the contents API (PUT 201/200 with
  stale-sha 409, DELETE), labels, issues (Link pagination, a `?labels=`
  filter, 422 on an unknown label) and pull requests, including squash
  merges onto the default branch (405 on conflict). Every reply is
  `application/json` with an `X-GitHub-Request-Id` and the
  `X-RateLimit-*` headers; errors are JSON `{message}`.
- **GraphQL** at `/api/graphql`: the canonical introspection query,
  `@skip`/`@include` directives and variable defaults actually executed,
  connections whose `totalCount` counts the whole set and whose cursors
  page, `search`/`nodes`/`rateLimit`/`organization`, mutations (including
  `updateIssue`/`reopenIssue`) whose results read back through REST,
  batched operations in one body, GraphQL-style errors, and a hard 401
  when unauthenticated. See `docs/graphql.md`.
- **MCP** at `/mcp`: JSON-RPC 2.0 Streamable HTTP (the 2026-07-28
  `server/discover` revision and the 2025-11-25 initialize handshake),
  JSON-RPC batches answered per request, and tools for creating and
  reading repositories, issues and pull requests against the same store
  as REST. See `docs/mcp.md`.

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
- `docs/` — per-subsystem notes: `git-wire.md`, `graphql.md`, `rest.md`,
  `mcp.md`.
- `tests/` — the in-repo validation suites described below.

## Validation

All numbers below are from local runs on this machine and re-runnable from
`tests/` (see `tests/README.md` for the method behind each).

- **Sealed conformance suite** (the bounty kit's): **120 of 120 checks
  passed** (git 30, repositories 15, issues 15, pulls 20, protocol 5,
  GraphQL 20, MCP 15), and **192 of 200 points** on its four timed
  workloads (200 sequential pushes, 50 concurrent shallow clones, 2,000
  issue reads on one keep-alive connection, 200 issue creations; the
  point split was push 50, clone 44, read 50, write 48). Timed scores move
  with machine load; the check count does not.
- **Edge-case probes** (`tests/probes.ts`): **58 passed, 0 failed** —
  canonical GraphQL introspection, directives, variable defaults,
  connection totals and cursors, every advertised field, MCP batches,
  REST pagination/filter corners, and git-wire corners driven with the
  real git CLI.
- **Real-git interop** (`tests/interop.sh`): **all ok** — first push to an
  empty repository, annotated tags, and full/shallow/deepen/unshallow
  clones under both protocol v2 and v0 with stock git 2.43, checking the
  exact history shape at each step. The previous build failed most of
  this matrix (its empty-repository advertisement alone broke every
  first push from a real client).
- **Server-CPU benchmark** (`tests/bench-cpu.sh`): over identical fixed
  work (300 shallow clones of one 30-commit tip, 500 REST reads, 500
  GraphQL queries; CPU measured from `/proc/<pid>/stat`, not wall clock),
  the previous build used 1.41 s / 1.12 s and this build 1.50 s / 1.29 s
  across two alternating runs each — overlapping ranges: no measurable
  CPU change within noise. This upgrade is correctness, not speed.

MIT licensed.

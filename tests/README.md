# In-repo validation

Three suites live here. None of them is the bounty's sealed conformance suite;
they exist so the claims in the top-level README can be re-run by anyone.

## `probes.ts` — edge-case probes (58 checks)

```
node tests/probes.ts
```

Boots the forge in-process on an ephemeral port and probes the corners the
sealed 120-check suite does not reach:

- **GraphQL** — the canonical introspection query (the full `__Schema` /
  `__Type` / `__Field` / `__Directive` shape Apollo and Relay send), `@skip` /
  `@include` with literal and variable conditions, variable defaults,
  connection `totalCount` against the whole set (not the page), distinct edge
  cursors that actually page, every field the schema advertises
  (`search`, `nodes`, `rateLimit`, `organization`, `Repository.url` /
  `labels` / counts, `User.repositories`, `PullRequest.headRef` / `baseRef`,
  `Ref.target.oid`, `updateIssue` / `reopenIssue`), and an unmatched
  `operationName` as an error rather than a silent first-operation run.
- **MCP** — JSON-RPC batches (one response per request, notifications
  omitted), string ids, unknown tools/methods, malformed JSON, tool failures
  as `isError` results rather than RPC errors.
- **REST** — the issues list's `Link` pagination header, the `?labels=`
  filter, duplicate-repo 422s, comment round-trips, pull files, and the
  `X-RateLimit-*` headers (a soft "note", reported but not gated on).
- **git wire, with the real git CLI** — annotated-tag peeling in the
  advertisement, non-fast-forward rejection leaving the ref untouched,
  branch deletion by push, cloning an empty repository, and a shallow clone
  that deepens on request.

Current result: **58 passed, 0 failed** (plus the rate-limit note, ok).

## `interop.sh` — the real-git matrix

```
bash tests/interop.sh [port]
```

Starts the forge via `tests/serve.ts` and drives it with stock git 2.43 over
smart HTTP: first push to an empty repository, an annotated tag, a REST
pull request, then full and shallow clones under **both protocol v2 and
v0**, relative deepen (`git fetch --deepen`, which sends `deepen-relative`)
and `--unshallow`, checking the exact commit counts at each step. This is
the suite that caught the wire bugs listed in `docs/git-wire.md`; the kit's
own client tolerates several shapes real git rejects.

Current result: **all ok** (11 checks).

## `bench-cpu.sh` — server-CPU benchmark

```
bash tests/bench-cpu.sh <entry-dir> <port> <label>
```

Total wall-clock scores swing under VM load (the same build scored 885–995
across runs of the kit benchmark), so this measures the forge process's own
CPU (`utime + stime` from `/proc/<pid>/stat`) over identical fixed work:
300 shallow clones of one 30-commit tip, 500 REST issue-list reads and 500
GraphQL issue queries. Seeding goes through the REST contents API so both
builds under comparison hold byte-identical history before the meter starts
(a git-push seed is not neutral: older builds could not take a real push to
an empty repository at all).

Latest local comparison (two runs each, alternating): the previous build
1.41 s / 1.12 s, this build 1.50 s / 1.29 s — overlapping ranges, i.e. no
measurable CPU change within noise; the upgrade is correctness, not speed.

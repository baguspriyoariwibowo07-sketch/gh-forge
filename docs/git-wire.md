# Git smart HTTP

`gitproto.ts` implements the wire by hand: pkt-lines, pack reading/writing
with OFS/REF delta resolution, ref advertisement, protocol v2 `ls-refs` and
`fetch`, and v0 `receive-pack`. `app.ts` routes `/{owner}/{repo}.git`.

## Shapes the kit's client tolerates but real git rejects

The sealed conformance client is lenient in several places where stock git
is strict. The in-repo interop matrix (`tests/interop.sh`, real git 2.43)
found and now guards each of these:

- **Empty-repository v0 advertisement** must end with a flush packet after
  the `capabilities^{}` pseudo-ref. Without it git aborts every first push
  and empty clone with `the remote end hung up upon initial contact`.
- **A v2 fetch request that ends in `done`** must be answered with the
  shallow-info (when the boundary moves) and the packfile directly. An
  `acknowledgments` section there makes git die with
  `expected 'packfile', received 'acknowledgments'`.
- **A negotiating v2 fetch** (no `done` yet) needs `ready` as the last
  acknowledgment line before the pack sections follow, or git aborts with
  `expected no other sections to be sent after no 'ready'`. This server is
  stateless with the whole object store in memory, so it is always ready.
- **The v0 shallow block is flush-terminated**: shallow/unshallow lines,
  then a flush, then `NAK`. Without the flush: `expected shallow/unshallow,
  got NAK`. A shallow request without `done` is phase one of the dance and
  is answered with the shallow list alone; the pack follows the `done`
  request.
- **`deepen` has two meanings on the wire.** Plain `deepen <n>` counts
  generations from the wants (a fresh shallow fetch, an absolute deepen).
  `deepen <n>` together with `deepen-relative` — what `git fetch --deepen`
  sends, as a v2 argument line or as a capability on the v0 want line —
  counts generations below the client's reported shallow boundary. The v0
  advertisement therefore carries the `deepen-relative` capability, and the
  fetch planner walks accordingly.

## Invariants

- Pushes are fast-forward only (plus creates and deletes); a rejected ref
  changes nothing and the report says so per ref (`report-status`,
  side-band-64k progress, `unpack ok`).
- Advertisements, fetch plans and packs are pure functions of the request
  and the immutable object store, so they are cached by their exact inputs
  (including the object-store version and the `done` / `deepen-relative`
  flags, which change the correct answer).
- Shallow bookkeeping is exact: the boundary is the set of included commits
  with an excluded parent; `unshallow` lines name boundary commits the fetch
  moved past.

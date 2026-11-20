# GraphQL

`gql.ts` is a small parser plus resolver executor over the same store as
REST and git. Global ids are opaque base64 encodings of (kind, repo id,
number), so `node(id:)` round-trips and an id never equals the plain
database id.

## Execution semantics

- **Directives are executed, not just parsed.** `@skip` / `@include` are
  honoured on fields, inline fragments and fragment spreads, with literal
  or variable conditions.
- **Variable definitions are parsed**, including types and defaults; a
  default applies whenever the caller omits the variable, and caller values
  override it per name.
- **`operationName` selects the operation**; a provided name that matches
  nothing is an error, never a silent run of the first operation.
- **Connections report the whole set**: `totalCount` is the size of the
  filtered set (not the page), edges carry distinct cursors, and an issue
  connection's cursor pages to the exact next slice via `after:`.
- Errors are GraphQL-shaped: a field that does not exist on a type returns
  `Field 'x' doesn't exist on type 'T'` in `errors` with `null` data for
  that field, matching what GitHub clients expect.

## Surface

Queries: `viewer`, `user`, `organization`, `repository`, `node`, `nodes`,
`search` (substring match over issues / pull requests / repositories),
`rateLimit`, plus `__type` / `__schema`. Introspection serves the canonical
query shape — `__Schema.description` / `directives`, `__Type.specifiedByURL`,
`__Field.args`, `__InputValue`, `__Directive` — so standard tooling
(Apollo, Relay, GraphiQL) can introspect the schema it is talking to.

Mutations: `createIssue`, `closeIssue`, `updateIssue` (GitHub's current
`input: { id, … }` shape; `issueId` accepted too), `reopenIssue`,
`createPullRequest`, `mergePullRequest`, `addComment` — all echoing
`clientMutationId`, all reading back through REST because the store is
shared.

Repository, issue, pull-request, user and organization objects expose the
fields the schema advertises — including `Repository.url` / `createdAt` /
`labels` / `stargazerCount`, `User.repositories` / `issues` /
`pullRequests` aggregates, `PullRequest.headRef` / `baseRef` as `Ref`
objects, and `Ref.target.oid` resolved from the ref store. Timestamps are
deterministic (a fixed logical clock), like the rest of the forge.

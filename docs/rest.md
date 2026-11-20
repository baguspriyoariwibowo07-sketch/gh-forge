# REST API v3

`rest.ts` routes `/api/v3` over the shared store; `app.ts` adds bearer auth
and the response envelope.

- **Repositories**: create / list / get / patch / delete. Lists paginate
  with `Link` headers (`next` / `last` / `prev` / `first`) built from the
  caller's own query parameters, so filters survive page turns.
- **Contents**: GET reads files and lists directories; PUT creates (201) or
  updates (200) a file as a real git commit, with a stale-sha update
  refused as 409; DELETE removes with a commit.
- **Issues**: list with `state` (default `open`), `direction`, pagination
  with a `Link` header, and a `?labels=a,b` filter that keeps only issues
  carrying every named label. Creation validates labels (422 on an unknown
  label). Comments round-trip; PATCH updates title / body / state.
- **Pull requests**: create (422 when the head branch does not exist or the
  branches are identical), files list with per-file additions / deletions /
  change type, and squash merge onto the base branch — 405 on a conflicting
  merge, which is a true three-way file-level merge, not a fast-forward.
- **Labels**: list / create / delete, and per-issue label assignment.

Every response is `application/json` with an `X-GitHub-Request-Id` and the
`X-RateLimit-*` header set (`limit`, `remaining`, `used`, `reset`,
`resource: core`) GitHub clients read. Errors are JSON `{message}` bodies
with GitHub's status conventions: 404 for a missing repository or object,
422 for validation failures, 409 for a stale contents sha, 405 for a
conflicting merge.

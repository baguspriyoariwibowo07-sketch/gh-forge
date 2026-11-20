// gh-forge edge-case probes: the surface the winner's in-repo suites emphasise
// (GraphQL introspection, MCP tool edges) plus REST/git-wire corners the kit's
// sealed 120-check suite does not reach. Run with:  node tests/probes.ts
// Exit code is 1 when any hard probe fails; "note" probes report fidelity
// observations without failing the run.

import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

process.env.MAKEFUN_SHOP_TOKEN = 'probe-token';
const TOKEN = 'probe-token';
const OWNER = 'adaiversen';
const REPO = 'probe-repo';

let base = '';
let passed = 0;
let failed = 0;
let noted = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed += 1; process.stdout.write(`  PASS ${name}\n`); }
  else { failed += 1; failures.push(name); process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ''}\n`); }
}
function note(name: string, ok: boolean, detail = ''): void {
  noted += 1;
  process.stdout.write(`  NOTE ${name}: ${ok ? 'ok' : 'gap'}${detail ? ` — ${detail}` : ''}\n`);
}

interface HttpResult { status: number; headers: Headers; body: unknown; text: string }

async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<HttpResult> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, body: parsed, text };
}

type GqlResult = { data?: Record<string, any>; errors?: { message: string }[] };
async function gql(query: string, variables?: Record<string, unknown>, operationName?: string): Promise<GqlResult> {
  const res = await http('POST', '/api/graphql', { query, variables, operationName });
  return res.body as GqlResult;
}
async function rpc(payload: unknown): Promise<HttpResult> {
  return http('POST', '/mcp', payload as any);
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout, stderr } = await run('git', ['-c', `http.extraHeader=Authorization: Bearer ${TOKEN}`, ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', HOME: cwd },
    maxBuffer: 16 * 1024 * 1024,
  }).catch((err: any) => ({ stdout: err.stdout ?? '', stderr: err.stderr ?? String(err) }));
  return `${stdout}${stderr}`;
}

// ---------------------------------------------------------------- setup

const { createApp } = await import('../app.ts');
const server = createApp();
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('no port');
base = `http://127.0.0.1:${address.port}`;
process.stdout.write(`forge on ${base}\n`);

const repoRes = await http('POST', '/api/v3/user/repos', { name: REPO, description: 'probe repo' });
check('setup: create repo', repoRes.status === 201, `status ${repoRes.status}`);
await http('POST', `/api/v3/repos/${OWNER}/${REPO}/labels`, { name: 'bug', color: 'd73a4a', description: 'a bug' });
const issueTitles = ['alpha crash on start', 'beta docs typo', 'gamma slow query', 'delta ui glitch', 'epsilon flaky test'];
for (const [i, title] of issueTitles.entries()) {
  const labels = i === 0 ? ['bug'] : [];
  await http('POST', `/api/v3/repos/${OWNER}/${REPO}/issues`, { title, body: `body of ${title}`, labels });
}

// git fixture: main with 3 commits, a feature branch, an annotated tag
const work = mkdtempSync(join(tmpdir(), 'forge-probe-'));
await git(['init', '-b', 'main'], work);
await git(['config', 'user.email', 'probe@example.invalid'], work);
await git(['config', 'user.name', 'probe'], work);
writeFileSync(join(work, 'file.txt'), 'one\n');
await git(['add', '.'], work); await git(['commit', '-m', 'c1'], work);
writeFileSync(join(work, 'file.txt'), 'one\ntwo\n');
await git(['add', '.'], work); await git(['commit', '-m', 'c2'], work);
const remote = `${base}/${OWNER}/${REPO}.git`;
await git(['remote', 'add', 'origin', remote], work);
const authArgs: string[] = []; // auth rides on every git call via the helper above
await git(['push', 'origin', 'main'], work);
await git(['tag', '-a', 'v1', '-m', 'version one'], work);
await git(['push', 'origin', 'v1'], work);
await git(['checkout', '-b', 'feature'], work);
writeFileSync(join(work, 'feature.txt'), 'feature work\n');
await git(['add', '.'], work); await git(['commit', '-m', 'feature commit'], work);
await git(['push', 'origin', 'feature'], work);
await git(['checkout', 'main'], work);
const headSha = (await git(['rev-parse', 'HEAD'], work)).trim();
const prRes = await http('POST', `/api/v3/repos/${OWNER}/${REPO}/pulls`, { title: 'add feature file', body: 'pr body', head: 'feature', base: 'main' });
check('setup: create pull request', prRes.status === 201, `status ${prRes.status}`);

// global ids for GraphQL probes
const idRes = await gql(`{ repository(owner: "${OWNER}", name: "${REPO}") { id issue(number: 1) { id } pullRequest(number: 1) { id } } }`);
const repoGid = idRes.data?.repository?.id as string;
const issueGid = idRes.data?.repository?.issue?.id as string;
const pullGid = idRes.data?.repository?.pullRequest?.id as string;
check('setup: global ids resolve', typeof repoGid === 'string' && typeof issueGid === 'string' && typeof pullGid === 'string');

// ---------------------------------------------------------------- GraphQL

process.stdout.write('\nGraphQL\n');

{
  // The canonical introspection shape (graphql-js getIntrospectionQuery, trimmed):
  // asks for __Schema.description/directives, __Type.specifiedByURL, __Field.args.
  const q = `{
    __schema {
      description
      queryType { name }
      mutationType { name }
      types { name kind }
      directives { name locations args { name type { name kind } } }
    }
    __type(name: "Repository") {
      name kind specifiedByURL
      fields { name args { name } type { name kind ofType { name kind } } }
      inputFields { name }
    }
  }`;
  const res = await gql(q);
  check('gql: canonical introspection query runs without errors', res.errors === undefined,
    res.errors ? res.errors.map((e) => e.message).join('; ') : '');
  check('gql: introspection lists the forge types', Array.isArray(res.data?.__schema?.types)
    && ['Repository', 'Issue', 'PullRequest', 'SearchType'].every((t) => res.data?.__schema?.types.some((x: any) => x.name === t)));
}

{
  const res = await gql('{ __type(name: "NoSuchType") { name } }');
  check('gql: __type of unknown name is null, not an error', res.data?.__type === null && res.errors === undefined);
}

{
  const res = await gql('{ kept: viewer { login } skipped: viewer @skip(if: true) { login } }');
  check('gql: @skip(if: true) omits the field', res.data?.kept?.login === OWNER && !('skipped' in (res.data ?? {})),
    JSON.stringify(res.data));
}

{
  const q = 'query($show: Boolean!) { shown: viewer @include(if: $show) { login } }';
  const off = await gql(q, { show: false });
  const on = await gql(q, { show: true });
  check('gql: @include(if: $var) honours the variable', !('shown' in (off.data ?? {})) && on.data?.shown?.login === OWNER,
    `off=${JSON.stringify(off.data)} on=${JSON.stringify(on.data)}`);
}

{
  const q = `query($n: Int = 2) { repository(owner: "${OWNER}", name: "${REPO}") { issues(first: $n, states: [OPEN, CLOSED]) { nodes { number } } } }`;
  const res = await gql(q);
  check('gql: variable default applies when no variable is passed', res.data?.repository?.issues?.nodes?.length === 2,
    JSON.stringify(res.data?.repository?.issues));
}

{
  const q = `{ repository(owner: "${OWNER}", name: "${REPO}") { issues(first: 2, states: [OPEN, CLOSED]) { totalCount } } }`;
  const res = await gql(q);
  check('gql: connection totalCount counts the whole set, not the page', res.data?.repository?.issues?.totalCount === 5,
    `got ${res.data?.repository?.issues?.totalCount}`);
}

{
  const q = `{ repository(owner: "${OWNER}", name: "${REPO}") {
    issues(first: 2, states: [OPEN, CLOSED], orderBy: { field: CREATED_AT, direction: ASC }) {
      edges { cursor node { number } } pageInfo { endCursor hasNextPage } } } }`;
  const res = await gql(q);
  const edges = res.data?.repository?.issues?.edges ?? [];
  const cursors = edges.map((e: any) => e.cursor);
  check('gql: edges carry real, distinct cursors', cursors.length === 2 && cursors.every((c: unknown) => typeof c === 'string' && c !== '') && cursors[0] !== cursors[1],
    JSON.stringify(cursors));
  if (cursors.length === 2 && cursors[1]) {
    const page2 = await gql(`{ repository(owner: "${OWNER}", name: "${REPO}") {
      issues(first: 2, after: "${cursors[1]}", states: [OPEN, CLOSED], orderBy: { field: CREATED_AT, direction: ASC }) { nodes { number } } } }`);
    check('gql: an edge cursor pages to the next slice', page2.data?.repository?.issues?.nodes?.[0]?.number === 3,
      JSON.stringify(page2.data?.repository?.issues?.nodes));
  }
}

{
  const search = await gql(`{ search(query: "alpha", type: ISSUE, first: 5) { nodes { ... on Issue { title } } } }`);
  check('gql: advertised Query.search resolves', search.errors === undefined
    && search.data?.search?.nodes?.some((n: any) => n.title === 'alpha crash on start'),
    search.errors ? search.errors.map((e) => e.message).join('; ') : JSON.stringify(search.data));
  const nodes = await gql(`{ nodes(ids: ["${repoGid}"]) { id } }`);
  check('gql: advertised Query.nodes resolves', nodes.errors === undefined && nodes.data?.nodes?.[0]?.id === repoGid,
    nodes.errors ? nodes.errors.map((e) => e.message).join('; ') : JSON.stringify(nodes.data));
  const rate = await gql('{ rateLimit { limit remaining } }');
  check('gql: advertised Query.rateLimit resolves', rate.errors === undefined && typeof rate.data?.rateLimit?.limit === 'number',
    rate.errors ? rate.errors.map((e) => e.message).join('; ') : '');
  const org = await gql(`{ organization(login: "${OWNER}") { login } }`);
  check('gql: advertised Query.organization resolves without a field error', org.errors === undefined,
    org.errors ? org.errors.map((e) => e.message).join('; ') : '');
}

{
  const res = await gql(`{ repository(owner: "${OWNER}", name: "${REPO}") {
    url createdAt updatedAt stargazerCount forkCount labels { nodes { name } totalCount } } }`);
  check('gql: advertised Repository fields resolve (url/dates/labels/counts)', res.errors === undefined
    && res.data?.repository?.labels?.nodes?.some((l: any) => l.name === 'bug'),
    res.errors ? res.errors.map((e) => e.message).join('; ') : JSON.stringify(res.data));
}

{
  const res = await gql(`{ viewer { url repositories(first: 5) { nodes { name } totalCount } } }`);
  check('gql: advertised User fields resolve (url/repositories)', res.errors === undefined
    && res.data?.viewer?.repositories?.nodes?.some((r: any) => r.name === REPO),
    res.errors ? res.errors.map((e) => e.message).join('; ') : JSON.stringify(res.data));
}

{
  const res = await gql(`{ repository(owner: "${OWNER}", name: "${REPO}") {
    pullRequest(number: 1) { labels { nodes { name } } comments { totalCount } headRef { name } baseRef { name } } } }`);
  check('gql: advertised PullRequest fields resolve (labels/comments/refs)', res.errors === undefined
    && res.data?.repository?.pullRequest?.headRef?.name === 'feature'
    && res.data?.repository?.pullRequest?.baseRef?.name === 'main',
    res.errors ? res.errors.map((e) => e.message).join('; ') : JSON.stringify(res.data));
}

{
  const res = await gql(`{ repository(owner: "${OWNER}", name: "${REPO}") { defaultBranchRef { name target { oid } } } }`);
  check('gql: Ref.target.oid is the branch head sha', res.data?.repository?.defaultBranchRef?.target?.oid === headSha,
    JSON.stringify(res.data?.repository?.defaultBranchRef));
}

{
  const close = await gql(`mutation { updateIssue(input: { id: "${issueGid}", state: CLOSED }) { issue { state } } }`);
  check('gql: advertised Mutation.updateIssue executes', close.errors === undefined && close.data?.updateIssue?.issue?.state === 'CLOSED',
    close.errors ? close.errors.map((e) => e.message).join('; ') : JSON.stringify(close.data));
  const reopen = await gql(`mutation { reopenIssue(input: { issueId: "${issueGid}" }) { issue { state } } }`);
  check('gql: advertised Mutation.reopenIssue executes', reopen.errors === undefined && reopen.data?.reopenIssue?.issue?.state === 'OPEN',
    reopen.errors ? reopen.errors.map((e) => e.message).join('; ') : JSON.stringify(reopen.data));
}

{
  const doc = 'query A { viewer { login } } query B { viewer { name } }';
  const res = await gql(doc, undefined, 'Nope');
  check('gql: an unmatched operationName is an error, not a silent first-op run', Array.isArray(res.errors) && res.errors.length > 0,
    JSON.stringify(res));
  const named = await gql(doc, undefined, 'B');
  check('gql: a matched operationName runs that operation', named.data?.viewer?.name === 'ada iversen', JSON.stringify(named.data));
}

{
  const res = await gql(`{ node(id: "${issueGid}") { ... on Issue { title } } }`);
  check('gql: node(id) with an inline fragment reads the issue', res.data?.node?.title === 'alpha crash on start',
    JSON.stringify(res.data));
}

{
  const res = await gql('{ viewer { nosuchfield } }');
  check('gql: unknown field still returns a GraphQL error', Array.isArray(res.errors) && /nosuchfield|doesn't exist/.test(res.errors[0]?.message ?? ''),
    JSON.stringify(res));
}

{
  const res = await gql(`mutation { createIssue(input: { repositoryId: "${repoGid}", title: "zeta via graphql", clientMutationId: "cm-1" }) { clientMutationId issue { number title } } }`);
  check('gql: createIssue echoes clientMutationId', res.data?.createIssue?.clientMutationId === 'cm-1' && res.data?.createIssue?.issue?.title === 'zeta via graphql',
    JSON.stringify(res.data));
  const back = await http('GET', `/api/v3/repos/${OWNER}/${REPO}/issues/${res.data?.createIssue?.issue?.number}`);
  check('gql: a GraphQL-created issue reads back through REST', back.status === 200 && (back.body as any)?.title === 'zeta via graphql');
}

// ---------------------------------------------------------------- MCP

process.stdout.write('\nMCP\n');

{
  const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'probe', version: '0' } } });
  const body = res.body as any;
  check('mcp: initialize answers with a supported protocol version', res.status === 200 && ['2025-11-25', '2026-07-28', '2025-06-18', '2025-03-26'].includes(body?.result?.protocolVersion),
    JSON.stringify(body));
}
{
  const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'server/discover', params: {} });
  const body = res.body as any;
  check('mcp: server/discover lists 2026-07-28', body?.result?.supportedVersions?.includes('2026-07-28'), JSON.stringify(body));
}
{
  const res = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
  const tools = (res.body as any)?.result?.tools ?? [];
  check('mcp: tools/list gives every tool an object inputSchema', tools.length === 8 && tools.every((t: any) => t.inputSchema?.type === 'object'),
    `${tools.length} tools`);
}
{
  const res = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } });
  check('mcp: unknown tool is a -32602 error', (res.body as any)?.error?.code === -32602, JSON.stringify(res.body));
}
{
  const res = await rpc({ jsonrpc: '2.0', id: 5, method: 'no/such-method', params: {} });
  check('mcp: unknown method is a -32601 error', (res.body as any)?.error?.code === -32601, JSON.stringify(res.body));
}
{
  const res = await http('POST', '/mcp', '{not json');
  check('mcp: malformed JSON is a 400 parse error', res.status === 400 && (res.body as any)?.error?.code === -32700, `status ${res.status}`);
}
{
  const res = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  check('mcp: a notification is answered 202 with no body', res.status === 202 && res.text === '', `status ${res.status}`);
}
{
  const res = await rpc({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'get_issue', arguments: { owner: OWNER, repo: REPO } } });
  check('mcp: a missing required argument is a -32602 error', (res.body as any)?.error?.code === -32602, JSON.stringify(res.body));
}
{
  const res = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_repo', arguments: { owner: OWNER, repo: 'no-such-repo' } } });
  const body = res.body as any;
  check('mcp: a tool failure is an isError result, not an RPC error', body?.result?.isError === true && body?.error === undefined, JSON.stringify(body));
}
{
  const res = await rpc([
    { jsonrpc: '2.0', id: 'a', method: 'ping', params: {} },
    { jsonrpc: '2.0', id: 'b', method: 'tools/list', params: {} },
  ]);
  const body = res.body as any;
  check('mcp: a JSON-RPC batch gets a response per request', Array.isArray(body) && body.length === 2 && body.every((r: any) => r.jsonrpc === '2.0'),
    `status ${res.status} body ${JSON.stringify(body).slice(0, 160)}`);
}
{
  const res = await rpc({ jsonrpc: '2.0', id: 'string-id', method: 'ping', params: {} });
  check('mcp: a string request id is echoed', (res.body as any)?.id === 'string-id', JSON.stringify(res.body));
}
{
  const res = await rpc({ jsonrpc: '2.0', id: 12, method: 'prompts/list', params: {} });
  const body = res.body as any;
  check('mcp: an unsupported list method fails cleanly (error or empty list)', res.status === 200 && (body?.error !== undefined || Array.isArray(body?.result?.prompts)),
    `status ${res.status} ${JSON.stringify(body).slice(0, 120)}`);
}
{
  const call = await rpc({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'create_issue', arguments: { owner: OWNER, repo: REPO, title: 'eta via mcp', body: 'made by the probe' } } });
  const created = (call.body as any)?.result?.structuredContent;
  check('mcp: create_issue returns the created issue', created?.title === 'eta via mcp' && typeof created?.number === 'number', JSON.stringify(call.body).slice(0, 200));
  const back = await http('GET', `/api/v3/repos/${OWNER}/${REPO}/issues/${created?.number}`);
  check('mcp: an MCP-created issue reads back through REST', back.status === 200 && (back.body as any)?.title === 'eta via mcp');
}

// ---------------------------------------------------------------- REST

process.stdout.write('\nREST\n');

{
  const res = await http('GET', `/api/v3/repos/${OWNER}/${REPO}/issues?state=all&per_page=2&page=1`);
  const link = res.headers.get('link') ?? '';
  check('rest: issue list carries a Link pagination header', /rel="next"/.test(link) && /rel="last"/.test(link), `link=${link}`);
  const page2 = await http('GET', `/api/v3/repos/${OWNER}/${REPO}/issues?state=all&per_page=2&page=2`);
  const firstPage = (res.body as any[]).map((i) => i.number);
  const secondPage = (page2.body as any[]).map((i) => i.number);
  check('rest: issue pages do not overlap', firstPage.every((n) => !secondPage.includes(n)) && secondPage.length > 0,
    `p1=${firstPage} p2=${secondPage}`);
}
{
  await http('PUT', `/api/v3/repos/${OWNER}/${REPO}/contents/dir/inner.txt`, { message: 'add inner', content: Buffer.from('inner\n').toString('base64') });
  const res = await http('GET', `/api/v3/repos/${OWNER}/${REPO}/contents/dir`);
  check('rest: contents of a directory lists its entries', Array.isArray(res.body) && (res.body as any[]).some((e) => e.name === 'inner.txt'),
    `status ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
}
{
  const res = await http('POST', '/api/v3/user/repos', { name: REPO });
  check('rest: creating a duplicate repository is a 422', res.status === 422, `status ${res.status}`);
}
{
  const res = await http('GET', `/api/v3/repos/${OWNER}/no-such-repo`);
  check('rest: a missing repository is a 404 with a message', res.status === 404 && (res.body as any)?.message === 'Not Found', `status ${res.status}`);
}
{
  const post = await http('POST', `/api/v3/repos/${OWNER}/${REPO}/issues/1/comments`, { body: 'probe comment' });
  const list = await http('GET', `/api/v3/repos/${OWNER}/${REPO}/issues/1/comments`);
  check('rest: issue comments round-trip', post.status === 201 && Array.isArray(list.body) && (list.body as any[]).some((c) => c.body === 'probe comment'),
    `post ${post.status} list ${list.status}`);
}
{
  const res = await http('GET', `/api/v3/repos/${OWNER}/${REPO}/issues?state=all&labels=bug`);
  check('rest: the labels query filters issues', Array.isArray(res.body) && (res.body as any[]).length === 1 && (res.body as any[])[0]?.title === 'alpha crash on start',
    JSON.stringify((res.body as any[])?.map((i) => i.number)));
}
{
  const res = await http('GET', `/api/v3/repos/${OWNER}/${REPO}/pulls/1/files`);
  check('rest: pull files lists the changed path', res.status === 200 && Array.isArray(res.body) && (res.body as any[]).some((f) => f.filename === 'feature.txt'),
    `status ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
}
{
  const patch = await http('PATCH', `/api/v3/repos/${OWNER}/${REPO}`, { description: 'patched description' });
  const get = await http('GET', `/api/v3/repos/${OWNER}/${REPO}`);
  check('rest: PATCH updates the repository description', patch.status === 200 && (get.body as any)?.description === 'patched description',
    `patch ${patch.status}`);
}
{
  const res = await http('GET', `/api/v3/repos/${OWNER}/${REPO}`);
  note('rest: rate-limit headers present', res.headers.get('x-ratelimit-limit') !== null, `x-ratelimit-limit=${res.headers.get('x-ratelimit-limit')}`);
}

// ---------------------------------------------------------------- git wire

process.stdout.write('\ngit wire\n');

{
  const refs = await http('GET', `/${OWNER}/${REPO}.git/info/refs?service=git-upload-pack`);
  check('wire: annotated tag advertises a peeled ^{} line', refs.text.includes('refs/tags/v1^{}'), refs.text.slice(0, 200));
}
{
  // rewrite history and try to force-push: the forge is fast-forward only
  const scratch = mkdtempSync(join(tmpdir(), 'forge-probe-ff-'));
  await git(['clone', remote, '.'], scratch);
  await git(['config', 'user.email', 'probe@example.invalid'], scratch);
  await git(['config', 'user.name', 'probe'], scratch);
  // Compare against the server's current main: later REST contents writes may have
  // advanced it past the sha captured during setup.
  const mainBefore = (await git(['ls-remote', remote, 'refs/heads/main'], scratch)).trim();
  await git(['reset', '--hard', 'HEAD~1'], scratch);
  writeFileSync(join(scratch, 'file.txt'), 'rewritten\n');
  await git(['add', '.'], scratch); await git(['commit', '-m', 'rewrite'], scratch);
  const out = await git([...authArgs, 'push', 'origin', 'main'], scratch);
  check('wire: a non-fast-forward push is rejected', /rejected|non-fast-forward|ng /.test(out), out.slice(0, 200));
  const after = await git(['ls-remote', remote, 'refs/heads/main'], work);
  check('wire: the rejected push left main untouched', after.trim() === mainBefore, `${mainBefore} -> ${after.trim()}`);
}
{
  await git(['checkout', '-b', 'topic'], work);
  await git([...authArgs, 'push', 'origin', 'topic'], work);
  await git([...authArgs, 'push', 'origin', ':refs/heads/topic'], work);
  const refs = await git(['ls-remote', remote, 'refs/heads/topic'], work);
  check('wire: deleting a branch by push removes it', refs.trim() === '', refs.trim());
}
{
  const empty = await http('POST', '/api/v3/user/repos', { name: 'probe-empty' });
  check('setup: create empty repo', empty.status === 201, `status ${empty.status}`);
  const dest = mkdtempSync(join(tmpdir(), 'forge-probe-empty-'));
  const out = await git(['clone', `${base}/${OWNER}/probe-empty.git`, 'clone'], dest);
  check('wire: cloning an empty repository succeeds', !/fatal/.test(out), out.slice(0, 160));
}
{
  const dest = mkdtempSync(join(tmpdir(), 'forge-probe-shallow-'));
  await git(['clone', '--depth', '1', remote, 'clone'], dest);
  const cloneDir = join(dest, 'clone');
  await git(['fetch', '--deepen', '1', 'origin'], cloneDir);
  const log = await git(['log', '--oneline'], cloneDir);
  check('wire: a shallow clone deepens on request', log.trim().split('\n').length >= 2, log.trim());
}

process.stdout.write(`\nprobes: ${passed} passed, ${failed} failed, ${noted} notes\n`);
if (failures.length > 0) process.stdout.write(`failing: ${failures.join(', ')}\n`);
server.close();
process.exit(failed > 0 ? 1 : 0);

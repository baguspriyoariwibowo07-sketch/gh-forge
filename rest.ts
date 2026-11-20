// The GitHub REST v3 surface: users, repositories, contents, refs, labels, issues,
// comments and pull requests, all over the same store the git protocol writes to.

import {
  VIEWER,
  ZERO_OID,
  getObject,
  putObject,
  parseCommit,
  parseTree,
  commitFiles,
  writeTreeFromFiles,
  buildCommitData,
  findRepo,
  createRepoRec,
  deleteRepoRec,
  viewerRepos,
  branchRef,
  resolveCommit,
  squashMerge,
  diffFiles,
  mergeBase,
  type RepoRec,
  type IssueRec,
  type PullRec,
  type TreeEntry,
} from './store.ts';

export interface RestRequest {
  readonly method: string;
  readonly segments: readonly string[];
  readonly query: URLSearchParams;
  readonly body: unknown;
  readonly rawBody: Buffer;
  readonly host: string;
}

export interface RestResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

const notFound = (): RestResponse => ({ status: 404, body: { message: 'Not Found' } });
const badRequest = (message: string): RestResponse => ({ status: 400, body: { message } });
const unprocessable = (message: string): RestResponse => ({ status: 422, body: { message } });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(body: unknown, name: string): string | undefined {
  if (!isRecord(body)) return undefined;
  const value = body[name];
  return typeof value === 'string' ? value : undefined;
}

// ------------------------------------------------------------------ JSON views

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    html_url: `https://forge.local/${repo.owner}/${repo.name}`,
  };
}

/** A REST issue id: unique per repo and number, stable across reads and surfaces. */
export function restIssueId(repo: RepoRec, number: number): number {
  return repo.id * 1_000_000 + number;
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: restIssueId(repo, issue.number),
    node_id: `I_${repo.id}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: label?.description ?? '' };
    }),
    comments: issue.comments.length,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
  };
}

export function commentJson(repo: RepoRec, comment: { id: number; body: string }): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + comment.id,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
  };
}

export function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = repo.refs.get(branchRef(pull.headRef)) ?? pull.headSha;
  const baseSha = repo.refs.get(branchRef(pull.baseRef)) ?? pull.baseSha;
  return {
    id: repo.id * 1_000_000 + pull.number,
    node_id: `PR_${repo.id}_${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
  };
}

// ------------------------------------------------------------------ shared writes

export interface CreateIssueResult {
  issue?: IssueRec;
  error?: RestResponse;
}

export function createIssue(repo: RepoRec, title: string, body: string, labelNames: readonly string[]): CreateIssueResult {
  for (const name of labelNames) {
    if (!repo.labels.has(name)) return { error: unprocessable(`Label "${name}" does not exist in this repository`) };
  }
  const issue: IssueRec = {
    number: repo.nextIssue,
    title,
    body,
    state: 'open',
    labels: [...labelNames],
    comments: [],
  };
  repo.nextIssue += 1;
  repo.issues.set(issue.number, issue);
  return { issue };
}

export interface CreatePullResult {
  pull?: PullRec;
  error?: RestResponse;
}

export function createPull(repo: RepoRec, title: string, body: string, head: string, base: string): CreatePullResult {
  const headSha = repo.refs.get(branchRef(head));
  if (headSha === undefined) return { error: unprocessable(`Head branch "${head}" does not exist`) };
  const baseSha = repo.refs.get(branchRef(base));
  if (baseSha === undefined) return { error: unprocessable(`Base branch "${base}" does not exist`) };
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
      return { error: unprocessable('A pull request already exists for this head and base') };
    }
  }
  const pull: PullRec = {
    number: repo.nextPull,
    title,
    body,
    state: 'open',
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    merged: false,
    mergeSha: null,
    mergedAt: null,
  };
  repo.nextPull += 1;
  repo.pulls.set(pull.number, pull);
  return { pull };
}

export interface MergeResult {
  sha?: string;
  error?: RestResponse;
}

export function mergePull(repo: RepoRec, pull: PullRec): MergeResult {
  if (pull.merged) return { sha: pull.mergeSha ?? undefined };
  if (pull.state !== 'open') return { error: { status: 405, body: { message: 'Pull request is not open' } } };
  const sha = squashMerge(repo, pull);
  if (sha === null) return { error: { status: 405, body: { message: 'Pull request is not mergeable: its changes conflict with the base branch' } } };
  pull.merged = true;
  pull.state = 'closed';
  pull.mergeSha = sha;
  pull.mergedAt = new Date(1_700_000_000_000 + pull.number * 60_000 + repo.id * 1000).toISOString();
  return { sha };
}

// ------------------------------------------------------------------ contents writes

interface ContentsWriteResult {
  status: number;
  blobOid: string;
  commitOid: string;
}

/**
 * Write one file on a branch as a real git commit. A missing branch is created from the
 * default branch's tip (or as a root commit on an empty repository).
 */
export function putContentsFile(
  repo: RepoRec,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
  expectedSha: string | undefined,
): ContentsWriteResult | RestResponse {
  const ref = branchRef(branch);
  let tip = repo.refs.get(ref);
  if (tip === undefined) {
    const fallback = repo.refs.get(branchRef(repo.defaultBranch));
    tip = fallback;
  }
  const files = tip === undefined ? new Map<string, TreeEntry>() : commitFiles(tip);
  const existing = files.get(path);
  if (expectedSha !== undefined && (existing === undefined || existing.oid !== expectedSha)) {
    return { status: 409, body: { message: 'The sha does not match the current content' } };
  }
  const blobOid = putObject('blob', content);
  files.set(path, { mode: '100644', name: path.split('/').pop() as string, oid: blobOid });
  const tree = writeTreeFromFiles(files);
  const commitOid = putObject('commit', buildCommitData(tree, tip === undefined ? [] : [tip], message));
  repo.refs.set(ref, commitOid);
  return { status: existing === undefined ? 201 : 200, blobOid, commitOid };
}

export function deleteContentsFile(
  repo: RepoRec,
  branch: string,
  path: string,
  sha: string | undefined,
  message: string,
): { commitOid: string } | RestResponse {
  const ref = branchRef(branch);
  const tip = repo.refs.get(ref);
  if (tip === undefined) return notFound();
  const files = commitFiles(tip);
  const existing = files.get(path);
  if (existing === undefined) return notFound();
  if (sha !== undefined && existing.oid !== sha) {
    return { status: 409, body: { message: 'The sha does not match the current content' } };
  }
  files.delete(path);
  const tree = writeTreeFromFiles(files);
  const commitOid = putObject('commit', buildCommitData(tree, [tip], message));
  repo.refs.set(ref, commitOid);
  return { commitOid };
}

// ------------------------------------------------------------------ pagination

interface Page {
  page: number;
  perPage: number;
}

function pageOf(query: URLSearchParams): Page {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  return {
    perPage: Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1,
  };
}

function paginate<T>(items: readonly T[], page: Page): T[] {
  const start = (page.page - 1) * page.perPage;
  return items.slice(start, start + page.perPage);
}

function linkHeader(host: string, path: string, query: URLSearchParams, page: Page, total: number): Record<string, string> {
  const lastPage = Math.max(1, Math.ceil(total / page.perPage));
  const url = (p: number): string => {
    const params = new URLSearchParams(query);
    params.set('page', String(p));
    params.set('per_page', String(page.perPage));
    return `<http://${host}${path}?${params.toString()}>`;
  };
  const links: string[] = [];
  if (page.page < lastPage) links.push(`${url(page.page + 1)}; rel="next"`, `${url(lastPage)}; rel="last"`);
  if (page.page > 1) links.push(`${url(page.page - 1)}; rel="prev"`, `${url(1)}; rel="first"`);
  return links.length > 0 ? { link: links.join(', ') } : {};
}

// ------------------------------------------------------------------ the router

export function handleRest(req: RestRequest): RestResponse {
  const { method, segments } = req;

  // GET /api/v3/ — the API root.
  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      headers: { 'x-oauth-scopes': 'repo, read:org' },
      body: {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues?q={query}',
        rate_limit_url: '/api/v3/rate_limit',
      },
    };
  }

  const [head, ...rest] = segments as [string, ...string[]];

  if (head === 'meta' && rest.length === 0 && method === 'GET') {
    return { status: 200, body: { installed_version: '1.0.0', verifiable_password_authentication: false } };
  }

  if (head === 'user' && rest.length === 0 && method === 'GET') {
    return {
      status: 200,
      body: { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' },
    };
  }

  if (head === 'user' && rest[0] === 'repos' && rest.length === 1) {
    if (method === 'GET') {
      const page = pageOf(req.query);
      const all = viewerRepos();
      const items = paginate(all, page).map(repoJson);
      return { status: 200, body: items, headers: linkHeader(req.host, '/api/v3/user/repos', req.query, page, all.length) };
    }
    if (method === 'POST') {
      const name = stringField(req.body, 'name');
      if (name === undefined || name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        return unprocessable('Repository name is invalid');
      }
      if (findRepo(VIEWER.login, name)) {
        return unprocessable(`A repository named "${name}" already exists on this account`);
      }
      const description = stringField(req.body, 'description') ?? '';
      const isPrivate = isRecord(req.body) && typeof req.body.private === 'boolean' ? req.body.private : false;
      const repo = createRepoRec(VIEWER.login, name, description, isPrivate);
      return { status: 201, body: repoJson(repo) };
    }
    return notFound();
  }

  if (head === 'repos' && rest.length >= 2) {
    const owner = rest[0] as string;
    const name = rest[1] as string;
    const repo = findRepo(owner, name);
    if (!repo) return notFound();
    return handleRepo(req, repo, rest.slice(2));
  }

  return notFound();
}

function handleRepo(req: RestRequest, repo: RepoRec, tail: readonly string[]): RestResponse {
  const { method } = req;
  if (tail.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(repo) };
    if (method === 'PATCH') {
      const description = stringField(req.body, 'description');
      if (description !== undefined) repo.description = description;
      if (isRecord(req.body) && typeof req.body.private === 'boolean') repo.isPrivate = req.body.private;
      const name = stringField(req.body, 'name');
      if (name !== undefined && name !== repo.name) return unprocessable('Repository renaming is not supported');
      return { status: 200, body: repoJson(repo) };
    }
    if (method === 'DELETE') {
      deleteRepoRec(repo);
      return { status: 204 };
    }
    return notFound();
  }

  const [section, ...sub] = tail as [string, ...string[]];
  switch (section) {
    case 'contents':
      return handleContents(req, repo, sub.join('/'));
    case 'labels':
      return handleLabels(req, repo, sub);
    case 'issues':
      return handleIssues(req, repo, sub);
    case 'pulls':
      return handlePulls(req, repo, sub);
    case 'branches':
      return handleBranches(req, repo, sub);
    case 'commits':
      return handleCommits(req, repo, sub);
    case 'git':
      return handleGitData(req, repo, sub);
    default:
      return notFound();
  }
}

// ------------------------------------------------------------------ contents

function handleContents(req: RestRequest, repo: RepoRec, path: string): RestResponse {
  const { method } = req;
  if (path === '') return notFound();
  if (method === 'GET') {
    const refName = req.query.get('ref') ?? repo.defaultBranch;
    const commit = resolveCommit(repo, refName);
    if (commit === null) return notFound();
    const commitObject = getObject(commit);
    if (!commitObject) return notFound();
    const rootTree = parseCommit(commitObject.data).tree;
    return contentsRead(repo, rootTree, path);
  }
  if (method === 'PUT') {
    const message = stringField(req.body, 'message');
    const contentB64 = stringField(req.body, 'content');
    if (message === undefined || contentB64 === undefined) return badRequest('message and content are required');
    const branch = stringField(req.body, 'branch') ?? repo.defaultBranch;
    const sha = stringField(req.body, 'sha');
    const content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    const result = putContentsFile(repo, branch, path, content, message, sha);
    if ('status' in result && 'blobOid' in result) {
      const ok = result as { status: number; blobOid: string; commitOid: string };
      return {
        status: ok.status,
        body: {
          content: {
            name: path.split('/').pop() ?? path,
            path,
            sha: ok.blobOid,
            size: content.length,
            type: 'file',
            encoding: 'base64',
          },
          commit: { sha: ok.commitOid, message },
        },
      };
    }
    return result as RestResponse;
  }
  if (method === 'DELETE') {
    const message = stringField(req.body, 'message') ?? `Delete ${path}`;
    const branch = stringField(req.body, 'branch') ?? repo.defaultBranch;
    const sha = stringField(req.body, 'sha');
    const result = deleteContentsFile(repo, branch, path, sha, message);
    if ('commitOid' in result) {
      return { status: 200, body: { content: null, commit: { sha: result.commitOid, message } } };
    }
    return result;
  }
  return notFound();
}

function contentsRead(repo: RepoRec, treeOid: string, path: string): RestResponse {
  const segments = path.split('/');
  let currentTree = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const treeObject = getObject(currentTree);
    if (!treeObject || treeObject.type !== 'tree') return notFound();
    const entry = parseTree(treeObject.data).find((candidate) => candidate.name === segments[i]);
    if (!entry) return notFound();
    const isLast = i === segments.length - 1;
    if (!isLast) {
      if (entry.mode !== '40000' && entry.mode !== '040000') return notFound();
      currentTree = entry.oid;
      continue;
    }
    if (entry.mode === '40000' || entry.mode === '040000') {
      const dirObject = getObject(entry.oid);
      if (!dirObject || dirObject.type !== 'tree') return notFound();
      const entries = parseTree(dirObject.data).map((child) => ({
        type: child.mode === '40000' || child.mode === '040000' ? 'dir' : 'file',
        name: child.name,
        path: `${path}/${child.name}`,
        sha: child.oid,
      }));
      return { status: 200, body: entries };
    }
    const blob = getObject(entry.oid);
    if (!blob || blob.type !== 'blob') return notFound();
    return {
      status: 200,
      body: {
        type: 'file',
        name: entry.name,
        path,
        sha: entry.oid,
        size: blob.data.length,
        encoding: 'base64',
        content: blob.data.toString('base64'),
      },
    };
  }
  return notFound();
}

// ------------------------------------------------------------------ labels

function handleLabels(req: RestRequest, repo: RepoRec, sub: readonly string[]): RestResponse {
  if (sub.length === 0) {
    if (req.method === 'GET') {
      return { status: 200, body: [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: label.description })) };
    }
    if (req.method === 'POST') {
      const name = stringField(req.body, 'name');
      if (name === undefined || name === '') return unprocessable('Label name is required');
      if (repo.labels.has(name)) return unprocessable(`Label "${name}" already exists`);
      const color = (stringField(req.body, 'color') ?? 'ededed').replace(/^#/, '');
      const description = stringField(req.body, 'description') ?? '';
      repo.labels.set(name, { name, color, description });
      return { status: 201, body: { name, color, description } };
    }
  }
  return notFound();
}

// ------------------------------------------------------------------ issues

function handleIssues(req: RestRequest, repo: RepoRec, sub: readonly string[]): RestResponse {
  const { method, query } = req;
  if (sub.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      // `?labels=a,b` keeps only issues carrying every named label.
      const labelsParam = query.get('labels');
      if (labelsParam !== null && labelsParam !== '') {
        const wanted = labelsParam.split(',').map((name) => name.trim()).filter((name) => name !== '');
        if (wanted.length > 0) issues = issues.filter((issue) => wanted.every((name) => issue.labels.includes(name)));
      }
      const direction = query.get('direction') ?? 'desc';
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const page = pageOf(query);
      return {
        status: 200,
        body: paginate(issues, page).map((issue) => issueJson(repo, issue)),
        headers: linkHeader(req.host, `/api/v3/repos/${repo.owner}/${repo.name}/issues`, query, page, issues.length),
      };
    }
    if (method === 'POST') {
      const title = stringField(req.body, 'title');
      if (title === undefined || title === '') return unprocessable('Issue title is required');
      const body = stringField(req.body, 'body') ?? '';
      const labelNames = isRecord(req.body) && Array.isArray(req.body.labels)
        ? (req.body.labels as unknown[]).filter((value): value is string => typeof value === 'string')
        : [];
      const result = createIssue(repo, title, body, labelNames);
      if (result.error) return result.error;
      return { status: 201, body: issueJson(repo, result.issue as IssueRec) };
    }
    return notFound();
  }
  const number = Number(sub[0]);
  if (!Number.isInteger(number) || number <= 0) return notFound();
  const issue = repo.issues.get(number);
  if (sub.length === 1) {
    if (!issue) return notFound();
    if (method === 'GET') return { status: 200, body: issueJson(repo, issue) };
    if (method === 'PATCH') {
      const state = stringField(req.body, 'state');
      if (state === 'open' || state === 'closed') issue.state = state;
      const title = stringField(req.body, 'title');
      if (title !== undefined) issue.title = title;
      const body = stringField(req.body, 'body');
      if (body !== undefined) issue.body = body;
      return { status: 200, body: issueJson(repo, issue) };
    }
    return notFound();
  }
  if (sub.length === 2 && sub[1] === 'comments') {
    if (!issue) return notFound();
    if (method === 'GET') {
      return { status: 200, body: issue.comments.map((comment) => commentJson(repo, comment)) };
    }
    if (method === 'POST') {
      const body = stringField(req.body, 'body');
      if (body === undefined) return badRequest('Comment body is required');
      const comment = { id: repo.nextComment, body };
      repo.nextComment += 1;
      issue.comments.push(comment);
      return { status: 201, body: commentJson(repo, comment) };
    }
  }
  if (sub.length === 2 && sub[1] === 'labels' && method === 'POST') {
    if (!issue) return notFound();
    const names = isRecord(req.body) && Array.isArray(req.body.labels)
      ? (req.body.labels as unknown[]).filter((value): value is string => typeof value === 'string')
      : [];
    for (const name of names) if (!repo.labels.has(name)) return unprocessable(`Label "${name}" does not exist in this repository`);
    for (const name of names) if (!issue.labels.includes(name)) issue.labels.push(name);
    return { status: 200, body: issueJson(repo, issue).labels };
  }
  return notFound();
}

// ------------------------------------------------------------------ pulls

function handlePulls(req: RestRequest, repo: RepoRec, sub: readonly string[]): RestResponse {
  const { method, query } = req;
  if (sub.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => a.number - b.number);
      const page = pageOf(query);
      return { status: 200, body: paginate(pulls, page).map((pull) => pullJson(repo, pull)) };
    }
    if (method === 'POST') {
      const title = stringField(req.body, 'title');
      const head = stringField(req.body, 'head');
      const base = stringField(req.body, 'base');
      if (title === undefined || head === undefined || base === undefined) {
        return unprocessable('title, head and base are required');
      }
      const body = stringField(req.body, 'body') ?? '';
      const result = createPull(repo, title, body, head.replace(/^[^:]+:/, ''), base);
      if (result.error) return result.error;
      return { status: 201, body: pullJson(repo, result.pull as PullRec) };
    }
    return notFound();
  }
  const number = Number(sub[0]);
  if (!Number.isInteger(number) || number <= 0) return notFound();
  const pull = repo.pulls.get(number);
  if (sub.length === 1) {
    if (!pull) return notFound();
    if (method === 'GET') return { status: 200, body: pullJson(repo, pull) };
    if (method === 'PATCH') {
      const state = stringField(req.body, 'state');
      if ((state === 'open' || state === 'closed') && !pull.merged) pull.state = state;
      const title = stringField(req.body, 'title');
      if (title !== undefined) pull.title = title;
      const body = stringField(req.body, 'body');
      if (body !== undefined) pull.body = body;
      return { status: 200, body: pullJson(repo, pull) };
    }
    return notFound();
  }
  if (!pull) return notFound();
  if (sub.length === 2 && sub[1] === 'files' && method === 'GET') {
    const baseSha = repo.refs.get(branchRef(pull.baseRef)) ?? pull.baseSha;
    const headSha = repo.refs.get(branchRef(pull.headRef)) ?? pull.headSha;
    return { status: 200, body: diffForPull(baseSha, headSha) };
  }
  if (sub.length === 2 && sub[1] === 'merge' && method === 'PUT') {
    const result = mergePull(repo, pull);
    if (result.error) return result.error;
    return { status: 200, body: { sha: result.sha, merged: true, message: 'Pull Request successfully merged' } };
  }
  return notFound();
}

/** The file changes of a pull request (merge-base..head), shared by REST and GraphQL. */
export function pullChanges(repo: RepoRec, pull: PullRec): ReturnType<typeof diffFiles> {
  const baseSha = repo.refs.get(branchRef(pull.baseRef)) ?? pull.baseSha;
  const headSha = repo.refs.get(branchRef(pull.headRef)) ?? pull.headSha;
  const base = mergeBase(headSha, baseSha) ?? baseSha;
  return diffFiles(base, headSha);
}

function diffForPull(baseSha: string, headSha: string): unknown {
  // The diff a reviewer sees is merge-base..head, so base-branch movement since the
  // pull request opened does not invent changes.
  const base = mergeBase(headSha, baseSha) ?? baseSha;
  return diffFiles(base, headSha).map((change) => ({
    filename: change.filename,
    status: change.status,
    additions: change.additions,
    deletions: change.deletions,
    changes: change.changes,
  }));
}

// ------------------------------------------------------------------ branches, commits, git data

function handleBranches(req: RestRequest, repo: RepoRec, sub: readonly string[]): RestResponse {
  if (sub.length === 0 && req.method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    return { status: 200, body: branches };
  }
  if (sub.length >= 1 && req.method === 'GET') {
    const branch = sub.join('/');
    const oid = repo.refs.get(branchRef(branch));
    if (oid === undefined) return notFound();
    return { status: 200, body: { name: branch, commit: { sha: oid }, protected: false } };
  }
  return notFound();
}

function handleCommits(req: RestRequest, repo: RepoRec, sub: readonly string[]): RestResponse {
  if (req.method !== 'GET') return notFound();
  if (sub.length === 1) {
    const object = getObject(sub[0] as string);
    if (!object || object.type !== 'commit') return notFound();
    const parts = parseCommit(object.data);
    return { status: 200, body: { sha: sub[0], commit: { message: parts.message.replace(/\n$/, ''), tree: { sha: parts.tree } } } };
  }
  if (sub.length !== 0) return notFound();
  const startName = req.query.get('sha') ?? repo.defaultBranch;
  const start = resolveCommit(repo, startName);
  if (start === null) return { status: 200, body: [] };
  const seen = new Set<string>();
  const ordered: string[] = [];
  const stack = [start];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = getObject(oid);
    if (!object || object.type !== 'commit') continue;
    ordered.push(oid);
    const parents = parseCommit(object.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
  }
  const page = pageOf(req.query);
  const items = paginate(ordered, page).map((oid) => {
    const parts = parseCommit((getObject(oid) as { data: Buffer }).data);
    return { sha: oid, commit: { message: parts.message.replace(/\n$/, ''), tree: { sha: parts.tree } } };
  });
  return { status: 200, body: items };
}

function handleGitData(req: RestRequest, repo: RepoRec, sub: readonly string[]): RestResponse {
  if (sub[0] === 'refs' && sub[1] === 'heads' && sub.length >= 3 && req.method === 'GET') {
    const branch = sub.slice(2).join('/');
    const oid = repo.refs.get(branchRef(branch));
    if (oid === undefined) return notFound();
    return { status: 200, body: { ref: branchRef(branch), object: { sha: oid, type: 'commit' } } };
  }
  if (sub[0] === 'refs' && sub.length === 1) {
    if (req.method === 'POST') {
      const ref = stringField(req.body, 'ref');
      const sha = stringField(req.body, 'sha');
      if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) return unprocessable('ref and sha are required');
      if (!getObject(sha)) return unprocessable('The sha does not name an object in this repository');
      if (repo.refs.has(ref)) return unprocessable(`Reference ${ref} already exists`);
      repo.refs.set(ref, sha);
      return { status: 201, body: { ref, object: { sha, type: 'commit' } } };
    }
    if (req.method === 'GET') {
      const refs = [...repo.refs.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([ref, oid]) => ({ ref, object: { sha: oid, type: 'commit' } }));
      return { status: 200, body: refs };
    }
  }
  return notFound();
}

export { ZERO_OID };

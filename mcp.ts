// The Model Context Protocol endpoint: JSON-RPC 2.0 over streamable HTTP, speaking the
// 2026-07-28 revision through server/discover and the legacy initialize handshake. The
// tools act on the same store as REST and GraphQL, so ids and objects agree across
// surfaces.

import { VIEWER, findRepo, createRepoRec, viewerRepos, type RepoRec } from './store.ts';
import { repoJson, issueJson, pullJson, createIssue, createPull, mergePull } from './rest.ts';

const SERVER_INFO = { name: 'gh-forge', version: '1.0.0' } as const;
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'] as const;

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly run: (args: Record<string, unknown>) => unknown;
}

function stringProp(description: string): Record<string, unknown> {
  return { type: 'string', description };
}

function ownerRepoProps(): Record<string, unknown> {
  return { owner: stringProp('The repository owner login'), repo: stringProp('The repository name') };
}

function requireRepo(args: Record<string, unknown>): RepoRec {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : '';
  const repo = findRepo(owner, name);
  if (!repo) throw new ToolFailure(`repository ${owner}/${name} was not found`);
  return repo;
}

class ToolFailure extends Error {}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: stringProp('The repository name'),
        description: stringProp('A short description of the repository'),
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
    run: (args) => {
      const name = typeof args.name === 'string' ? args.name : '';
      if (name === '') throw new ToolFailure('name is required');
      if (findRepo(VIEWER.login, name)) throw new ToolFailure(`a repository named ${name} already exists`);
      const repo = createRepoRec(
        VIEWER.login,
        name,
        typeof args.description === 'string' ? args.description : '',
        typeof args.private === 'boolean' ? args.private : false,
      );
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: { type: 'object', properties: ownerRepoProps(), required: ['owner', 'repo'] },
    run: (args) => repoJson(requireRepo(args)),
  },
  {
    name: 'list_repos',
    description: 'List the repositories the authenticated user owns.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: () => viewerRepos().map((repo) => repoJson(repo)),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ownerRepoProps(),
        title: stringProp('The issue title'),
        body: stringProp('The issue body'),
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (args) => {
      const repo = requireRepo(args);
      const result = createIssue(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', []);
      if (result.error || !result.issue) throw new ToolFailure('the issue could not be created');
      return issueJson(repo, result.issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ownerRepoProps(),
        state: stringProp('Filter by state: open, closed or all'),
      },
      required: ['owner', 'repo'],
    },
    run: (args) => {
      const repo = requireRepo(args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => a.number - b.number);
      return issues.map((issue) => issueJson(repo, issue));
    },
  },
  {
    name: 'get_issue',
    description: 'Read one issue of a repository by its number.',
    inputSchema: {
      type: 'object',
      properties: { ...ownerRepoProps(), issue_number: { type: 'number', description: 'The issue number' } },
      required: ['owner', 'repo', 'issue_number'],
    },
    run: (args) => {
      const repo = requireRepo(args);
      const issue = repo.issues.get(Number(args.issue_number));
      if (!issue) throw new ToolFailure('issue not found');
      return issueJson(repo, issue);
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ownerRepoProps(),
        title: stringProp('The pull request title'),
        body: stringProp('The pull request body'),
        head: stringProp('The head branch name'),
        base: stringProp('The base branch name'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (args) => {
      const repo = requireRepo(args);
      const result = createPull(
        repo,
        String(args.title ?? ''),
        typeof args.body === 'string' ? args.body : '',
        String(args.head ?? ''),
        String(args.base ?? ''),
      );
      if (result.error || !result.pull) {
        const message = (result.error?.body as { message?: string } | undefined)?.message ?? 'the pull request could not be created';
        throw new ToolFailure(message);
      }
      return pullJson(repo, result.pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        ...ownerRepoProps(),
        pull_number: { type: 'number', description: 'The pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (args) => {
      const repo = requireRepo(args);
      const pull = repo.pulls.get(Number(args.pull_number));
      if (!pull) throw new ToolFailure('pull request not found');
      const result = mergePull(repo, pull);
      if (result.error) {
        const message = (result.error.body as { message?: string } | undefined)?.message ?? 'the pull request could not be merged';
        throw new ToolFailure(message);
      }
      return pullJson(repo, pull);
    },
  },
];

const TOOLS_LIST_RESULT = {
  tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
};

export interface McpHttpResult {
  readonly status: number;
  readonly body: unknown;
  readonly empty?: boolean;
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function callTool(params: Record<string, unknown>): Record<string, unknown> | { error: { code: number; message: string } } {
  const name = typeof params.name === 'string' ? params.name : '';
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return { error: { code: -32602, message: `unknown tool: ${name}` } };
  const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
  const required = (tool.inputSchema.required as string[] | undefined) ?? [];
  const missing = required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) return { error: { code: -32602, message: `missing required argument(s): ${missing.join(', ')}` } };
  try {
    return toolResult(tool.run(args));
  } catch (err) {
    if (err instanceof ToolFailure) {
      return { content: [{ type: 'text', text: err.message }], isError: true };
    }
    throw err;
  }
}

/** Handle one MCP HTTP request body (already authenticated by the router). */
export function handleMcp(rawBody: Buffer): McpHttpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error: the body is not JSON') };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid request') };
  }
  const request = parsed as Record<string, unknown>;
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id;
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;

  // Notifications carry no id and are answered with an empty 202.
  if (id === undefined) return { status: 202, body: null, empty: true };

  switch (method) {
    case 'server/discover':
      return {
        status: 200,
        body: rpcResult(id, {
          supportedVersions: [...SUPPORTED_VERSIONS],
          capabilities: { tools: {} },
          serverInfo: { ...SERVER_INFO },
        }),
      };
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = (SUPPORTED_VERSIONS as readonly string[]).includes(requested) ? requested : '2025-11-25';
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { ...SERVER_INFO },
        }),
      };
    }
    case 'ping':
      return { status: 200, body: rpcResult(id, {}) };
    case 'tools/list':
      return { status: 200, body: rpcResult(id, TOOLS_LIST_RESULT) };
    case 'tools/call': {
      const outcome = callTool(params);
      if ('error' in outcome) return { status: 200, body: rpcError(id, outcome.error.code, outcome.error.message) };
      return { status: 200, body: rpcResult(id, outcome) };
    }
    default:
      return { status: 200, body: rpcError(id, -32601, `method not found: ${method}`) };
  }
}

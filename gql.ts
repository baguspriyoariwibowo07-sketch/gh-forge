// GitHub GraphQL v4 for the documents gh and github-mcp-server send: a small parser and a
// resolver executor over the same store as REST and git. Global ids are opaque, stable
// base64 encodings of (kind, repo id, number) so node(id:) round-trips and an id never
// equals the plain database id or issue number.

import {
  VIEWER,
  findRepo,
  repoById,
  allRepos,
  branchRef,
  pullConflicts,
  type RepoRec,
  type IssueRec,
  type PullRec,
} from './store.ts';
import { createIssue, createPull, mergePull, pullChanges } from './rest.ts';

// ------------------------------------------------------------------ global ids

export function globalId(kind: string, ...parts: readonly (string | number)[]): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): string[] {
  try {
    return Buffer.from(id, 'base64').toString('utf8').split(':');
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ tokenizer

type Token =
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'punct'; readonly value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:=!$@|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          const esc = source[i + 1] as string;
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' };
          if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16));
            i += 6;
          } else {
            value += map[esc] ?? esc;
            i += 2;
          }
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i));
      if (!match) throw new Error(`bad number at ${i}`);
      const text = match[0];
      tokens.push(text.includes('.') || /[eE]/.test(text) ? { kind: 'float', value: Number(text) } : { kind: 'int', value: parseInt(text, 10) });
      i += text.length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i));
      const text = (match as RegExpExecArray)[0];
      tokens.push({ kind: 'name', value: text });
      i += text.length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

// ------------------------------------------------------------------ AST + parser

export type GqlValue =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'list'; readonly values: readonly GqlValue[] }
  | { readonly kind: 'object'; readonly fields: ReadonlyMap<string, GqlValue> };

export interface FieldNode {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: ReadonlyMap<string, GqlValue>;
  readonly selectionSet: readonly SelectionNode[] | null;
}

export type SelectionNode =
  | FieldNode
  | { readonly kind: 'inline'; readonly typeCondition: string | null; readonly selectionSet: readonly SelectionNode[] }
  | { readonly kind: 'spread'; readonly name: string };

interface OperationNode {
  readonly type: 'query' | 'mutation';
  readonly name: string | null;
  readonly selectionSet: readonly SelectionNode[];
}

interface FragmentNode {
  readonly typeCondition: string;
  readonly selectionSet: readonly SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: readonly Token[];
  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.pos < this.tokens.length) {
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected an operation');
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | null = null;
        const ahead = this.peek();
        if (ahead && ahead.kind === 'name') name = this.expectName();
        if (this.atPunct('(')) this.skipVariableDefinitions();
        // Directives on the operation are skipped.
        while (this.atPunct('@')) {
          this.next();
          this.expectName();
          if (this.atPunct('(')) this.parseArguments();
        }
        operations.push({ type: token.value === 'mutation' ? 'mutation' : 'query', name, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const onToken = this.next();
        if (onToken.kind !== 'name' || onToken.value !== 'on') throw new Error('expected "on" in fragment');
        const typeCondition = this.expectName();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected definition ${token.value}`);
    }
    return { operations, fragments };
  }

  private skipVariableDefinitions(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      else if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      if (this.atPunct('...')) {
        this.next();
        const ahead = this.peek();
        if (ahead && ahead.kind === 'name' && ahead.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        } else if (ahead && ahead.kind === 'name') {
          selections.push({ kind: 'spread', name: this.expectName() });
        } else {
          selections.push({ kind: 'inline', typeCondition: null, selectionSet: this.parseSelectionSet() });
        }
        continue;
      }
      let name = this.expectName();
      let alias: string | null = null;
      if (this.atPunct(':')) {
        this.next();
        alias = name;
        name = this.expectName();
      }
      const args = this.atPunct('(') ? this.parseArguments() : new Map<string, GqlValue>();
      while (this.atPunct('@')) {
        this.next();
        this.expectName();
        if (this.atPunct('(')) this.parseArguments();
      }
      const selectionSet = this.atPunct('{') ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', alias, name, args, selectionSet });
    }
    this.expectPunct('}');
    return selections;
  }

  private parseArguments(): Map<string, GqlValue> {
    this.expectPunct('(');
    const args = new Map<string, GqlValue>();
    while (!this.atPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.set(name, this.parseValue());
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: GqlValue[] = [];
      while (!this.atPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, GqlValue>();
      while (!this.atPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.set(name, this.parseValue());
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value token');
  }
}

/** Evaluate an argument value against the operation's variables. */
function evaluate(value: GqlValue, variables: Readonly<Record<string, unknown>>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.values.map((entry) => evaluate(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of value.fields) out[key] = evaluate(entry, variables);
      return out;
    }
  }
}

// ------------------------------------------------------------------ schema description

const OBJECT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'user', 'organization', 'search', 'rateLimit', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'reopenIssue'],
  User: ['id', 'login', 'name', 'email', 'url', 'databaseId', 'repositories', 'issues', 'pullRequests'],
  Organization: ['id', 'login', 'name', 'url', 'databaseId', 'repositories'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate',
    'url', 'createdAt', 'updatedAt', 'labels', 'stargazerCount', 'forkCount',
  ],
  Ref: ['name', 'prefix', 'target'],
  RefTarget: ['oid'],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'closed',
    'labels', 'comments', 'repository', 'author',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'files', 'url', 'createdAt', 'updatedAt', 'closed', 'mergedAt', 'mergeCommit',
    'repository', 'author', 'headRef', 'baseRef', 'comments', 'labels',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueComment: ['id', 'databaseId', 'body', 'createdAt', 'updatedAt', 'author', 'url'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  Label: ['id', 'name', 'color', 'description'],
  LabelConnection: ['nodes', 'totalCount'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  CreatedCommentEdge: ['node', 'cursor'],
  Node: ['id'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'interfaces', 'ofType'],
  __Field: ['name', 'description', 'type', 'isDeprecated'],
  __EnumValue: ['name', 'description', 'isDeprecated'],
  __Schema: ['types', 'queryType', 'mutationType'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  State: ['OPEN', 'CLOSED', 'MERGED'],
};

// ------------------------------------------------------------------ typed values

interface GqlObj {
  readonly __type: string;
  readonly [key: string]: unknown;
}

function obj(type: string, fields: Record<string, unknown>): GqlObj {
  return { __type: type, ...fields };
}

function userValue(): GqlObj {
  return obj('User', { login: VIEWER.login, id: globalId('User', VIEWER.id), name: VIEWER.name, email: VIEWER.email, databaseId: VIEWER.id });
}

function repoValue(repo: RepoRec): GqlObj {
  return obj('Repository', { repo });
}

function issueValue(repo: RepoRec, issue: IssueRec): GqlObj {
  return obj('Issue', { repo, issue });
}

function pullValue(repo: RepoRec, pull: PullRec): GqlObj {
  return obj('PullRequest', { repo, pull });
}

function repoOf(value: GqlObj): RepoRec {
  return value.repo as RepoRec;
}

// ------------------------------------------------------------------ execution

interface ExecContext {
  readonly variables: Readonly<Record<string, unknown>>;
  readonly fragments: ReadonlyMap<string, FragmentNode>;
  readonly errors: { message: string }[];
}

class FieldError extends Error {}

function argsOf(node: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of node.args) out[key] = evaluate(value, ctx.variables);
  return out;
}

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function resolveField(type: string, value: GqlObj, node: FieldNode, ctx: ExecContext): unknown {
  const args = argsOf(node, ctx);
  switch (type) {
    case 'Query': {
      if (node.name === 'viewer') return userValue();
      if (node.name === 'user') return userValue();
      if (node.name === 'repository') {
        const repo = findRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo ? repoValue(repo) : null;
      }
      if (node.name === 'node') return nodeById(String(args.id ?? ''));
      if (node.name === '__type') return typeValue(typeof args.name === 'string' ? args.name : '');
      if (node.name === '__schema') return obj('__Schema', {});
      throw new FieldError(`Field '${node.name}' doesn't exist on type 'Query'`);
    }
    case 'Mutation': {
      return resolveMutation(node.name, args);
    }
    case 'User':
    case 'Organization': {
      if (node.name in value) return value[node.name];
      if (node.name === 'id') return value.id;
      throw new FieldError(`Field '${node.name}' doesn't exist on type '${type}'`);
    }
    case 'Repository': {
      const repo = repoOf(value);
      switch (node.name) {
        case 'id': return globalId('Repository', repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return userValue();
        case 'description': return repo.description;
        case 'isPrivate': return repo.isPrivate;
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'defaultBranchRef': return obj('Ref', { name: repo.defaultBranch });
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue ? issueValue(repo, issue) : null;
        }
        case 'issues': return issuesConnection(repo, args);
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull ? pullValue(repo, pull) : null;
        }
        case 'pullRequests': return pullRequestsConnection(repo, args);
        default: throw new FieldError(`Field '${node.name}' doesn't exist on type 'Repository'`);
      }
    }
    case 'Ref': {
      if (node.name === 'name') return value.name;
      if (node.name === 'prefix') return 'refs/heads/';
      throw new FieldError(`Field '${node.name}' doesn't exist on type 'Ref'`);
    }
    case 'Issue': {
      const repo = value.repo as RepoRec;
      const issue = value.issue as IssueRec;
      switch (node.name) {
        case 'id': return globalId('Issue', repo.id, issue.number);
        case 'databaseId': return repo.id * 1_000_000 + issue.number;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'closed': return issue.state === 'closed';
        case 'repository': return repoValue(repo);
        case 'author': return userValue();
        case 'labels':
          return obj('LabelConnection', {
            nodes: issue.labels.map((name) => obj('Label', { id: globalId('Label', repo.id, name), name, color: repo.labels.get(name)?.color ?? 'ededed', description: repo.labels.get(name)?.description ?? '' })),
          });
        case 'comments':
          return obj('IssueCommentConnection', {
            nodes: issue.comments.map((comment) => commentValue(repo, issue, comment.id, comment.body)),
            pageInfo: obj('PageInfo', { hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null }),
          });
        case 'url': return `https://forge.local/${repo.owner}/${repo.name}/issues/${issue.number}`;
        case 'createdAt': return '2026-11-17T00:00:00Z';
        case 'updatedAt': return '2026-11-17T00:00:00Z';
        default: throw new FieldError(`Field '${node.name}' doesn't exist on type 'Issue'`);
      }
    }
    case 'PullRequest': {
      const repo = value.repo as RepoRec;
      const pull = value.pull as PullRec;
      switch (node.name) {
        case 'id': return globalId('PullRequest', repo.id, pull.number);
        case 'databaseId': return repo.id * 1_000_000 + pull.number;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged': return pull.merged;
        case 'mergedAt': return pull.mergedAt;
        case 'closed': return pull.state === 'closed';
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'mergeable': return pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
        case 'mergeCommit': return pull.mergeSha ? obj('RefTarget', { oid: pull.mergeSha }) : null;
        case 'repository': return repoValue(repo);
        case 'author': return userValue();
        case 'files': {
          const first = typeof args.first === 'number' ? args.first : 100;
          const changes = pullChanges(repo, pull).slice(0, first);
          return obj('PullRequestChangedFileConnection', {
            nodes: changes.map((change) =>
              obj('PullRequestChangedFile', { path: change.filename, additions: change.additions, deletions: change.deletions, changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'DELETED' : 'MODIFIED' }),
            ),
          });
        }
        case 'url': return `https://forge.local/${repo.owner}/${repo.name}/pull/${pull.number}`;
        case 'createdAt': return '2026-11-17T00:00:00Z';
        case 'updatedAt': return '2026-11-17T00:00:00Z';
        default: throw new FieldError(`Field '${node.name}' doesn't exist on type 'PullRequest'`);
      }
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
    case 'IssueCommentConnection':
    case 'LabelConnection': {
      if (node.name === 'nodes') return value.nodes;
      if (node.name === 'pageInfo') return value.pageInfo;
      if (node.name === 'totalCount') return (value.nodes as unknown[]).length;
      if (node.name === 'edges') {
        const nodes = value.nodes as GqlObj[];
        return nodes.map((entry) => obj('IssueEdge', { node: entry, cursor: '' }));
      }
      throw new FieldError(`Field '${node.name}' doesn't exist on type '${type}'`);
    }
    case 'PageInfo': {
      if (node.name in value) return value[node.name];
      throw new FieldError(`Field '${node.name}' doesn't exist on type 'PageInfo'`);
    }
    case 'PullRequestChangedFile': {
      if (node.name in value) return value[node.name];
      throw new FieldError(`Field '${node.name}' doesn't exist on type 'PullRequestChangedFile'`);
    }
    case 'IssueComment': {
      if (node.name in value) return value[node.name];
      throw new FieldError(`Field '${node.name}' doesn't exist on type 'IssueComment'`);
    }
    case 'Label': {
      if (node.name in value) return value[node.name];
      throw new FieldError(`Field '${node.name}' doesn't exist on type 'Label'`);
    }
    case '__Type': {
      if (node.name === 'name') return value.name;
      if (node.name === 'kind') return value.kind;
      if (node.name === 'fields') {
        const fields = OBJECT_FIELDS[value.name as string];
        return fields ? fields.map((name) => obj('__Field', { name })) : null;
      }
      if (node.name === 'enumValues') {
        const values = ENUM_VALUES[value.name as string];
        return values ? values.map((name) => obj('__EnumValue', { name })) : null;
      }
      if (node.name === 'possibleTypes' || node.name === 'interfaces' || node.name === 'inputFields') return [];
      if (node.name === 'description') return null;
      if (node.name === 'ofType') return null;
      throw new FieldError(`Field '${node.name}' doesn't exist on type '__Type'`);
    }
    case '__Field':
    case '__EnumValue': {
      if (node.name === 'name') return value.name;
      if (node.name === 'description') return null;
      if (node.name === 'isDeprecated') return false;
      if (node.name === 'type') return obj('__Type', { name: 'String', kind: 'SCALAR' });
      throw new FieldError(`Field '${node.name}' doesn't exist on type '${type}'`);
    }
    case '__Schema': {
      if (node.name === 'queryType') return typeValue('Query');
      if (node.name === 'mutationType') return typeValue('Mutation');
      if (node.name === 'types') return [...Object.keys(OBJECT_FIELDS), ...Object.keys(ENUM_VALUES)].map((name) => typeValue(name));
      throw new FieldError(`Field '${node.name}' doesn't exist on type '__Schema'`);
    }
    default: {
      if (node.name in value) return value[node.name];
      throw new FieldError(`Field '${node.name}' doesn't exist on type '${type}'`);
    }
  }
}

function typeValue(name: string): GqlObj | null {
  if (name in OBJECT_FIELDS) return obj('__Type', { name, kind: name === 'Node' ? 'INTERFACE' : 'OBJECT' });
  if (name in ENUM_VALUES) return obj('__Type', { name, kind: 'ENUM' });
  return null;
}

function nodeById(id: string): GqlObj | null {
  const parts = decodeGlobalId(id);
  const [kind, first, second] = parts;
  if (kind === 'Repository') {
    for (const repo of allRepos()) if (repo.id === Number(first)) return repoValue(repo);
    return null;
  }
  if (kind === 'Issue') {
    const repo = repoByDatabaseId(Number(first));
    const issue = repo?.issues.get(Number(second));
    return repo && issue ? issueValue(repo, issue) : null;
  }
  if (kind === 'PullRequest') {
    const repo = repoByDatabaseId(Number(first));
    const pull = repo?.pulls.get(Number(second));
    return repo && pull ? pullValue(repo, pull) : null;
  }
  if (kind === 'User') return userValue();
  return null;
}

function repoByDatabaseId(id: number): RepoRec | undefined {
  return repoById(id);
}

function commentValue(repo: RepoRec, issue: IssueRec, commentId: number, body: string): GqlObj {
  return obj('IssueComment', {
    id: globalId('IssueComment', repo.id, issue.number, commentId),
    databaseId: repo.id * 1_000_000 + commentId,
    body,
    author: userValue(),
    createdAt: '2026-11-17T00:00:00Z',
    updatedAt: '2026-11-17T00:00:00Z',
    url: `https://forge.local/${repo.owner}/${repo.name}/issues/${issue.number}`,
  });
}

function issuesConnection(repo: RepoRec, args: Record<string, unknown>): GqlObj {
  let issues = [...repo.issues.values()];
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
  if (states !== null) {
    issues = issues.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  const direction = orderBy?.direction === 'ASC' ? 'ASC' : 'DESC';
  issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : 100;
  let start = 0;
  const afterNumber = numberFromCursor(args.after);
  if (afterNumber !== null) {
    const index = issues.findIndex((issue) => issue.number === afterNumber);
    if (index >= 0) start = index + 1;
  }
  const page = issues.slice(start, start + first);
  const hasNextPage = start + first < issues.length;
  const endCursor = page.length > 0 ? cursorOf((page[page.length - 1] as IssueRec).number) : null;
  return obj('IssueConnection', {
    nodes: page.map((issue) => issueValue(repo, issue)),
    pageInfo: obj('PageInfo', { hasNextPage, hasPreviousPage: start > 0, endCursor, startCursor: page.length > 0 ? cursorOf(page[0]?.number ?? 0) : null }),
  });
}

function pullRequestsConnection(repo: RepoRec, args: Record<string, unknown>): GqlObj {
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : 100;
  const pulls = [...repo.pulls.values()].sort((a, b) => a.number - b.number).slice(0, first);
  return obj('PullRequestConnection', {
    nodes: pulls.map((pull) => pullValue(repo, pull)),
    pageInfo: obj('PageInfo', { hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null }),
  });
}

// ------------------------------------------------------------------ mutations

function repoFromGlobalId(id: unknown): RepoRec {
  const parts = decodeGlobalId(String(id ?? ''));
  if (parts[0] !== 'Repository') throw new FieldError('the repository id is not a repository');
  const repo = repoByDatabaseId(Number(parts[1]));
  if (!repo) throw new FieldError('the repository does not exist');
  return repo;
}

function resolveMutation(name: string, args: Record<string, unknown>): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'createIssue': {
      const repo = repoFromGlobalId(input.repositoryId);
      const result = createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      if (result.error || !result.issue) throw new FieldError('the issue could not be created');
      return obj('CreateIssuePayload', { issue: issueValue(repo, result.issue), clientMutationId: input.clientMutationId ?? null });
    }
    case 'closeIssue': {
      const parts = decodeGlobalId(String(input.issueId ?? ''));
      const repo = repoByDatabaseId(Number(parts[1]));
      const issue = repo?.issues.get(Number(parts[2]));
      if (!repo || !issue) throw new FieldError('the issue does not exist');
      issue.state = 'closed';
      return obj('CloseIssuePayload', { issue: issueValue(repo, issue), clientMutationId: input.clientMutationId ?? null });
    }
    case 'createPullRequest': {
      const repo = repoFromGlobalId(input.repositoryId);
      const result = createPull(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
      if (result.error || !result.pull) {
        const message = (result.error?.body as { message?: string } | undefined)?.message ?? 'the pull request could not be created';
        throw new FieldError(message);
      }
      return obj('CreatePullRequestPayload', { pullRequest: pullValue(repo, result.pull), clientMutationId: input.clientMutationId ?? null });
    }
    case 'mergePullRequest': {
      const parts = decodeGlobalId(String(input.pullRequestId ?? ''));
      const repo = repoByDatabaseId(Number(parts[1]));
      const pull = repo?.pulls.get(Number(parts[2]));
      if (!repo || !pull) throw new FieldError('the pull request does not exist');
      const result = mergePull(repo, pull);
      if (result.error) {
        const message = (result.error.body as { message?: string } | undefined)?.message ?? 'the pull request could not be merged';
        throw new FieldError(message);
      }
      return obj('MergePullRequestPayload', { pullRequest: pullValue(repo, pull), clientMutationId: input.clientMutationId ?? null });
    }
    case 'addComment': {
      const parts = decodeGlobalId(String(input.subjectId ?? ''));
      const repo = repoByDatabaseId(Number(parts[1]));
      const issue = repo?.issues.get(Number(parts[2]));
      if (!repo || !issue) throw new FieldError('the comment subject does not exist');
      const body = String(input.body ?? '');
      const comment = { id: repo.nextComment, body };
      repo.nextComment += 1;
      issue.comments.push(comment);
      return obj('AddCommentPayload', {
        commentEdge: obj('CreatedCommentEdge', { node: commentValue(repo, issue, comment.id, body), cursor: cursorOf(comment.id) }),
        subject: issueValue(repo, issue),
        clientMutationId: input.clientMutationId ?? null,
      });
    }
    default:
      throw new FieldError(`Field '${name}' doesn't exist on type 'Mutation'`);
  }
}

// ------------------------------------------------------------------ selection execution

function executeSelections(type: string, value: GqlObj, selections: readonly SelectionNode[], ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline' || selection.kind === 'spread') {
      const fragment = selection.kind === 'inline' ? selection : ctx.fragments.get(selection.name);
      if (!fragment) continue;
      const condition = selection.kind === 'inline' ? selection.typeCondition : fragment.typeCondition;
      if (condition !== null && condition !== type && condition !== 'Node') continue;
      Object.assign(out, executeSelections(type, value, fragment.selectionSet, ctx));
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = type;
      continue;
    }
    let raw: unknown;
    try {
      raw = resolveField(type, value, selection, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(raw, selection, ctx);
  }
  return out;
}

function completeValue(raw: unknown, node: FieldNode, ctx: ExecContext): unknown {
  if (raw === null || raw === undefined) return null;
  if (node.selectionSet === null) return raw;
  if (Array.isArray(raw)) return raw.map((entry) => completeValue(entry, node, ctx));
  if (typeof raw === 'object' && '__type' in (raw as Record<string, unknown>)) {
    const typed = raw as GqlObj;
    return executeSelections(typed.__type, typed, node.selectionSet, ctx);
  }
  return raw;
}

// ------------------------------------------------------------------ entry point

export interface GraphQLHttpResult {
  readonly status: number;
  readonly body: unknown;
}

/** Execute one GraphQL HTTP body (a single operation or a batch array). */
export function executeGraphQL(body: unknown): GraphQLHttpResult {
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => executeOne(entry)) };
  }
  return { status: 200, body: executeOne(body) };
}

function executeOne(entry: unknown): Record<string, unknown> {
  const record = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query : '';
  const variables = (typeof record.variables === 'object' && record.variables !== null ? record.variables : {}) as Record<string, unknown>;
  const operationName = typeof record.operationName === 'string' ? record.operationName : null;
  let document: { operations: OperationNode[]; fragments: Map<string, FragmentNode> };
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'the document did not parse' }] };
  }
  const operation = document.operations.find((candidate) => operationName === null || candidate.name === operationName) ?? document.operations[0];
  if (!operation) return { errors: [{ message: 'no operation in the document' }] };
  const ctx: ExecContext = { variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(rootType, obj(rootType, {}), operation.selectionSet, ctx);
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}

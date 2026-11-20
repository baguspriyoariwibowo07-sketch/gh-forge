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

/** Directive name → its arguments, as written on a selection or definition. */
export type DirectiveMap = ReadonlyMap<string, ReadonlyMap<string, GqlValue>>;

export interface FieldNode {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: ReadonlyMap<string, GqlValue>;
  readonly directives: DirectiveMap;
  readonly selectionSet: readonly SelectionNode[] | null;
}

export type SelectionNode =
  | FieldNode
  | { readonly kind: 'inline'; readonly typeCondition: string | null; readonly directives: DirectiveMap; readonly selectionSet: readonly SelectionNode[] }
  | { readonly kind: 'spread'; readonly name: string; readonly directives: DirectiveMap };

interface OperationNode {
  readonly type: 'query' | 'mutation';
  readonly name: string | null;
  /** Variable name → its default value AST (null when the definition has no default). */
  readonly variableDefaults: ReadonlyMap<string, GqlValue | null>;
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
        operations.push({ type: 'query', name: null, variableDefaults: new Map(), selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected an operation');
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | null = null;
        const ahead = this.peek();
        if (ahead && ahead.kind === 'name') name = this.expectName();
        const variableDefaults = this.atPunct('(') ? this.parseVariableDefinitions() : new Map<string, GqlValue | null>();
        // Directives on the operation are parsed and ignored.
        this.parseDirectives();
        operations.push({ type: token.value === 'mutation' ? 'mutation' : 'query', name, variableDefaults, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const onToken = this.next();
        if (onToken.kind !== 'name' || onToken.value !== 'on') throw new Error('expected "on" in fragment');
        const typeCondition = this.expectName();
        this.parseDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected definition ${token.value}`);
    }
    return { operations, fragments };
  }

  /** Parse `($name: Type = default @directive, …)`, keeping each variable's default. */
  private parseVariableDefinitions(): Map<string, GqlValue | null> {
    const defs = new Map<string, GqlValue | null>();
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.skipType();
      let fallback: GqlValue | null = null;
      if (this.atPunct('=')) {
        this.next();
        fallback = this.parseValue();
      }
      this.parseDirectives();
      defs.set(name, fallback);
    }
    this.expectPunct(')');
    return defs;
  }

  private skipType(): void {
    if (this.atPunct('[')) {
      this.next();
      this.skipType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.atPunct('!')) this.next();
  }

  /** Parse a run of `@name(args)` directives, keeping their arguments. */
  private parseDirectives(): DirectiveMap {
    const directives = new Map<string, ReadonlyMap<string, GqlValue>>();
    while (this.atPunct('@')) {
      this.next();
      const name = this.expectName();
      const args = this.atPunct('(') ? this.parseArguments() : new Map<string, GqlValue>();
      directives.set(name, args);
    }
    return directives;
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
          const directives = this.parseDirectives();
          selections.push({ kind: 'inline', typeCondition, directives, selectionSet: this.parseSelectionSet() });
        } else if (ahead && ahead.kind === 'name') {
          const spreadName = this.expectName();
          const directives = this.parseDirectives();
          selections.push({ kind: 'spread', name: spreadName, directives });
        } else {
          const directives = this.parseDirectives();
          selections.push({ kind: 'inline', typeCondition: null, directives, selectionSet: this.parseSelectionSet() });
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
      const directives = this.parseDirectives();
      const selectionSet = this.atPunct('{') ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', alias, name, args, directives, selectionSet });
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
  UpdateIssuePayload: ['issue', 'clientMutationId'],
  ReopenIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  CreatedCommentEdge: ['node', 'cursor'],
  RepositoryConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  RepositoryEdge: ['node', 'cursor'],
  SearchResultItemConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  SearchResultItemEdge: ['node', 'cursor'],
  IssueCommentEdge: ['node', 'cursor'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  RateLimit: ['limit', 'cost', 'remaining', 'resetAt', 'nodeCount'],
  Node: ['id'],
  __Type: ['name', 'kind', 'description', 'specifiedByURL', 'isOneOf', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'interfaces', 'ofType'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Directive: ['name', 'description', 'locations', 'args', 'isRepeatable'],
  __Schema: ['description', 'types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
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

const EDGE_TYPE_OF: Readonly<Record<string, string>> = {
  IssueConnection: 'IssueEdge',
  PullRequestConnection: 'PullRequestEdge',
  PullRequestChangedFileConnection: 'PullRequestChangedFileEdge',
  IssueCommentConnection: 'IssueCommentEdge',
  RepositoryConnection: 'RepositoryEdge',
  SearchResultItemConnection: 'SearchResultItemEdge',
};

function pageInfoOf(hasNextPage: boolean, hasPreviousPage: boolean, startCursor: string | null, endCursor: string | null): GqlObj {
  return obj('PageInfo', { hasNextPage, hasPreviousPage, startCursor, endCursor });
}

/** Slice `items` into a connection object carrying a true total and real cursors. */
function connectionOf(
  type: string,
  items: readonly GqlObj[],
  cursorKey: (item: GqlObj, index: number) => number,
  args: Record<string, unknown>,
): GqlObj {
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : 100;
  const page = items.slice(0, first);
  const cursors = page.map((item, index) => cursorOf(cursorKey(item, index)));
  return obj(type, {
    nodes: page,
    total: items.length,
    cursors,
    pageInfo: pageInfoOf(items.length > page.length, false, cursors[0] ?? null, cursors[cursors.length - 1] ?? null),
  });
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
      if (node.name === 'nodes') {
        const ids = Array.isArray(args.ids) ? args.ids : [];
        return ids.map((id) => nodeById(String(id)));
      }
      if (node.name === 'organization') {
        if (String(args.login ?? '') !== VIEWER.login) return null;
        return obj('Organization', {
          login: VIEWER.login,
          id: globalId('Organization', VIEWER.id),
          name: VIEWER.name,
          email: VIEWER.email,
          databaseId: VIEWER.id,
        });
      }
      if (node.name === 'search') return searchConnection(args);
      if (node.name === 'rateLimit') {
        return obj('RateLimit', { limit: 5000, cost: 1, remaining: 5000, resetAt: '2026-11-17T01:00:00Z', nodeCount: 0 });
      }
      if (node.name === '__type') return typeValue(typeof args.name === 'string' ? args.name : '');
      if (node.name === '__schema') return obj('__Schema', {});
      throw new FieldError(`Field '${node.name}' doesn't exist on type 'Query'`);
    }
    case 'Mutation': {
      return resolveMutation(node.name, args);
    }
    case 'User':
    case 'Organization': {
      if (node.name === 'url') return `https://forge.local/${String(value.login)}`;
      if (node.name === 'repositories') {
        const repos = [...allRepos()].sort((a, b) => a.id - b.id).map((repo) => repoValue(repo));
        return connectionOf('RepositoryConnection', repos, (_item, index) => index + 1, args);
      }
      if (type === 'User' && node.name === 'issues') {
        const all: GqlObj[] = [];
        for (const repo of [...allRepos()].sort((a, b) => a.id - b.id)) {
          for (const issue of [...repo.issues.values()].sort((a, b) => a.number - b.number)) all.push(issueValue(repo, issue));
        }
        return connectionOf('IssueConnection', all, (_item, index) => index + 1, args);
      }
      if (type === 'User' && node.name === 'pullRequests') {
        const all: GqlObj[] = [];
        for (const repo of [...allRepos()].sort((a, b) => a.id - b.id)) {
          for (const pull of [...repo.pulls.values()].sort((a, b) => a.number - b.number)) all.push(pullValue(repo, pull));
        }
        return connectionOf('PullRequestConnection', all, (_item, index) => index + 1, args);
      }
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
        case 'url': return `https://forge.local/${repo.owner}/${repo.name}`;
        case 'createdAt': return '2026-11-17T00:00:00Z';
        case 'updatedAt': return '2026-11-17T00:00:00Z';
        case 'stargazerCount': return 0;
        case 'forkCount': return 0;
        case 'labels': {
          const labels = [...repo.labels.entries()].map(([name, label]) =>
            obj('Label', { id: globalId('Label', repo.id, name), name, color: label.color, description: label.description }),
          );
          return obj('LabelConnection', { nodes: labels, total: labels.length, cursors: labels.map((_label, index) => cursorOf(index + 1)) });
        }
        case 'defaultBranchRef': return obj('Ref', { name: repo.defaultBranch, repo });
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
      if (node.name === 'target') {
        const repo = value.repo as RepoRec | undefined;
        const oid = repo?.refs.get(branchRef(String(value.name)));
        return oid ? obj('RefTarget', { oid }) : null;
      }
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
            total: issue.labels.length,
            cursors: issue.labels.map((_name, index) => cursorOf(index + 1)),
          });
        case 'comments':
          return obj('IssueCommentConnection', {
            nodes: issue.comments.map((comment) => commentValue(repo, issue, comment.id, comment.body)),
            total: issue.comments.length,
            cursors: issue.comments.map((comment) => cursorOf(comment.id)),
            pageInfo: pageInfoOf(false, false, null, null),
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
        case 'headRef': return obj('Ref', { name: pull.headRef, repo });
        case 'baseRef': return obj('Ref', { name: pull.baseRef, repo });
        case 'labels':
          return obj('LabelConnection', { nodes: [], total: 0, cursors: [] });
        case 'comments':
          return obj('IssueCommentConnection', { nodes: [], total: 0, cursors: [], pageInfo: pageInfoOf(false, false, null, null) });
        case 'files': {
          const changes = pullChanges(repo, pull).map((change) =>
            obj('PullRequestChangedFile', { path: change.filename, additions: change.additions, deletions: change.deletions, changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'DELETED' : 'MODIFIED' }),
          );
          return connectionOf('PullRequestChangedFileConnection', changes, (_item, index) => index + 1, args);
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
    case 'LabelConnection':
    case 'RepositoryConnection':
    case 'SearchResultItemConnection': {
      if (node.name === 'nodes') return value.nodes;
      if (node.name === 'pageInfo') return value.pageInfo;
      if (node.name === 'totalCount') {
        return typeof value.total === 'number' ? value.total : (value.nodes as unknown[]).length;
      }
      if (node.name === 'edges') {
        const nodes = value.nodes as GqlObj[];
        const cursors = (value.cursors as (string | null)[] | undefined) ?? [];
        return nodes.map((entry, index) => obj(EDGE_TYPE_OF[type] ?? 'IssueEdge', { node: entry, cursor: cursors[index] ?? cursorOf(index + 1) }));
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
      if (node.name === 'specifiedByURL') return null;
      if (node.name === 'isOneOf') return false;
      if (node.name === 'ofType') return null;
      throw new FieldError(`Field '${node.name}' doesn't exist on type '__Type'`);
    }
    case '__Field':
    case '__EnumValue': {
      if (node.name === 'name') return value.name;
      if (node.name === 'description') return null;
      if (node.name === 'isDeprecated') return false;
      if (node.name === 'deprecationReason') return null;
      if (node.name === 'args') return [];
      if (node.name === 'type') return obj('__Type', { name: 'String', kind: 'SCALAR' });
      throw new FieldError(`Field '${node.name}' doesn't exist on type '${type}'`);
    }
    case '__Schema': {
      if (node.name === 'description') return null;
      if (node.name === 'queryType') return typeValue('Query');
      if (node.name === 'mutationType') return typeValue('Mutation');
      if (node.name === 'subscriptionType') return null;
      if (node.name === 'directives') return DIRECTIVES;
      if (node.name === 'types') return [...Object.keys(OBJECT_FIELDS), ...Object.keys(ENUM_VALUES)].map((name) => typeValue(name));
      throw new FieldError(`Field '${node.name}' doesn't exist on type '__Schema'`);
    }
    default: {
      if (node.name in value) return value[node.name];
      throw new FieldError(`Field '${node.name}' doesn't exist on type '${type}'`);
    }
  }
}

/** The directives this executor honours, as served by `__Schema.directives`. */
const DIRECTIVES: readonly GqlObj[] = [
  obj('__Directive', { name: 'include', description: null, locations: ['FIELD_DEFINITION', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'], args: [], isRepeatable: false }),
  obj('__Directive', { name: 'skip', description: null, locations: ['FIELD_DEFINITION', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'], args: [], isRepeatable: false }),
  obj('__Directive', { name: 'deprecated', description: null, locations: ['FIELD_DEFINITION', 'ARGUMENT_DEFINITION', 'ENUM_VALUE'], args: [], isRepeatable: false }),
  obj('__Directive', { name: 'specifiedBy', description: null, locations: ['SCALAR'], args: [], isRepeatable: false }),
];

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
    total: issues.length,
    cursors: page.map((issue) => cursorOf(issue.number)),
    pageInfo: pageInfoOf(hasNextPage, start > 0, page.length > 0 ? cursorOf(page[0]?.number ?? 0) : null, endCursor),
  });
}

function pullRequestsConnection(repo: RepoRec, args: Record<string, unknown>): GqlObj {
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : 100;
  const all = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
  let start = 0;
  const afterNumber = numberFromCursor(args.after);
  if (afterNumber !== null) {
    const index = all.findIndex((pull) => pull.number === afterNumber);
    if (index >= 0) start = index + 1;
  }
  const page = all.slice(start, start + first);
  return obj('PullRequestConnection', {
    nodes: page.map((pull) => pullValue(repo, pull)),
    total: all.length,
    cursors: page.map((pull) => cursorOf(pull.number)),
    pageInfo: pageInfoOf(
      start + first < all.length,
      start > 0,
      page.length > 0 ? cursorOf(page[0]?.number ?? 0) : null,
      page.length > 0 ? cursorOf((page[page.length - 1] as PullRec).number) : null,
    ),
  });
}

/** Substring search over the forge's issues, pull requests, or repositories. */
function searchConnection(args: Record<string, unknown>): GqlObj {
  const needle = String(args.query ?? '').toLowerCase();
  const type = String(args.type ?? 'ISSUE');
  const items: GqlObj[] = [];
  const repos = [...allRepos()].sort((a, b) => a.id - b.id);
  if (type === 'ISSUE') {
    for (const repo of repos) {
      for (const issue of [...repo.issues.values()].sort((a, b) => a.number - b.number)) {
        if (`${issue.title} ${issue.body}`.toLowerCase().includes(needle)) items.push(issueValue(repo, issue));
      }
    }
  } else if (type === 'PULL_REQUEST') {
    for (const repo of repos) {
      for (const pull of [...repo.pulls.values()].sort((a, b) => a.number - b.number)) {
        if (`${pull.title} ${pull.body}`.toLowerCase().includes(needle)) items.push(pullValue(repo, pull));
      }
    }
  } else if (type === 'REPOSITORY') {
    for (const repo of repos) {
      if (`${repo.name} ${repo.description}`.toLowerCase().includes(needle)) items.push(repoValue(repo));
    }
  }
  return connectionOf('SearchResultItemConnection', items, (_item, index) => index + 1, args);
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
    case 'updateIssue': {
      // GitHub's current shape names the id field `id`; accept `issueId` too.
      const parts = decodeGlobalId(String(input.id ?? input.issueId ?? ''));
      const repo = repoByDatabaseId(Number(parts[1]));
      const issue = repo?.issues.get(Number(parts[2]));
      if (!repo || !issue) throw new FieldError('the issue does not exist');
      if (typeof input.title === 'string') issue.title = input.title;
      if (typeof input.body === 'string') issue.body = input.body;
      if (typeof input.state === 'string') issue.state = input.state === 'CLOSED' ? 'closed' : 'open';
      return obj('UpdateIssuePayload', { issue: issueValue(repo, issue), clientMutationId: input.clientMutationId ?? null });
    }
    case 'reopenIssue': {
      const parts = decodeGlobalId(String(input.issueId ?? input.id ?? ''));
      const repo = repoByDatabaseId(Number(parts[1]));
      const issue = repo?.issues.get(Number(parts[2]));
      if (!repo || !issue) throw new FieldError('the issue does not exist');
      issue.state = 'open';
      return obj('ReopenIssuePayload', { issue: issueValue(repo, issue), clientMutationId: input.clientMutationId ?? null });
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

/** True when @skip/@include on a selection remove it for these variables. */
function directiveSkips(directives: DirectiveMap, ctx: ExecContext): boolean {
  const skip = directives.get('skip');
  if (skip) {
    const condition = skip.get('if');
    if (condition && evaluate(condition, ctx.variables) === true) return true;
  }
  const include = directives.get('include');
  if (include) {
    const condition = include.get('if');
    if (condition && evaluate(condition, ctx.variables) === false) return true;
  }
  return false;
}

function executeSelections(type: string, value: GqlObj, selections: readonly SelectionNode[], ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline' || selection.kind === 'spread') {
      if (directiveSkips(selection.directives, ctx)) continue;
      const fragment = selection.kind === 'inline' ? selection : ctx.fragments.get(selection.name);
      if (!fragment) continue;
      const condition = selection.kind === 'inline' ? selection.typeCondition : fragment.typeCondition;
      if (condition !== null && condition !== type && condition !== 'Node') continue;
      Object.assign(out, executeSelections(type, value, fragment.selectionSet, ctx));
      continue;
    }
    if (directiveSkips(selection.directives, ctx)) continue;
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
  let operation: OperationNode | undefined;
  if (operationName !== null) {
    operation = document.operations.find((candidate) => candidate.name === operationName);
    if (!operation) return { errors: [{ message: `Unknown operation named "${operationName}"` }] };
  } else {
    operation = document.operations[0];
  }
  if (!operation) return { errors: [{ message: 'no operation in the document' }] };
  // Variable defaults from the operation definition sit under the caller's values.
  const mergedVariables: Record<string, unknown> = {};
  for (const [name, fallback] of operation.variableDefaults) {
    if (fallback !== null) mergedVariables[name] = evaluate(fallback, mergedVariables);
  }
  for (const [name, value] of Object.entries(variables)) mergedVariables[name] = value;
  const ctx: ExecContext = { variables: mergedVariables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(rootType, obj(rootType, {}), operation.selectionSet, ctx);
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}
